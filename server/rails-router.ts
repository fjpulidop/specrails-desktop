import { Router, Request, Response } from 'express'
import type { ProjectContext } from './project-registry'
import { getRails, getRail, setRailTickets, setRailProfile, setRailEngine, setRailName, type RailState } from './rails-store'
import { ClaudeNotFoundError, CodexNotFoundError } from './queue-manager'
import { validateRequestedProvider } from './provider-selection'
import { isInteractiveJobsEnabled, isLoopsEnabled } from './feature-flags'
import { getLoop } from './loops-store'
import { getLoopRun } from './loop-runs-store'
import { getAdapter } from './providers'
import { resolveProjectExecution } from './workspace-resolution'
import { isFactoryLoopId, factoryLoopMode, getFactoryLoop } from './loop-factory'
import { loadConstantMap } from './loop-constants'
import { dominantTicketScope, referencesClaudeOnlyCommand } from './loop-command-catalog'
import { loopNeedsTicket, type LoopGraph } from './loop-graph'
import { isolationApplies } from './rail-isolation'
import { launchIsolatedRail } from './rail-isolated-launch'
import { isGitRepo, defaultGitRunner } from './worktree-manager'
import { newId } from './ids'
import type { ReasoningEffort } from './providers/types'
import type { RailJobStartedMessage, RailJobStoppedMessage, RailUpdatedMessage, LoopRunStoppedMessage } from './types'

// Extend Express Request to carry resolved ProjectContext (declared in project-router)
declare module 'express-serve-static-core' {
  interface Request {
    projectCtx?: ProjectContext
  }
}

