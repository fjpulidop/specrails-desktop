import { Router, Request, Response } from 'express'
import type { ProjectContext } from './project-registry'
import { getRails, getRail, setRailTickets, setRailProfile, setRailEngine, setRailName, createRail, deleteRail, railCount, railExists, MAX_RAILS, type RailState } from './rails-store'
import { ClaudeNotFoundError, CodexNotFoundError } from './queue-manager'
import { validateRequestedProvider } from './provider-selection'
import { isLoopsEnabled, isCodeExplorerEnabled } from './feature-flags'
import { snapshotWorkingTree, type WorkingTreeSnapshot } from './file-provenance'
import { recordLoopRunProvenance } from './file-story'
import { getLoop } from './loops-store'
import { getLoopRun, getRunEventCounts, listActiveLoopRuns } from './loop-runs-store'
import { getAdapter } from './providers'
import { isValidModelForProvider, getModelsForProvider, type SpecProvider } from './spec-models'
import { resolveProjectExecution } from './workspace-resolution'
import { isFactoryLoopId, factoryLoopMode, getFactoryLoop, factoryLoopForMode } from './loop-factory'
import { loadConstantMap } from './loop-constants'
import { dominantTicketScope, referencesClaudeOnlyCommand } from './loop-command-catalog'
import { loopNeedsTicket, type LoopGraph } from './loop-graph'
import { isolationApplies, isRailPrDeliveryEnabled } from './rail-isolation'
import {
  getActivePrDeliveryByRail,
  getPrDelivery,
  listActivePrDeliveries,
  reconcileFailedBuildingPrDeliveries,
  toPrDecisionCardEnvelope,
  toPrDeliverySnapshot,
  toRailPrStateMessage,
  transitionDecision,
  type PrDeliverySnapshot,
} from './rail-pr-store'
import { classifyLoopEffect } from './loop-effect'
import { executePrDecision, isPrDecisionAction } from './rail-pr-decision'
import { launchIsolatedRail } from './rail-isolated-launch'
import { repoIsolationStatus, defaultGitRunner, commitWorktreeAndVerify } from './worktree-manager'
import { releaseRailWorktrees } from './rail-worktree-release'
import { checkoutProjectReviewBranch, getProjectGitInfo } from './project-git'
import { defaultExec, pushBranch } from './pr-publisher'
import { newId } from './ids'
import { getAgentChatManager } from './agent-chat-registry'
import type { ReasoningEffort } from './providers/types'
import type { RailJobStartedMessage, RailJobStoppedMessage, RailUpdatedMessage, RailRemovedMessage, LoopRunStoppedMessage } from './types'

// Extend Express Request to carry resolved ProjectContext (declared in project-router)
declare module 'express-serve-static-core' {
  interface Request {
    projectCtx?: ProjectContext
  }
}

const VALID_MODES = new Set(['implement', 'batch-implement', 'freestyle', 'loop'])
// Models the freestyle picker exposes (Claude aliases). Mirrors the client
// RailModelSelector options and the project-router orchestrator-model allow-list.
const VALID_FREESTYLE_MODELS = new Set(['haiku', 'sonnet', 'opus', 'fable'])
// Reasoning-effort tiers a loop launch may request (mirrors the client selector
// + the provider adapters' supported values).
const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high'])

function prDeliveryContinuesTickets(delivery: PrDeliverySnapshot, ticketIds: number[]): boolean {
  if (delivery.decision !== 'pr_draft' && delivery.decision !== 'pr_ready') return false
  if (!delivery.prUrl || !delivery.branch || delivery.prState !== 'pr-created') return false
  const covered = new Set(delivery.ticketIds)
  return ticketIds.length > 0 && ticketIds.every((id) => covered.has(id))
}

function emitPrDeliveryUpdate(c: ProjectContext, prDeliveryId: string): void {
  const row = getPrDelivery(c.db, prDeliveryId)
  if (!row) return
  const snap = toPrDeliverySnapshot(row)
  c.broadcast(toRailPrStateMessage(c.project.id, snap))
  if (row.origin_conversation_id) {
    getAgentChatManager()?.updatePrDecisionCard(
      row.origin_conversation_id,
      toPrDecisionCardEnvelope(c.project.id, snap),
    )
  }
}

function reconcileAndEmitFailedPrDeliveries(c: ProjectContext): void {
  for (const row of reconcileFailedBuildingPrDeliveries(c.db)) {
    emitPrDeliveryUpdate(c, row.id)
  }
}