const VALID_MODES = new Set(['implement', 'batch-implement', 'ultracode', 'loop'])
// Models the ultracode picker exposes (Claude aliases). Mirrors the client
// RailModelSelector options and the project-router orchestrator-model allow-list.
const VALID_ULTRACODE_MODELS = new Set(['haiku', 'sonnet', 'opus'])
// Reasoning-effort tiers a loop launch may request (mirrors the client selector
// + the provider adapters' supported values).
const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high'])

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
      }> = {}
      for (const [runId, meta] of c.railLoopRuns.entries()) {
        const run = getLoopRun(c.db, runId)
        activeLoopRuns[meta.railIndex] = run
          ? { loopRunId: runId, loopId: run.loop_id, loopName: run.loop_name, provider: run.provider, model: run.model, iteration: run.iteration_count }
          : { loopRunId: runId }
      }
      res.json({ rails, activeJobs, activeLoopRuns })
    } catch (err) {
      console.error('[rails-router] get rails error:', err)
      res.status(500).json({ error: 'Failed to fetch rails' })
    }
  })

  // PUT /rails/:railIndex/tickets — set ticket assignments for a rail
  router.put('/:railIndex/tickets', (req: Request, res: Response) => {
    const railIndex = parseInt(req.params.railIndex as string, 10)
    if (isNaN(railIndex) || railIndex < 0) {
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
    if (isNaN(railIndex) || railIndex < 0) {
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
    if (isNaN(railIndex) || railIndex < 0) {
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
    if (isNaN(railIndex) || railIndex < 0) {
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
    if (isNaN(railIndex) || railIndex < 0) {
      res.status(400).json({ error: 'Invalid rail index' }); return
    }

    let { mode = 'implement' } = req.body ?? {}
    const { profileName, aiEngine, model, interactive, loopId, reasoning_effort } = req.body ?? {}
    // rails-as-loops: a FACTORY loop id (`factory:implement` etc.) maps to its
    // legacy mode and runs through the EXISTING engine (QueueManager) — the rail
    // "picks a Loop", the plumbing is unchanged. A CUSTOM loop id keeps mode='loop'
    // (LoopRunManager). Legacy callers that still send a bare `mode` are unchanged.
    if (typeof loopId === 'string' && isFactoryLoopId(loopId)) {
      const fmode = factoryLoopMode(loopId)
      if (!fmode) { res.status(404).json({ error: 'Factory loop not found' }); return }
      mode = fmode
    }
    if (!VALID_MODES.has(mode as string)) {
      res.status(400).json({ error: 'mode must be "implement", "batch-implement", "ultracode" or "loop"' }); return
    }
    if (mode === 'loop' && !isLoopsEnabled()) {
      res.status(403).json({ error: 'Loops are disabled on this server' }); return
    }
    // Ultracode model picker: optional, validated against the allow-list.
    // Ignored for non-ultracode modes (they use the orchestrator model).
    if (mode === 'ultracode' && model !== undefined && model !== null) {
      if (typeof model !== 'string' || !VALID_ULTRACODE_MODELS.has(model)) {
        res.status(400).json({ error: 'model must be one of: haiku, sonnet, opus' }); return
      }
    }
    // Interactive toggle: only valid for ultracode (Claude-only) and only when
    // the feature is enabled. Reject loudly so the client never silently drops it.
    if (interactive === true) {
      if (mode !== 'ultracode') {
        res.status(400).json({ error: 'interactive mode is only available for ultracode rails' }); return
      }
      if (!isInteractiveJobsEnabled()) {
        res.status(403).json({ error: 'Interactive jobs are disabled on this server' }); return
      }
    }

    const c = ctx(req)
    const rail = getRail(c.db, railIndex)

    if (rail.ticketIds.length === 0) {
      res.status(400).json({ error: 'Rail has no tickets assigned' }); return
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

    // Ultracode bypasses the OpenSpec pipeline and hands the raw spec to
    // Claude. It is Claude-only — reject when the effective engine is not claude.
    if (mode === 'ultracode' && engineCheck.provider !== 'claude') {
      res.status(400).json({ error: 'Ultracode requires the Claude provider' }); return
    }

    // Profile selection precedence: explicit body param > stored rail profile > default resolution.
    // `null` in the body explicitly forces legacy mode. Codex has no agent
    // profiles, so force legacy mode whenever the chosen engine is not claude.
    let resolvedProfile: string | null | undefined
    if (mode === 'ultracode') {
      // Ultracode runs no agent pipeline, so profiles do not apply.
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
      // one app-driven LoopRun per ticket (mirrors ultracode's per-ticket model).
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

        // Parallel isolation (opt-in via SPECRAILS_RAIL_WORKTREES): a per-ticket
        // rail fanning out >1 ticket on a repo-mutating loop runs each ticket in
        // its own git worktree, then merges the branches back. Inert by default —
        // falls through to the shared-cwd path below unless the flag is on; a
        // worktree-allocation failure also falls back. See rail-isolation.ts.
        let isolationUnavailable: string | undefined
        if (isolationApplies({ loopsEnabled: isLoopsEnabled(), scope, ticketCount: rail.ticketIds.length, readOnly: false })) {
          // Worktree isolation needs a git repo — fall back (with a message) when
          // the project isn't one.
          if (!(await isGitRepo(defaultGitRunner, c.project.path))) {
            isolationUnavailable = 'no-git'
            console.warn('[rails-router] worktree isolation requested but project is not a git repo; running shared cwd')
          } else {
            try {
              const ids = await launchIsolatedRail({
                ctx: c, railIndex, ticketIds: [...rail.ticketIds], loopId, loopName, loopGraph,
                provider: loopProvider, model: loopModel, effort,
              })
              res.status(202).json({ loopRunIds: ids, railIndex, mode, isolated: true })
              return
            } catch (err) {
              console.error('[rails-router] isolated launch failed; falling back to shared cwd:', err)
              isolationUnavailable = 'error'
            }
          }
        }

        // Spawn from the SAME cwd a rail uses (workspace when relocated, else the
        // repo) so native `{{cmd:*}}` slash commands resolve — and surface the repo
        // via SPECRAILS_REPO_DIR + `--add-dir` exactly like QueueManager.
        const loopExec = resolveProjectExecution({ slug: c.project.slug, path: c.project.path })
        const loopRunIds: string[] = []
        const launchLoopRun = (runId: string, ticketIds: number[], spec: ReturnType<typeof c.getTicketSpec>) => {
          c.railLoopRuns.set(runId, { railIndex, ticketIds })
          c.loopRunManager
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
            .then((r) => c.onLoopRunFinished(r.runId, r.outcome))
            .catch((err) => {
              console.error('[rails-router] loop run failed:', err)
              c.onLoopRunFinished(runId, 'failed')
            })
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
        res.status(202).json({ loopRunIds, railIndex, mode, ...(isolationUnavailable ? { isolationUnavailable } : {}) })
        return
      }

      // A custom-loop launch (mode='loop') with no loopId is invalid — there is
      // no factory loop to fall back to (only implement/batch/ultracode do).
      if (mode === 'loop') {
        res.status(400).json({ error: 'loopId is required for loop mode' }); return
      }

      let jobId: string

      if (mode === 'ultracode') {
        // Ultracode launches ONE independent Claude job per ticket — each gets
        // its own log and runs the spec autonomously (no pipeline). The rail UI
        // tracks the first job as its representative active job; every job is
        // registered so its ticket is marked done on completion.
        // `provider: 'claude'` is explicit so the spawn resolves the claude
        // adapter regardless of the project's primary.
        const ultracodeModel =
          mode === 'ultracode' && typeof model === 'string' && VALID_ULTRACODE_MODELS.has(model)
            ? model
            : undefined
        const jobIds: string[] = []
        for (const ticketId of rail.ticketIds) {
          const command = `/specrails:ultracode #${ticketId} --yes`
          const job = c.queueManager.enqueue(command, 'normal', {
            profileName: null,
            provider: 'claude',
            ...(ultracodeModel ? { model: ultracodeModel } : {}),
            ...(interactive === true ? { interactive: true } : {}),
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
    if (isNaN(railIndex) || railIndex < 0) {
      res.status(400).json({ error: 'Invalid rail index' }); return
    }

    const c = ctx(req)

    // M19: an Ultracode rail registers ONE queue job per ticket. The old code
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

  return router
}