export function createRailsRouter(): Router {
  const router = Router({ mergeParams: true })

  function ctx(req: Request): ProjectContext {
    return req.projectCtx!
  }

  // Broadcast the full post-mutation rail snapshot so every connected client
  // (desktop dashboard + mobile companion) reflects non-launch rail changes
  // live — ticket reassignments, renames, mode/profile/engine edits. Re-reads
  // the canonical rail (getRail) so the snapshot always carries the CURRENT
  // name — a mutation return value (e.g. setRailTickets) omits it, which would
  // otherwise broadcast name:null and clobber the rail's label on receivers.
  function broadcastRailUpdated(
    c: ProjectContext,
    railIndex: number,
    changed: RailUpdatedMessage['changed'],
  ): void {
    const rail: RailState = getRail(c.db, railIndex)
    const msg: RailUpdatedMessage = {
      type: 'rail.updated',
      projectId: c.project.id,
      railIndex: rail.railIndex,
      changed,
      ticketIds: rail.ticketIds,
      name: rail.name ?? null,
      mode: rail.mode,
      profileName: rail.profileName ?? null,
      aiEngine: rail.aiEngine ?? null,
    }
    c.broadcast(msg)
  }

  // GET /rails — list all rail assignments + active job info
  router.get('/', (_req: Request, res: Response) => {
    const c = ctx(_req)
    try {
      const rails = getRails(c.db)
      // Include which rails have active jobs (so clients can reconcile stale 'running' state)
      const activeJobs: Record<number, { jobId: string; mode: string }> = {}
      for (const [jobId, meta] of c.railJobs.entries()) {
        activeJobs[meta.railIndex] = { jobId, mode: meta.mode }
      }
      // Active loop runs (Loops mode) so clients can reconcile a 'running' rail
      // that's executing a loop rather than a queue job. Enriched from the
      // loop_runs row with the loop identity + resolved provider/model so a
      // mirror (e.g. the mobile companion) can label the run instead of showing a
      // stale `mode`/null engine — these never land on the rail row itself.
      const activeLoopRuns: Record<number, {
        loopRunId: string; loopId?: string; loopName?: string | null; provider?: string | null; model?: string | null; iteration?: number
        startedAt?: string; steps?: number; lines?: number
      }> = {}
      for (const [runId, meta] of c.railLoopRuns.entries()) {
        const run = getLoopRun(c.db, runId)
        // Seed counts so the dashboard's live metrics survive a page refresh.
        const counts = getRunEventCounts(c.db, runId)
        activeLoopRuns[meta.railIndex] = run
          ? { loopRunId: runId, loopId: run.loop_id, loopName: run.loop_name, provider: run.provider, model: run.model, iteration: run.iteration_count, startedAt: run.started_at, steps: counts.steps, lines: counts.lines }
          : { loopRunId: runId, steps: counts.steps, lines: counts.lines }
      }
      // Also surface DB 'running' runs not tracked in-memory (the rail map is
      // cleared on every server restart) — DB is the authoritative source, so the
      // dashboard metrics survive both a page refresh AND a server restart.
      for (const run of listActiveLoopRuns(c.db, c.project.id)) {
        if (run.rail_index == null || activeLoopRuns[run.rail_index]) continue
        const counts = getRunEventCounts(c.db, run.id)
        activeLoopRuns[run.rail_index] = { loopRunId: run.id, loopId: run.loop_id, loopName: run.loop_name, provider: run.provider, model: run.model, iteration: run.iteration_count, startedAt: run.started_at, steps: counts.steps, lines: counts.lines }
      }
      // Pending ask-first PR decisions (safe-pr-review-flow): the newest ACTIVE
      // (non-terminal) delivery per rail slot, so a refreshed client re-renders
      // the decision surface without waiting for a broadcast. The store lists
      // newest-first within each rail — keep the first per index.
      reconcileAndEmitFailedPrDeliveries(c)
      const prDeliveries: Record<number, PrDeliverySnapshot> = {}
      for (const row of listActivePrDeliveries(c.db)) {
        if (!(row.rail_index in prDeliveries)) prDeliveries[row.rail_index] = toPrDeliverySnapshot(row)
      }
      res.json({ rails, activeJobs, activeLoopRuns, prDeliveries })
    } catch (err) {
      console.error('[rails-router] get rails error:', err)
      res.status(500).json({ error: 'Failed to fetch rails' })
    }
  })

  // POST /rails — create a new rail slot (dynamic rails). Body: { name? }.
  // Allocates the lowest free index; capped at MAX_RAILS per project so the
  // railIndex-keyed maps (metrics, PR deliveries, worktree progress) stay
  // bounded. Broadcast rides the existing rail.updated shape (changed:'name')
  // so every client — including the mobile companion — adopts the new slot
  // without a new wire message.
  router.post('/', (req: Request, res: Response) => {
    const c = ctx(req)
    const body = req.body ?? {}
    const name = body.name
    if (name !== undefined && name !== null && typeof name !== 'string') {
      res.status(400).json({ error: 'name must be a string or null' }); return
    }
    if (typeof name === 'string' && name.length > 60) {
      res.status(400).json({ error: 'name must be 60 characters or fewer' }); return
    }
    try {
      if (railCount(c.db) >= MAX_RAILS) {
        res.status(400).json({ error: 'rail_limit_reached', maxRails: MAX_RAILS }); return
      }
      const rail = createRail(c.db, typeof name === 'string' ? name : null)
      broadcastRailUpdated(c, rail.railIndex, 'name')
      res.status(201).json({ rail })
    } catch (err) {
      console.error('[rails-router] create rail error:', err)
      res.status(500).json({ error: 'Failed to create rail' })
    }
  })

  // DELETE /rails/:railIndex — remove a rail slot. Guarded: the rail must
  // exist, hold no tickets, have no active job/loop run, no undecided PR
  // delivery, and must not be the last remaining rail. Indices are identity —
  // deleting a middle rail leaves a gap (never re-numbered).
  router.delete('/:railIndex', (req: Request, res: Response) => {
    const railIndex = parseInt(req.params.railIndex as string, 10)
    if (isNaN(railIndex) || railIndex < 0 || railIndex >= MAX_RAILS) {
      res.status(400).json({ error: 'Invalid rail index' }); return
    }
    const c = ctx(req)
    try {
      if (!railExists(c.db, railIndex)) {
        res.status(404).json({ error: 'Rail not found' }); return
      }
      if (railCount(c.db) <= 1) {
        res.status(400).json({ error: 'cannot_delete_last_rail' }); return
      }
      const hasActiveJob = Array.from(c.railJobs.values()).some((m) => m.railIndex === railIndex)
      const hasActiveRun = Array.from(c.railLoopRuns.values()).some((m) => m.railIndex === railIndex)
      if (hasActiveJob || hasActiveRun) {
        res.status(409).json({ error: 'rail_active' }); return
      }
      if (getRail(c.db, railIndex).ticketIds.length > 0) {
        res.status(409).json({ error: 'rail_not_empty' }); return
      }
      const pending = getActivePrDeliveryByRail(c.db, railIndex)
      if (pending) {
        res.status(409).json({ error: 'pr_decision_pending', prDeliveryId: pending.id }); return
      }
      deleteRail(c.db, railIndex)
      const msg: RailRemovedMessage = { type: 'rail.removed', projectId: c.project.id, railIndex }
      c.broadcast(msg)
      res.json({ ok: true, railIndex })
    } catch (err) {
      console.error('[rails-router] delete rail error:', err)
      res.status(500).json({ error: 'Failed to delete rail' })
    }
  })

  // PUT /rails/:railIndex/tickets — set ticket assignments for a rail
  router.put('/:railIndex/tickets', (req: Request, res: Response) => {
    const railIndex = parseInt(req.params.railIndex as string, 10)
    if (isNaN(railIndex) || railIndex < 0 || railIndex >= MAX_RAILS) {
      res.status(400).json({ error: 'Invalid rail index' }); return
    }

    const { ticketIds } = req.body ?? {}
    if (!Array.isArray(ticketIds) || ticketIds.some((id: unknown) => typeof id !== 'number')) {
      res.status(400).json({ error: 'ticketIds must be an array of numbers' }); return
    }

    const c = ctx(req)
    try {
      // setRailTickets does delete-then-reinsert; without forwarding the rail's
      // current mode/profileName they would reset to defaults ('implement' /
      // null) on every ticket reassignment, silently wiping a configured
      // per-rail profile. Preserve them (an explicit body value still wins).
      const current = getRail(c.db, railIndex)
      const body = req.body ?? {}
      const mode = typeof body.mode === 'string' ? body.mode : current.mode
      const profileName = 'profileName' in body ? body.profileName : current.profileName
      // Preserve the rail's AI engine across ticket reassignment (undefined →
      // setRailTickets re-reads the current value), so it isn't silently wiped.
      const aiEngine = 'aiEngine' in body ? body.aiEngine : undefined
      const rail = setRailTickets(c.db, railIndex, ticketIds as number[], mode, profileName, aiEngine)
      broadcastRailUpdated(c, railIndex, 'tickets')
      res.json({ rail })
    } catch (err) {
      console.error('[rails-router] set rail tickets error:', err)
      res.status(500).json({ error: 'Failed to update rail tickets' })
    }
  })

  // PUT /rails/:railIndex/profile — set the default agent profile for a rail
  // Body: { profileName: string | null } (null = force legacy mode for this rail)
  router.put('/:railIndex/profile', (req: Request, res: Response) => {
    const railIndex = parseInt(req.params.railIndex as string, 10)
    if (isNaN(railIndex) || railIndex < 0 || railIndex >= MAX_RAILS) {
      res.status(400).json({ error: 'Invalid rail index' }); return
    }
    const body = req.body ?? {}
    if (!('profileName' in body)) {
      res.status(400).json({ error: "body must include 'profileName' (string or null)" }); return
    }
    const value = body.profileName
    if (value !== null && typeof value !== 'string') {
      res.status(400).json({ error: 'profileName must be a string or null' }); return
    }
    const c = ctx(req)
    try {
      const rail = setRailProfile(c.db, railIndex, value)
      broadcastRailUpdated(c, railIndex, 'profile')
      res.json({ rail })
    } catch (err) {
      console.error('[rails-router] set rail profile error:', err)
      res.status(500).json({ error: 'Failed to update rail profile' })
    }
  })

  // PUT /rails/:railIndex/engine — set the AI engine override for a rail
  // Body: { aiEngine: string | null } (null = use the project's primary provider)
  router.put('/:railIndex/engine', (req: Request, res: Response) => {
    const railIndex = parseInt(req.params.railIndex as string, 10)
    if (isNaN(railIndex) || railIndex < 0 || railIndex >= MAX_RAILS) {
      res.status(400).json({ error: 'Invalid rail index' }); return
    }
    const body = req.body ?? {}
    if (!('aiEngine' in body)) {
      res.status(400).json({ error: "body must include 'aiEngine' (string or null)" }); return
    }
    const value = body.aiEngine
    const c = ctx(req)
    // null clears the override; a string must be one of the project's providers.
    if (value !== null) {
      const check = validateRequestedProvider(c.project, value)
      if (!check.ok) { res.status(400).json({ error: check.error }); return }
    }
    try {
      const rail = setRailEngine(c.db, railIndex, value)
      broadcastRailUpdated(c, railIndex, 'engine')
      res.json({ rail })
    } catch (err) {
      console.error('[rails-router] set rail engine error:', err)
      res.status(500).json({ error: 'Failed to update rail engine' })
    }
  })

  // PUT /rails/:railIndex/name — set the rail's display name (the "Rail "-suffix)
  // Body: { name: string | null } (empty/null clears it back to the default label)
  router.put('/:railIndex/name', (req: Request, res: Response) => {
    const railIndex = parseInt(req.params.railIndex as string, 10)
    if (isNaN(railIndex) || railIndex < 0 || railIndex >= MAX_RAILS) {
      res.status(400).json({ error: 'Invalid rail index' }); return
    }
    const body = req.body ?? {}
    if (!('name' in body)) {
      res.status(400).json({ error: "body must include 'name' (string or null)" }); return
    }
    const value = body.name
    if (value !== null && typeof value !== 'string') {
      res.status(400).json({ error: 'name must be a string or null' }); return
    }
    // Guard against unbounded labels (UI shows a short chip).
    if (typeof value === 'string' && value.length > 60) {
      res.status(400).json({ error: 'name must be 60 characters or fewer' }); return
    }
    const c = ctx(req)
    try {
      const rail = setRailName(c.db, railIndex, value)
      broadcastRailUpdated(c, railIndex, 'name')
      res.json({ rail })
    } catch (err) {
      console.error('[rails-router] set rail name error:', err)
      res.status(500).json({ error: 'Failed to update rail name' })
    }
  })

  // POST /rails/:railIndex/launch — launch job(s) for a rail
  router.post('/:railIndex/launch', async (req: Request, res: Response) => {
    const railIndex = parseInt(req.params.railIndex as string, 10)
    if (isNaN(railIndex) || railIndex < 0 || railIndex >= MAX_RAILS) {
      res.status(400).json({ error: 'Invalid rail index' }); return
    }

    let { mode = 'implement' } = req.body ?? {}
    const { profileName, aiEngine, model, loopId: rawLoopId, reasoning_effort, originConversationId, originSurface } = req.body ?? {}
    let loopId: unknown = rawLoopId
    // Origin link (safe-pr-review-flow): an agent-chat/MCP launch tags itself so
    // the PR decision can later be posted back into the launching conversation.
    // Both fields are optional; malformed values are rejected outright.
    if (originConversationId !== undefined && originConversationId !== null) {
      if (typeof originConversationId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(originConversationId)) {
        res.status(400).json({ error: 'originConversationId must be 1-64 chars of [A-Za-z0-9-]' }); return
      }
    }
    if (originSurface !== undefined && originSurface !== 'dashboard' && originSurface !== 'agent-chat') {
      res.status(400).json({ error: "originSurface must be 'dashboard' or 'agent-chat'" }); return
    }
    // rails-as-loops: a FACTORY loop id (`factory:implement` etc.) maps to its
    // legacy mode for validation/back-compat; the loop branch below still runs
    // it through the LoopRunManager. A CUSTOM loop id keeps mode='loop'.
    if (typeof loopId === 'string' && isFactoryLoopId(loopId)) {
      const fmode = factoryLoopMode(loopId)
      if (!fmode) { res.status(404).json({ error: 'Factory loop not found' }); return }
      mode = fmode
    }
    if (!VALID_MODES.has(mode as string)) {
      res.status(400).json({ error: 'mode must be "implement", "batch-implement", "freestyle" or "loop"' }); return
    }
    // A bare legacy mode (MCP tools, mobile, direct REST — no loopId) must run
    // through the SAME factory loop the dashboard sends, so worktree isolation
    // and the ask-first PR flow apply identically regardless of the launch door.
    // Without this, an agent-launched implement lands in the bare QueueManager
    // branch: shared cwd, SPECRAILS_GIT_AUTO=false, no delivery row — stranded
    // uncommitted work. Loops off ⇒ legacy QueueManager path, unchanged.
    if (isLoopsEnabled() && (typeof loopId !== 'string' || !loopId) && mode !== 'loop') {
      loopId = factoryLoopForMode(mode as string)?.id
    }
    if (mode === 'loop' && !isLoopsEnabled()) {
      res.status(403).json({ error: 'Loops are disabled on this server' }); return
    }
    // Freestyle model picker: optional, validated against the allow-list.
    // Ignored for non-freestyle modes (they use the orchestrator model).
    if (mode === 'freestyle' && model !== undefined && model !== null) {
      if (typeof model !== 'string' || !VALID_FREESTYLE_MODELS.has(model)) {
        res.status(400).json({ error: 'model must be one of: haiku, sonnet, opus, fable' }); return
      }
    }
    // Interactive in-job chat is ON by default for EVERY claude job — the
    // spawn-time gate in QueueManager (kill-switch + persistent-stdin
    // capability) decides, so the launch no longer passes an explicit flag. A
    // legacy `interactive` body param is accepted and ignored (wire compat).

    const c = ctx(req)
    const rail = getRail(c.db, railIndex)

    if (rail.ticketIds.length === 0) {
      res.status(400).json({ error: 'Rail has no tickets assigned' }); return
    }

    // Concurrent-launch safety (parallel rails): a ticket already worked by an
    // ACTIVE run — this rail relaunched mid-run, or the same ticket sitting on
    // two rails — must not spawn a second concurrent writer. The per-ticket
    // worktree path is keyed by ticketId, so a duplicate launch would silently
    // reuse (and corrupt) the in-flight run's checkout. 409 so Launch-all and
    // agent-driven fan-outs surface a clean per-rail skip instead of a clash.
    const inFlightTickets = new Set<number>()
    for (const meta of c.railJobs.values()) for (const id of meta.ticketIds) inFlightTickets.add(id)
    for (const meta of c.railLoopRuns.values()) for (const id of meta.ticketIds) inFlightTickets.add(id)
    const inFlightOverlap = rail.ticketIds.filter((id) => inFlightTickets.has(id))
    if (inFlightOverlap.length > 0) {
      res.status(409).json({ error: 'tickets_in_flight', ticketIds: inFlightOverlap }); return
    }

    // AI engine precedence: explicit body param > stored rail engine > primary.
    // `undefined`/empty in both means "run on the project's primary provider".
    const requestedEngine =
      aiEngine === undefined ? (rail.aiEngine ?? undefined) : aiEngine
    const engineCheck = validateRequestedProvider(c.project, requestedEngine)
    if (!engineCheck.ok) {
      res.status(400).json({ error: engineCheck.error }); return
    }
    // Only pass a provider override when one was actually requested (keeps
    // single-provider rails on the legacy code path).
    const railProvider = requestedEngine ? engineCheck.provider : undefined

    // Freestyle bypasses the OpenSpec pipeline and hands the raw spec to
    // Claude. It is Claude-only — reject when the effective engine is not claude.
    if (mode === 'freestyle' && engineCheck.provider !== 'claude') {
      res.status(400).json({ error: 'Freestyle requires the Claude provider' }); return
    }

    // Profile selection precedence: explicit body param > stored rail profile > default resolution.
    // `null` in the body explicitly forces legacy mode. Codex has no agent
    // profiles, so force legacy mode whenever the chosen engine is not claude.
    let resolvedProfile: string | null | undefined
    if (mode === 'freestyle') {
      // Freestyle runs no agent pipeline, so profiles do not apply.
      resolvedProfile = null
    } else if (railProvider && railProvider !== 'claude') {
      resolvedProfile = null
    } else if (profileName === null) {
      resolvedProfile = null
    } else if (typeof profileName === 'string' && profileName.trim()) {
      resolvedProfile = profileName.trim()
    } else if (rail.profileName) {
      resolvedProfile = rail.profileName
    } else {
      resolvedProfile = undefined // fall through to QueueManager default resolution
    }

    try {
      // Loop mode: run a published loop (the Loops feature) against each spec,
      // one app-driven LoopRun per ticket (mirrors freestyle's per-ticket model).
      // Drives raw prompts via the LoopRunManager — NO queue job, NO slash command.
      // rails-as-loops: a chosen loop (factory OR custom) runs through the
      // LoopRunManager when Loops are enabled — so factory loops get their
      // autonomous verify→fix loop too. (Loops off / no loopId → the legacy
      // bare-mode QueueManager path below; `mode` is the derived factory mode.)
      if (isLoopsEnabled() && typeof loopId === 'string' && loopId) {
        let loopGraph: LoopGraph
        let loopName: string
        if (isFactoryLoopId(loopId)) {
          const f = getFactoryLoop(loopId)
          if (!f) { res.status(404).json({ error: 'Factory loop not found' }); return }
          loopGraph = f.graph
          loopName = f.name
        } else {
          const loop = getLoop(c.desktopDb, loopId)
          if (!loop) { res.status(404).json({ error: 'Loop not found' }); return }
          if (loop.status !== 'published') {
            res.status(400).json({ error: 'Loop must be published before it can run on a rail' }); return
          }
          // A standalone loop (no {{spec.*}} and no ticket command) ignores the
          // rail's spec — it would just re-run once per ticket. Those belong to
          // the Loops page "Run" action; reject them here as a defence-in-depth
          // behind the rail picker, which already hides them.
          if (!loopNeedsTicket(loop.graph)) {
            res.status(400).json({ error: 'This loop runs standalone — launch it from the Loops page, not a rail.' }); return
          }
          loopGraph = loop.graph
          loopName = loop.name
        }
        let effort: ReasoningEffort | undefined
        if (reasoning_effort !== undefined && reasoning_effort !== null) {
          if (typeof reasoning_effort !== 'string' || !VALID_REASONING_EFFORTS.has(reasoning_effort)) {
            res.status(400).json({ error: 'reasoning_effort must be one of: low, medium, high' }); return
          }
          effort = reasoning_effort as ReasoningEffort
        }
        const loopProvider = railProvider ?? c.project.provider ?? 'claude'
        if (typeof model === 'string' && model && !isValidModelForProvider(model, loopProvider as SpecProvider)) {
          res.status(400).json({ error: `model is not valid for provider "${loopProvider}"`, allowed: getModelsForProvider(loopProvider as SpecProvider) }); return
        }
        const loopModel =
          typeof model === 'string' && model ? model : getAdapter(loopProvider).defaultModel()
        // The loop's command(s) declare ticket scope + claude-only-ness.
        const promptsText = loopGraph.nodes
          .filter((n) => n.type === 'ai-step')
          .map((n) => String(n.data?.prompt ?? ''))
          .join('\n')
        if (referencesClaudeOnlyCommand(promptsText) && loopProvider !== 'claude') {
          res.status(400).json({ error: 'This loop uses a Claude-only command and requires the Claude provider' }); return
        }
        const scope = dominantTicketScope(promptsText)

        // Parallel isolation (default-on; disable with SPECRAILS_RAIL_WORKTREES=0):
        // a per-ticket rail on a repo-mutating loop runs each ticket in its own git
        // worktree, then merges the branches back. Degrades gracefully — a non-git
        // repo, an unborn HEAD, or a worktree-allocation failure all fall through to
        // the shared-cwd path below. See rail-isolation.ts.
        let isolationUnavailable: string | undefined
        // Human-readable failure detail for the 'error' case — surfaced to the
        // client so a silent fallback (no delivery row → no implementation
        // cards) is diagnosable from the UI, not just the server log.
        let isolationUnavailableDetail: string | undefined
        let continuablePrDeliveryForFallback: PrDeliverySnapshot | null = null
        let fallbackPrDeliveryId: string | null = null
        // Read-only vs mutating is DERIVED from the loop's nodes (see loop-effect),
        // not a user flag — a content-read-only loop (no ai-step/shell) never writes,
        // so it is not isolated; anything that can write is.
        const loopReadOnly = classifyLoopEffect(loopGraph) === 'read-only'
        if (isolationApplies({ loopsEnabled: isLoopsEnabled(), scope, ticketCount: rail.ticketIds.length, readOnly: loopReadOnly })) {
          // Relaunch collision (ask-first PR delivery): a delivery that has not
          // produced a real PR yet still needs a user decision before more work
          // can safely append to its branches. Once a draft/published PR exists
          // and covers this rail's tickets, relaunch is intentional continuation
          // of that PR head branch (resolved inside launchIsolatedRail).
          if (isRailPrDeliveryEnabled()) {
            const pending = getActivePrDeliveryByRail(c.db, railIndex)
            const pendingSnapshot = pending ? toPrDeliverySnapshot(pending) : null
            if (pendingSnapshot && !prDeliveryContinuesTickets(pendingSnapshot, rail.ticketIds)) {
              res.status(409).json({ error: 'pr_decision_pending', prDeliveryId: pendingSnapshot.id }); return
            }
            continuablePrDeliveryForFallback = pendingSnapshot
          }
          // Worktree isolation needs a git repo WITH at least one commit (an
          // unborn HEAD can't be branched). Fall back (with a message) otherwise.
          const status = await repoIsolationStatus(defaultGitRunner, c.project.path)
          if (status !== 'ok') {
            isolationUnavailable = status // 'no-git' | 'no-commits'
            console.warn(`[rails-router] worktree isolation unavailable (${status}); running shared cwd`)
          } else {
            try {
              const ids = await launchIsolatedRail({
                ctx: c, railIndex, ticketIds: [...rail.ticketIds], loopId, loopName, loopGraph,
                provider: loopProvider, model: loopModel, effort, scope,
                originSurface: originSurface ?? 'dashboard',
                originConversationId: originConversationId ?? null,
                preservePrDeliveryOnAllocationFailure: Boolean(continuablePrDeliveryForFallback),
                onPrDeliveryCreated: (id) => { fallbackPrDeliveryId = id },
              })
              res.status(202).json({ loopRunIds: ids, railIndex, mode, isolated: true })
              return
            } catch (err) {
              console.error('[rails-router] isolated launch failed; falling back to shared cwd:', err)
              isolationUnavailable = 'error'
              isolationUnavailableDetail = err instanceof Error ? err.message : String(err)
            }
          }
        }

        // Spawn from the SAME cwd a rail uses (workspace when relocated, else the
        // repo) so native `{{cmd:*}}` slash commands resolve — and surface the repo
        // via SPECRAILS_REPO_DIR + `--add-dir` exactly like QueueManager.
        const loopExec = resolveProjectExecution({ slug: c.project.slug, path: c.project.path })
        const loopRunIds: string[] = []
        const sharedRunSettles: Promise<boolean>[] = []
        const launchLoopRun = (runId: string, ticketIds: number[], spec: ReturnType<typeof c.getTicketSpec>) => {
          c.railLoopRuns.set(runId, { railIndex, ticketIds })
          // Code-Explorer provenance for shared-cwd loop runs (isolated runs
          // record inside rail-isolated-launch): snapshot the REPO before the
          // run, diff + record at settle. Loop runs settle outside QueueManager,
          // so without this they leave no file_provenance at all. Best-effort;
          // diffs the repo (never the workspace) exactly like QueueManager.
          const provenanceRepoDir = loopExec.relocated && loopExec.repoDir ? loopExec.repoDir : loopExec.cwd
          let provenanceSnapshot: WorkingTreeSnapshot | null = null
          if (isCodeExplorerEnabled()) {
            try { provenanceSnapshot = snapshotWorkingTree(provenanceRepoDir) } catch (err) {
              console.warn(`[rails-router] provenance snapshot failed: ${(err as Error).message}`)
            }
          }
          let provenanceRecorded = false
          const recordRunProvenance = (): void => {
            if (provenanceRecorded) return
            provenanceRecorded = true
            recordLoopRunProvenance({
              db: c.db,
              projectId: c.project.id,
              runId,
              ticketId: ticketIds[0] ?? null,
              repoDir: provenanceRepoDir,
              snapshot: provenanceSnapshot,
              broadcast: (msg) => c.broadcast(msg),
            })
          }
          const runPromise = c.loopRunManager
            .run({
              runId,
              loopId,
              loopName,
              graph: loopGraph,
              projectId: c.project.id,
              cwd: loopExec.cwd,
              repoDir: loopExec.relocated ? loopExec.repoDir : undefined,
              railIndex,
              ticketId: ticketIds[0],
              spec: spec ? { ...spec, ticketIds } : { ticketIds },
              constants: loadConstantMap(c.desktopDb),
              provider: loopProvider,
              model: loopModel,
              effort,
            })
            .then((r) => {
              recordRunProvenance()
              c.onLoopRunFinished(r.runId, r.outcome)
              return r.outcome === 'success'
            })
            .catch((err) => {
              console.error('[rails-router] loop run failed:', err)
              recordRunProvenance()
              c.onLoopRunFinished(runId, 'failed')
              return false
            })
          sharedRunSettles.push(runPromise)
          loopRunIds.push(runId)
          try { c.jiraSyncManager.onRailLaunch(ticketIds, runId) } catch { /* non-fatal */ }
        }
        if (scope === 'all') {
          // ONE run over ALL the rail's tickets ({{spec.ids}} = #1 #2 #3).
          const allIds = [...rail.ticketIds]
          launchLoopRun(newId(), allIds, c.getTicketSpec(allIds[0]))
        } else {
          // One run per ticket.
          for (const ticketId of rail.ticketIds) {
            launchLoopRun(newId(), [ticketId], c.getTicketSpec(ticketId))
          }
        }
        if (fallbackPrDeliveryId) {
          const row = getPrDelivery(c.db, fallbackPrDeliveryId)
          const isExistingPrIteration = row?.decision === 'building' && row.pr_state === 'pr-created' && Boolean(row.pr_url && row.branch)
          if (isExistingPrIteration) {
            if (transitionDecision(c.db, fallbackPrDeliveryId, 'building', 'building', { runIds: loopRunIds })) {
              emitPrDeliveryUpdate(c, fallbackPrDeliveryId)
            }
            void Promise.allSettled(sharedRunSettles).then((settled) => {
              void (async () => {
                const current = getPrDelivery(c.db, fallbackPrDeliveryId!)
                if (current?.decision !== 'building') return
                if (current.pr_state === 'pr-created' && current.pr_url && current.branch) {
                  const succeeded = settled.every((s) => s.status === 'fulfilled' && s.value === true)
                  if (!succeeded) {
                    if (transitionDecision(c.db, fallbackPrDeliveryId!, 'building', 'implementation_failed')) {
                      emitPrDeliveryUpdate(c, fallbackPrDeliveryId!)
                    }
                    return
                  }
                  const commit = await commitWorktreeAndVerify(defaultGitRunner, c.project.path, `specrails: PR follow-up (${loopRunIds.join(', ')})`)
                  if (!commit.clean) {
                    console.error(`[rails-router] existing PR fallback commit verification failed: ${commit.error ?? 'dirty worktree'}${commit.dirty.length > 0 ? `; dirty=${commit.dirty.slice(0, 8).join(', ')}` : ''}`)
                    if (transitionDecision(c.db, fallbackPrDeliveryId!, 'building', 'implementation_failed')) {
                      emitPrDeliveryUpdate(c, fallbackPrDeliveryId!)
                    }
                    return
                  }
                  const pushed = await pushBranch(defaultExec, {
                    repoDir: c.project.path,
                    branch: current.branch,
                    baseBranch: current.base_branch,
                  })
                  if (pushed.state === 'local-only') {
                    if (transitionDecision(c.db, fallbackPrDeliveryId!, 'building', 'pr_failed', { prState: 'local-only' })) {
                      emitPrDeliveryUpdate(c, fallbackPrDeliveryId!)
                    }
                    return
                  }
                  if (transitionDecision(c.db, fallbackPrDeliveryId!, 'building', 'pr_ready', { prState: 'pr-created' })) {
                    emitPrDeliveryUpdate(c, fallbackPrDeliveryId!)
                  }
                }
              })().catch((err) => {
                console.error('[rails-router] existing PR fallback push failed:', err)
                if (fallbackPrDeliveryId) {
                  if (transitionDecision(c.db, fallbackPrDeliveryId, 'building', 'pr_failed', { prState: 'local-only' })) {
                    emitPrDeliveryUpdate(c, fallbackPrDeliveryId)
                  }
                }
              })
            })
          }
        }
        res.status(202).json({
          loopRunIds, railIndex, mode,
          ...(isolationUnavailable ? { isolationUnavailable } : {}),
          ...(isolationUnavailableDetail ? { isolationUnavailableDetail } : {}),
        })
        return
      }

      // A custom-loop launch (mode='loop') with no loopId is invalid — there is
      // no factory loop to fall back to (only implement/batch/freestyle do).
      if (mode === 'loop') {
        res.status(400).json({ error: 'loopId is required for loop mode' }); return
      }

      let jobId: string

      if (mode === 'freestyle') {
        // Freestyle launches ONE independent Claude job per ticket — each gets
        // its own log and runs the spec autonomously (no pipeline). The rail UI
        // tracks the first job as its representative active job; every job is
        // registered so its ticket is marked done on completion.
        // `provider: 'claude'` is explicit so the spawn resolves the claude
        // adapter regardless of the project's primary.
        const freestyleModel =
          mode === 'freestyle' && typeof model === 'string' && VALID_FREESTYLE_MODELS.has(model)
            ? model
            : undefined
        const jobIds: string[] = []
        for (const ticketId of rail.ticketIds) {
          const command = `/specrails:freestyle #${ticketId} --yes`
          const job = c.queueManager.enqueue(command, 'normal', {
            profileName: null,
            provider: 'claude',
            ...(freestyleModel ? { model: freestyleModel } : {}),
            // No explicit `interactive` — QueueManager's spawn-time default
            // (kill-switch + persistent-stdin capability) covers it, and the
            // decision survives a restart that way.
          })
          jobIds.push(job.id)
          c.railJobs.set(job.id, { railIndex, mode, ticketIds: [ticketId] })
          // Jira write-back: push In Progress for any Jira-linked ticket (inert
          // for non-Jira projects). Best-effort — never blocks the launch.
          try { c.jiraSyncManager.onRailLaunch([ticketId], job.id) } catch { /* non-fatal */ }
        }
        jobId = jobIds[0]

        const startMsg: RailJobStartedMessage = {
          type: 'rail.job_started',
          projectId: c.project.id,
          railIndex,
          jobId,
          mode,
        }
        c.broadcast(startMsg)

        res.status(202).json({ jobId, jobIds, railIndex, mode })
        return
      }

      // Implement / batch-implement create a single job with all ticket IDs.
      // /specrails:implement handles multiple specs in parallel internally.
      const issueArgs = rail.ticketIds.map((id) => `#${id}`).join(' ')
      const commandName = mode === 'batch-implement' ? 'batch-implement' : 'implement'
      const command = `/specrails:${commandName} ${issueArgs} --yes`
      const job = c.queueManager.enqueue(command, 'normal', { profileName: resolvedProfile, provider: railProvider })
      jobId = job.id
      c.railJobs.set(jobId, { railIndex, mode, ticketIds: [...rail.ticketIds] })
      // Jira write-back: push In Progress for any Jira-linked ticket (inert for
      // non-Jira projects). Best-effort — never blocks the launch.
      try { c.jiraSyncManager.onRailLaunch([...rail.ticketIds], jobId) } catch { /* non-fatal */ }

      const startMsg: RailJobStartedMessage = {
        type: 'rail.job_started',
        projectId: c.project.id,
        railIndex,
        jobId,
        mode,
      }
      c.broadcast(startMsg)

      res.status(202).json({ jobId, railIndex, mode })
    } catch (err) {
      if (err instanceof ClaudeNotFoundError) {
        res.status(503).json({ error: 'Claude CLI not found' }); return
      }
      if (err instanceof CodexNotFoundError) {
        res.status(503).json({ error: 'Codex CLI not found' }); return
      }
      console.error('[rails-router] launch error:', err)
      res.status(500).json({ error: 'Failed to launch rail job' })
    }
  })

  // POST /rails/:railIndex/stop — kill the running job for a rail
  router.post('/:railIndex/stop', (req: Request, res: Response) => {
    const railIndex = parseInt(req.params.railIndex as string, 10)
    if (isNaN(railIndex) || railIndex < 0 || railIndex >= MAX_RAILS) {
      res.status(400).json({ error: 'Invalid rail index' }); return
    }

    const c = ctx(req)

    // M19: an Freestyle rail registers ONE queue job per ticket. The old code
    // stopped only the FIRST matching job, so the remaining N-1 jobs kept running
    // and billing while the UI showed the rail stopped. Collect ALL jobs for this
    // rail index and cancel each (running → kill, queued → cancel).
    const targetJobIds = Array.from(c.railJobs.entries())
      .filter(([, meta]) => meta.railIndex === railIndex)
      .map(([jobId]) => jobId)
    const targetLoopRunIds = Array.from(c.railLoopRuns.entries())
      .filter(([, meta]) => meta.railIndex === railIndex)
      .map(([runId]) => runId)

    if (targetJobIds.length === 0 && targetLoopRunIds.length === 0) {
      res.status(404).json({ error: 'No active rail job found for this rail' }); return
    }

    let canceledCount = 0
    for (const jobId of targetJobIds) {
      try {
        c.queueManager.cancel(jobId)
        canceledCount++
      } catch (err) {
        // Already terminal / unknown — clean up the stale entry regardless so the
        // rail card can't get wedged 'running' (this was the unrecoverable case).
        console.warn(`[rails-router] stop: cancel(${jobId}) failed: ${(err as Error).message}`)
      }
      c.railJobs.delete(jobId)
    }

    // Broadcast one stop per job so every rail card reconciles.
    for (const jobId of targetJobIds) {
      const stopMsg: RailJobStoppedMessage = {
        type: 'rail.job_stopped',
        projectId: c.project.id,
        railIndex,
        jobId,
      }
      c.broadcast(stopMsg)
    }

    // Loop runs (Loops mode): request cancellation. The engine settles 'stopped'
    // at the next node boundary and onLoopRunFinished releases the rail's tickets
    // (so we deliberately do NOT delete railLoopRuns here).
    for (const runId of targetLoopRunIds) {
      try {
        c.loopRunManager.cancel(runId)
        canceledCount++
      } catch (err) {
        console.warn(`[rails-router] stop: loop cancel(${runId}) failed: ${(err as Error).message}`)
      }
      const stopMsg: LoopRunStoppedMessage = {
        type: 'loop.run_stopped',
        projectId: c.project.id,
        loopRunId: runId,
        railIndex,
      }
      c.broadcast(stopMsg)
    }

    res.json({ ok: true, jobIds: targetJobIds, loopRunIds: targetLoopRunIds, canceled: canceledCount })
  })

  // POST /rails/pr-decision — the ONE decision action (safe-pr-review-flow) both
  // surfaces (dashboard rail row + agent-chat card) call on a rail_pr_deliveries
  // row: create-pr | publish | discard | poll-merge, compare-and-set-guarded by
  // expectedDecision (a raced concurrent answer loses with 409 stale_decision).
  // Replaces the stateless v1 POST /rails/pr-review passthrough. The route only
  // validates and delegates — the action logic lives in rail-pr-decision.ts.
  // specrails never merges — the engineer owns the merge.
  router.post('/pr-decision', async (req: Request, res: Response) => {
    const c = ctx(req)
    const { prDeliveryId, action, expectedDecision } = req.body ?? {}
    if (typeof prDeliveryId !== 'string' || !prDeliveryId) {
      res.status(400).json({ error: 'prDeliveryId is required' }); return
    }
    if (!isPrDecisionAction(action)) {
      res.status(400).json({ error: "action must be 'create-pr', 'publish', 'discard' or 'poll-merge'" }); return
    }
    if (typeof expectedDecision !== 'string' || !expectedDecision) {
      res.status(400).json({ error: 'expectedDecision is required' }); return
    }
    try {
      const result = await executePrDecision(
        {
          db: c.db,
          project: { id: c.project.id, slug: c.project.slug, path: c.project.path },
          git: defaultGitRunner,
          exec: defaultExec,
          broadcast: c.broadcast,
          jiraSyncManager: c.jiraSyncManager,
        },
        { prDeliveryId, action, expectedDecision },
      )
      res.status(result.status).json(result.body)
    } catch (err) {
      console.error('[rails-router] pr-decision error:', err)
      res.status(500).json({ error: 'pr-decision failed', detail: (err as Error).message })
    }
  })

  // POST /rails/pr-checkout — move the user's main checkout to the delivered PR
  // branch. This is intentionally separate from PR decisions: it does not accept,
  // publish, discard, or merge anything. It only releases Specrails-managed
  // worktrees for this delivery (keeping branches) and then checks out the PR
  // branch in the real project repo so the user can test/edit locally.
  router.post('/pr-checkout', async (req: Request, res: Response) => {
    const c = ctx(req)
    const { prDeliveryId } = req.body ?? {}
    if (typeof prDeliveryId !== 'string' || !prDeliveryId) {
      res.status(400).json({ error: 'prDeliveryId is required' }); return
    }
    const row = getPrDelivery(c.db, prDeliveryId)
    if (!row) {
      res.status(404).json({ error: 'Unknown prDeliveryId' }); return
    }
    const snap = toPrDeliverySnapshot(row)
    if (!snap.branch || !snap.prUrl) {
      res.status(409).json({ error: 'checkout_unavailable', detail: 'delivery has no PR branch' }); return
    }
    try {
      const info = await getProjectGitInfo(c.project.path)
      if (!info.git) {
        res.status(409).json({ error: 'checkout_unavailable', detail: 'project is not a git repository' }); return
      }
      if (info.dirty) {
        res.status(409).json({ error: 'checkout_dirty', detail: 'Working tree has uncommitted changes. Commit or stash them before checkout.' }); return
      }
      await releaseRailWorktrees({
        db: c.db,
        git: defaultGitRunner,
        repoDir: c.project.path,
        worktreeIds: snap.worktreeIds,
      })
      const result = await checkoutProjectReviewBranch(c.project.path, snap.branch)
      if (!result.ok) {
        res.status(409).json({ error: 'checkout_failed', detail: result.error }); return
      }
      res.json({ ok: true, git: await getProjectGitInfo(c.project.path) })
    } catch (err) {
      console.error('[rails-router] pr-checkout error:', err)
      res.status(500).json({ error: 'pr-checkout failed', detail: (err as Error).message })
    }
  })

  return router
}
