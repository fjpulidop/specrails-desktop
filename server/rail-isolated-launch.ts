/**
 * Isolated (worktree-per-ticket) rail launch — the live wiring that turns the
 * tested building blocks (worktree-manager, merge-manager, rail-merge-orchestrator,
 * ledger) into a running parallel rail. Gated OFF by default (rail-isolation's
 * opt-in flag), so this path is inert unless explicitly enabled.
 *
 * Flow: allocate one worktree+branch per ticket → fan out the loop runs IN those
 * worktrees (so concurrent AI CLIs never collide) → when ALL runs settle, run the
 * sequential validated merge-back on the base repo, then clean up worktrees.
 *
 * The run spawns with cwd = the worktree (and repoDir = the worktree, so
 * writes/git land there). Because `git worktree add` materializes only TRACKED
 * files, each worktree gets a PER-RUN OVERLAY at allocation
 * (worktree-overlay.ts): the framework surface (`/specrails:*` commands, sr-*
 * agents, skills, rules, `.mcp.json`, the instruction file) is merge-linked in
 * from the project's EFFECTIVE artifact root — the workspace for RELOCATED
 * projects, the repo's own on-disk untracked entries for legacy ones — never
 * overwriting anything the checkout brought. Overlay entries are excluded from
 * `commitWorktree` so they never land on the ticket branch/PR; overlay failures
 * degrade (log + `rail.overlay_degraded` broadcast) instead of aborting the
 * rail. Relocated artifact state (tickets/backlog/profiles) reaches the spawn
 * via the executors' base env (see workspace-resolution.resolveLoopBaseEnv).
 */
import * as path from 'path'
import { resolveHome } from './artifact-registry'
import { newId } from './ids'
import { loadConstantMap } from './loop-constants'
import { defaultGitRunner, createWorktree, removeWorktree, commitWorktree, listLocalBranches, worktreeBranch, type GitRunner, type WorktreeHandle } from './worktree-manager'
import { createRailWorktree, updateRailWorktreeState, listNonTerminalRailWorktrees, railWorktreeBranchExistsForTicket, getRailWorktree, isTerminalMergeState } from './rail-worktrees-store'
import { ticketBranchName, ticketRef, resolveCollisionFreeName, type TicketNamingInput } from './pr-naming'
import { getLinkByLocalId } from './jira/jira-db'
import type { DbInstance } from './db'
import { getProjectSettings } from './db'
import { resolveIntegrationBranch, fetchOrigin, resolveWorktreeBaseRef, type ResolvedIntegrationBranch } from './integration-branch'
import { withRepoLock } from './repo-lock'
import { isRailPrDeliveryEnabled } from './rail-isolation'
import {
  createPrDelivery, getPrDelivery, transitionDecision, toPrDeliverySnapshot,
  toRailPrStateMessage, toPrDecisionCardEnvelope, type PrOriginSurface,
} from './rail-pr-store'
import { getAgentChatManager } from './agent-chat-registry'
import { runMergeBack } from './rail-merge-orchestrator'
import { createLoopExecutors } from './loop-executors'
import { applyWorktreeOverlay } from './worktree-overlay'
import { resolveProjectExecution } from './workspace-resolution'
import { isCodeExplorerEnabled } from './feature-flags'
import { snapshotWorkingTree, type WorkingTreeSnapshot } from './file-provenance'
import { recordLoopRunProvenance } from './file-story'
import { getAdapter } from './providers'
import { defaultExec, pushBranch, type Exec } from './pr-publisher'
import { resolveActivePrContinuationTargets, type ActivePrContinuationTarget } from './active-pr-continuation'
import { releaseRailWorktrees } from './rail-worktree-release'
import type { BranchToMerge } from './merge-manager'
import type { LoopGraph } from './loop-graph'
import type { ProjectContext } from './project-registry'
import type { ReasoningEffort } from './providers/types'

export interface IsolatedLaunchInput {
  ctx: ProjectContext
  railIndex: number
  ticketIds: number[]
  loopId: string
  loopName: string
  loopGraph: LoopGraph
  provider: string
  model: string
  effort?: ReasoningEffort
  /** How the rail fans out: `per-ticket` = one worktree+run per ticket; `all` =
   *  ONE worktree+run covering every ticket (e.g. `{{cmd:implement}}` which runs
   *  the whole batch in a single pipeline invocation). Default `per-ticket`. */
  scope?: 'per-ticket' | 'all'
  /** Which surface launched the rail (persisted on the rail_pr_deliveries row so
   *  the PR decision can be surfaced back at its origin). Default `dashboard`. */
  originSurface?: PrOriginSurface
  /** The launching agent-chat conversation id (agent-chat/MCP launches only);
   *  null/omitted for dashboard launches. */
  originConversationId?: string | null
  /** Called immediately after the PR-delivery row is inserted. */
  onPrDeliveryCreated?: (id: string) => void
  /**
   * When true, an allocation failure leaves the just-created delivery in
   * `building` so the caller can attach a shared-cwd fallback run to the same
   * implementation card. Default false keeps direct callers from wedging a rail.
   */
  preservePrDeliveryOnAllocationFailure?: boolean
}

/** Injectable git/worktree IO (defaults to the real implementations) — lets the
 *  allocation + teardown logic be unit-tested without a real repo. */
export interface IsolatedLaunchIO {
  git?: GitRunner
  create?: typeof createWorktree
  remove?: typeof removeWorktree
  /** Per-run framework overlay applied to each fresh worktree. */
  overlay?: typeof applyWorktreeOverlay
  /** Resolves the project's execution (relocated vs legacy) — decides the
   *  overlay's source root (workspace vs repo). */
  resolveExecution?: typeof resolveProjectExecution
  /** Code-Explorer provenance: pre-run worktree snapshot + settle recorder
   *  (injectable so unit tests need no real git repo). */
  snapshot?: typeof snapshotWorkingTree
  recordProvenance?: typeof recordLoopRunProvenance
  /** gh-backed PR discovery for continuing already-open PR branches. */
  exec?: Exec
}

interface AllocatedRun {
  /** The primary ticket (branch/ledger key). */
  ticketId: number
  /** Every ticket this run covers (= [ticketId] for per-ticket; all rail tickets for `all`). */
  ticketIds: number[]
  runId: string
  ledgerId: string
  handle: WorktreeHandle
  /** Worktree-relative overlay-owned paths — excluded from commitWorktree so
   *  the app's framework scaffolding never lands on the ticket branch/PR. */
  overlayExcludes: string[]
  /** Pre-run Code-Explorer snapshot of the fresh worktree (null when the
   *  explorer is disabled or the snapshot failed) — diffed at settle so
   *  isolated loop runs record file_provenance like QueueManager jobs do. */
  provenanceSnapshot: WorkingTreeSnapshot | null
  /** Existing open PR branch this run is intentionally continuing, if any. */
  continuationTarget: ActivePrContinuationTarget | null
}

/**
 * Ticket data for the conventional branch name (pr-naming): title/labels from
 * the ticket-spec reader, the Jira key resolved with the authoritative
 * `jira_links` row prevailing over the ticket's own `jira_key` field (JIRA
 * ALWAYS PREVAILS). Fully failure-tolerant — a missing store/link degrades to
 * the bare local ticket id.
 */
function unitNamingInput(ctx: ProjectContext, ticketId: number): TicketNamingInput {
  let spec: { title?: string; labels?: string[]; jira_key?: string | null } | undefined
  try {
    spec = ctx.getTicketSpec(ticketId) as typeof spec
  } catch {
    /* tolerated */
  }
  let jiraKey: string | null = spec?.jira_key ?? null
  try {
    const link = getLinkByLocalId(ctx.db, ticketId)
    if (link && !link.tombstoned && link.jiraKey) jiraKey = link.jiraKey
  } catch {
    /* tolerated */
  }
  return { ticketId, title: spec?.title ?? null, labels: spec?.labels ?? null, jiraKey }
}

/**
 * Commit messages are consumed by GitHub↔Jira development panels. Branch names
 * already carry the Jira key for new work; commits must too, especially when
 * continuing an existing PR whose branch name may predate the current ticket
 * key. Keep the local id as a fallback/cross-reference for Specrails.
 */
function worktreeCommitMessage(ctx: ProjectContext, ticketId: number, runId: string, partial = false): string {
  const input = unitNamingInput(ctx, ticketId)
  const ref = ticketRef(input)
  const subjectRef = ref === String(ticketId) ? `ticket-${ticketId}` : `${ref} ticket-${ticketId}`
  return `specrails: ${subjectRef}${partial ? ' partial' : ''} (run ${runId})`
}

/**
 * Launch the rail's tickets in isolated worktrees + schedule the merge-back.
 * Returns the loop run ids. Throws if worktree allocation fails (the caller then
 * falls back to the shared-cwd path) — but only after tearing down any partial
 * allocation, so a failure never leaves orphaned worktrees.
 */
export async function launchIsolatedRail(input: IsolatedLaunchInput, io: IsolatedLaunchIO = {}): Promise<string[]> {
  const { ctx, railIndex, ticketIds, loopId, loopName, loopGraph, provider, model, effort } = input
  const git = io.git ?? defaultGitRunner
  const exec = io.exec ?? defaultExec
  const create = io.create ?? createWorktree
  const remove = io.remove ?? removeWorktree
  const overlay = io.overlay ?? applyWorktreeOverlay
  const resolveExecution = io.resolveExecution ?? resolveProjectExecution
  const baseRepo = ctx.project.path
  const slug = ctx.project.slug
  const worktreesRoot = path.join(resolveHome(), '.specrails', 'projects', slug, 'worktrees')
  const constants = loadConstantMap(ctx.desktopDb)
  // Capture the PR-delivery mode ONCE at launch entry so a mid-flight env flip
  // can never split one launch across the two delivery paths.
  const prMode = isRailPrDeliveryEnabled()

  // Ask-first PR delivery (safe-pr-review-flow): persist the authoritative
  // decision row UP FRONT (decision='building') — so the origin link survives
  // every await and late-joining clients hydrate mid-build via GET /rails —
  // and re-broadcast the durable rail.pr_state snapshot on every mutation.
  let prDeliveryId: string | null = null
  const broadcastPrState = (): void => {
    if (!prDeliveryId) return
    const row = getPrDelivery(ctx.db, prDeliveryId)
    if (row) ctx.broadcast(toRailPrStateMessage(ctx.project.id, toPrDeliverySnapshot(row)))
  }
  // Origin-conversation card sync: when the launch came from an agent-chat
  // conversation, mirror the row's state into its inline decision card —
  // 'post' at launch (the user sees "working in an isolated worktree" from
  // second zero), 'update' on every later transition (settle, alloc-failure).
  // Null-safe: registry empty in tests / disabled builds; update falls back to
  // post when no card exists yet.
  const syncOriginCard = (verb: 'post' | 'update'): void => {
    if (!prDeliveryId) return
    const row = getPrDelivery(ctx.db, prDeliveryId)
    if (!row?.origin_conversation_id) return
    const mgr = getAgentChatManager()
    if (!mgr) return
    const envelope = toPrDecisionCardEnvelope(ctx.project.id, toPrDeliverySnapshot(row))
    if (verb === 'post') mgr.postPrDecisionCard(row.origin_conversation_id, envelope)
    else mgr.updatePrDecisionCard(row.origin_conversation_id, envelope)
  }
  // Units of isolation: `all` → ONE unit covering every ticket (one worktree, one
  // run — the batch pipeline handles the tickets internally); `per-ticket` → one
  // unit per ticket. The branch/ledger key is the unit's primary (first) ticket.
  const scope = input.scope ?? 'per-ticket'
  const units: { ticketId: number; ticketIds: number[] }[] =
    scope === 'all'
      ? [{ ticketId: ticketIds[0], ticketIds: [...ticketIds] }]
      : ticketIds.map((id) => ({ ticketId: id, ticketIds: [id] }))

  // Effective artifact root for the per-worktree overlay: a RELOCATED project's
  // framework surface (slash commands, sr-* agents, skills, rules, .mcp.json,
  // instruction file) lives in the WORKSPACE, not the repo — and `git worktree
  // add` materializes only TRACKED files, so without the overlay a relocated
  // worktree spawn has no `/specrails:*` commands at all. Legacy projects
  // overlay their repo's own untracked on-disk entries instead. Resolved ONCE
  // per launch; a resolution failure degrades to the legacy (repo) source.
  let overlaySourceRoot = baseRepo
  try {
    const exec = resolveExecution({ slug, path: baseRepo })
    if (exec.relocated && exec.workspaceDir) overlaySourceRoot = exec.workspaceDir
  } catch { /* legacy fallback */ }
  let overlayProviderDir = '.claude'
  let overlayInstructions = 'CLAUDE.md'
  try {
    const adapter = getAdapter(input.provider)
    overlayProviderDir = adapter.projectDirName
    overlayInstructions = adapter.instructionsFilename
  } catch { /* unknown provider — claude-shaped defaults */ }
  // Degraded overlay = the run may be missing native commands/agents. Never
  // aborts the rail (a partial surface beats no run) but MUST be visible:
  // stderr-style server log + a project-scoped WS event.
  const notifyOverlayDegraded = (ticketId: number, warnings: string[]): void => {
    console.error(`[rail-isolated] worktree overlay degraded (ticket ${ticketId}): ${warnings.join('; ')}`)
    try {
      ctx.broadcast({ type: 'rail.overlay_degraded', projectId: ctx.project.id, railIndex, ticketId, warnings })
    } catch { /* non-fatal */ }
  }

  // 0+1. Resolve the integration branch, persist the decision row, compute
  //    branch names, and allocate ALL worktrees up front (all-or-nothing) so a
  //    mid-way failure can't leave the rail half-isolated. The WHOLE section is
  //    SERIALIZED per base repo (withRepoLock — the same key the merge-back
  //    uses): parallel launches on different rails are safe and normal, but
  //    concurrent `git worktree add` / branch creation on the same repo can
  //    race on ref locks, and two launches snapshotting `listLocalBranches`
  //    concurrently could allocate the same collision-suffixed branch name.
  //    Only allocation is locked — the fan-out (the actual AI runs) below
  //    stays fully parallel.
  let integration!: ResolvedIntegrationBranch
  let launchContinuation: ActivePrContinuationTarget | null = null
  const allocated: AllocatedRun[] = []
  await withRepoLock(baseRepo, async () => {
  // Bring the repo's remote-tracking refs up to date BEFORE resolving the
  // integration branch or allocating any worktree — otherwise `git worktree
  // add -b <branch> <path> <bare-name>` resolves against whatever (possibly
  // stale) commit the user's LOCAL branch happens to be at. `fetchOrigin` only
  // ever touches `refs/remotes/origin/*`; it never mutates the checked-out
  // branch/working tree. De-duped per repo for a short TTL so a "Launch all"
  // batch (N independent launch requests for the same repo, serialized by
  // this same withRepoLock) performs one real fetch, not one per rail. A
  // failed fetch (no network / no remote / auth error) never blocks the
  // launch — resolveWorktreeBaseRef below degrades to the local ref.
  const fetchResult = await fetchOrigin(git, baseRepo)

  // Resolve the project's designated integration branch ONCE, and branch every
  // ticket's worktree off it (not the ambient HEAD). Empty setting → auto-resolve
  // (repo default → HEAD fallback). See server/integration-branch.ts.
  integration = await resolveIntegrationBranch(git, {
    repoDir: baseRepo,
    projectSetting: getProjectSettings(ctx.db).integrationBranch,
  })

  // Prefer the freshly-fetched remote-tracking ref (origin/<branch>) over the
  // bare local name for repo-default/project-setting sources — see
  // resolveWorktreeBaseRef for the exact fallback policy. `explicit` is left
  // completely untouched (rare, launch-time-chosen override).
  const worktreeBaseRef = await resolveWorktreeBaseRef(git, {
    repoDir: baseRepo, integration, fetchOk: fetchResult.ok,
  })
  if (worktreeBaseRef.warning) {
    console.warn(`[rail-isolated] ${worktreeBaseRef.warning} (repo ${baseRepo})`)
    try {
      ctx.broadcast({ type: 'rail.fetch_degraded', projectId: ctx.project.id, railIndex, warning: worktreeBaseRef.warning })
    } catch { /* non-fatal, mirrors notifyOverlayDegraded's broadcast guard below */ }
  }

  // Active-PR continuation: if a ticket is already parked on_review with a
  // matching OPEN GitHub PR (or a Jira-linked in_progress ticket explicitly
  // matches an open PR, covering unmapped Jira "Review" statuses), run the next
  // pass directly on that PR's head branch. Fresh tickets stay on the normal
  // integration-base path. Keep this deliberately single-target for now: one
  // rail delivery row can represent one PR URL, so multi-PR batches continue to
  // use the existing new-work flow instead of silently mixing PRs.
  const continuationTargets = await resolveActivePrContinuationTargets({
    db: ctx.db,
    git,
    exec,
    repoDir: baseRepo,
    ticketIds: units.map((u) => u.ticketId),
    integrationBranch: integration.branch,
    fetchOk: fetchResult.ok,
    getTicketSpec: (ticketId) => {
      try { return ctx.getTicketSpec(ticketId) as ReturnType<typeof unitNamingInput> & { status?: string; description?: string } }
      catch { return undefined }
    },
  })
  const uniqueContinuationKeys = new Set(
    units
      .map((u) => continuationTargets.get(u.ticketId))
      .filter((t): t is ActivePrContinuationTarget => !!t)
      .map((t) => `${t.prUrl ?? ''}\n${t.branch}`),
  )
  if (uniqueContinuationKeys.size === 1 && units.every((u) => continuationTargets.has(u.ticketId))) {
    launchContinuation = continuationTargets.get(units[0].ticketId) ?? null
  }

  if (prMode) {
    prDeliveryId = createPrDelivery(ctx.db, {
      railIndex,
      loopId,
      railKey: `${railIndex}-${loopId}`,
      ticketIds: [...ticketIds],
      baseBranch: launchContinuation?.baseBranch ?? integration.branch,
      loopName,
      originSurface: input.originSurface ?? 'dashboard',
      originConversationId: input.originConversationId ?? null,
    }).id
    input.onPrDeliveryCreated?.(prDeliveryId)
    if (launchContinuation) {
      transitionDecision(ctx.db, prDeliveryId, 'building', 'building', {
        branch: launchContinuation.branch,
        prUrl: launchContinuation.prUrl,
        prNumber: launchContinuation.prNumber,
        prState: 'pr-created',
      })
    }
    broadcastPrState()
    syncOriginCard('post')
  }

  // Conventional branch naming (pr-naming): `<type>/<ref>-<kebab-title>`, the
  // Jira key prevailing over the local id when linked. Collisions with foreign
  // branches suffix `-2`… (bounded); a branch a PRIOR rail run allocated for
  // the SAME ticket is ours to resume, so it is NOT treated as a collision.
  // The integration branch is never used; exhaustion falls back to the legacy
  // `sr/<slug>/ticket-<id>` name. Snapshot under the lock so concurrent
  // launches see each other's just-created branches.
  const takenBranches = await listLocalBranches(git, baseRepo)
  const unitBranchName = (ticketId: number): string => {
    const continuation = launchContinuation && continuationTargets.get(ticketId)
    if (continuation) {
      takenBranches.add(continuation.branch)
      return continuation.branch
    }
    const preferred = ticketBranchName(unitNamingInput(ctx, ticketId))
    const branch = resolveCollisionFreeName(preferred, {
      taken: (name) => takenBranches.has(name) && !railWorktreeBranchExistsForTicket(ctx.db, ticketId, name),
      reserved: [integration.branch],
    }) ?? worktreeBranch(slug, ticketId)
    takenBranches.add(branch)
    return branch
  }

  try {
    for (const unit of units) {
      const continuationTarget = launchContinuation ? continuationTargets.get(unit.ticketId) ?? null : null
      const handle = await create(git, {
        repoDir: baseRepo,
        worktreesRoot,
        slug,
        ticketId: unit.ticketId,
        baseRef: continuationTarget?.baseRef ?? worktreeBaseRef.baseRef,
        branch: unitBranchName(unit.ticketId),
        refreshFromBaseRef: Boolean(continuationTarget?.baseRef),
      })
      // Per-run overlay: merge-link the framework surface the checkout didn't
      // bring into the worktree (idempotent; resume-safe via its manifest).
      let overlayExcludes: string[] = []
      try {
        const res = overlay({
          worktreePath: handle.worktreePath,
          sourceRoot: overlaySourceRoot,
          providerDir: overlayProviderDir,
          instructionsFilename: overlayInstructions,
        })
        overlayExcludes = res.createdPaths
        if (res.warnings.length > 0) notifyOverlayDegraded(unit.ticketId, res.warnings)
      } catch (err) {
        // applyWorktreeOverlay never throws; this guards injected test doubles
        // and future edits — the spawn proceeds regardless.
        notifyOverlayDegraded(unit.ticketId, [err instanceof Error ? err.message : String(err)])
      }
      // Code-Explorer provenance: freeze the worktree's pre-run state (HEAD sha
      // + the overlay's untracked set) so the settle diff attributes exactly
      // the run's own writes. Best-effort — a snapshot failure only loses
      // provenance, never the run.
      let provenanceSnapshot: WorkingTreeSnapshot | null = null
      if (isCodeExplorerEnabled()) {
        try {
          provenanceSnapshot = (io.snapshot ?? snapshotWorkingTree)(handle.worktreePath)
        } catch (err) {
          console.warn(`[rail-isolated] provenance snapshot failed: ${(err as Error).message}`)
        }
      }
      const runId = newId()
      const ledgerId = newId()
      createRailWorktree(ctx.db, {
        id: ledgerId, railIndex, ticketId: unit.ticketId, runId,
        branch: handle.branch, worktreePath: handle.worktreePath,
      })
      allocated.push({ ticketId: unit.ticketId, ticketIds: unit.ticketIds, runId, ledgerId, handle, overlayExcludes, provenanceSnapshot, continuationTarget })
    }
  } catch (err) {
    for (const a of allocated) {
      await remove(git, { repoDir: baseRepo, worktreePath: a.handle.worktreePath, branch: a.handle.branch }).catch(() => {})
    }
    // Close the just-inserted decision row (kept as 'discarded' for audit, never
    // deleted) so a wedged 'building' row can never block relaunching the slot.
    // Router-driven PR continuations may intentionally fall back to shared-cwd
    // on the same PR branch; in that case the router preserves and updates the
    // row as the live iteration card instead of showing a false discard.
    if (!input.preservePrDeliveryOnAllocationFailure && prDeliveryId && transitionDecision(ctx.db, prDeliveryId, 'building', 'discarded')) {
      broadcastPrState()
      syncOriginCard('update')
    }
    throw err
  }
  }) // withRepoLock — allocation done; the fan-out below runs in parallel.

  // 2. Fan out: one loop run per ticket, spawning IN its worktree. In PR mode a
  //    COMPLETED run's tickets park at on_review (the user decides done vs
  //    discard via the PR flow); failure outcomes ignore the field.
  const runFinishedOpts = { ticketCompletionStatus: prMode ? ('on_review' as const) : ('done' as const) }
  // Code-Explorer provenance at settle: diff the worktree against its pre-run
  // snapshot and record file_provenance/story rows (keyed by runId), exactly
  // like QueueManager's post-exit hook. Runs BEFORE commitWorktree so the
  // working tree still carries the run's uncommitted writes; recorded on the
  // failure path too (partial work is still provenance). Never throws.
  const recordProvenance = io.recordProvenance ?? recordLoopRunProvenance
  // Once per run: the .catch below also catches a commitWorktree failure thrown
  // AFTER the .then already recorded — without this guard that run would insert
  // duplicate provenance rows.
  const provenanceRecorded = new Set<string>()
  const recordRunProvenance = (a: AllocatedRun): void => {
    if (provenanceRecorded.has(a.runId)) return
    provenanceRecorded.add(a.runId)
    recordProvenance({
      db: ctx.db,
      projectId: ctx.project.id,
      runId: a.runId,
      ticketId: a.ticketId,
      repoDir: a.handle.worktreePath,
      snapshot: a.provenanceSnapshot,
      broadcast: (msg) => ctx.broadcast(msg),
    })
  }
  const runPromises: Promise<{ run: AllocatedRun; succeeded: boolean }>[] = []
  for (const a of allocated) {
    ctx.railLoopRuns.set(a.runId, { railIndex, ticketIds: a.ticketIds })
    const spec = ctx.getTicketSpec(a.ticketId)
    const p = ctx.loopRunManager
      .run({
        runId: a.runId, loopId, loopName, graph: loopGraph, projectId: ctx.project.id,
        cwd: a.handle.worktreePath, repoDir: a.handle.worktreePath,
        isolation: { branch: a.handle.branch, worktreePath: a.handle.worktreePath },
        railIndex, ticketId: a.ticketId,
        spec: spec ? { ...spec, ticketIds: a.ticketIds } : { ticketIds: a.ticketIds },
        constants, provider, model, effort,
      })
      .then(async (r) => {
        ctx.onLoopRunFinished(r.runId, r.outcome, runFinishedOpts)
        const succeeded = r.outcome === 'success'
        recordRunProvenance(a)
        // Commit the run's work to its branch so the merge-back can integrate it
        // (loops like autoloop-tdd don't commit) and a re-launch can resume it.
        // Overlay scaffolding is excluded — it must never reach the branch/PR.
        await commitWorktree(git, a.handle.worktreePath, worktreeCommitMessage(ctx, a.ticketId, a.runId), a.overlayExcludes)
        updateRailWorktreeState(ctx.db, a.ledgerId, succeeded ? 'built' : 'failed')
        return { run: a, succeeded }
      })
      .catch(async (err) => {
        console.error('[rail-isolated] loop run failed:', err)
        ctx.onLoopRunFinished(a.runId, 'failed', runFinishedOpts)
        recordRunProvenance(a)
        // Commit partial work too → durable in git → resumable on re-launch.
        await commitWorktree(git, a.handle.worktreePath, worktreeCommitMessage(ctx, a.ticketId, a.runId, true), a.overlayExcludes)
        updateRailWorktreeState(ctx.db, a.ledgerId, 'failed')
        return { run: a, succeeded: false }
      })
    runPromises.push(p)
    try { ctx.jiraSyncManager.onRailLaunch(a.ticketIds, a.runId) } catch { /* non-fatal */ }
  }

  // The fan-out just materialized the runs (each run's backing jobs row is
  // created synchronously at spawn) — persist their ids on the decision row
  // (order matches ticket order) and re-broadcast so the building card/strip
  // gains its per-run "View log" chips live. CAS on 'building' (a raced
  // alloc-failure discard must win); the settle patch leaves run_ids untouched.
  if (prDeliveryId && transitionDecision(ctx.db, prDeliveryId, 'building', 'building', { runIds: allocated.map((a) => a.runId) })) {
    broadcastPrState()
    syncOriginCard('update')
  }

  // 3. When ALL runs settle → integrate on the base repo (background; the HTTP
  //    response has already returned the run ids). Two mutually-exclusive paths:
  //     • DEFAULT (flag off): legacy local merge-back into the checked-out branch.
  //     • PR mode (SPECRAILS_RAIL_DELIVER_PR on, captured at entry): leave the
  //       work isolated on its branches and mark the decision row on_review —
  //       the draft PR is only created when the user clicks [Create PR] on the
  //       pr-decision endpoint (ask-first, safe-pr-review-flow).
  void Promise.allSettled(runPromises).then(async (settled) => {
    const results = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
    const branches: BranchToMerge[] = results.map((r) => ({
      ticketId: r.run.ticketId, branch: r.run.handle.branch, succeeded: r.succeeded,
    }))

    if (prMode) {
      // Build-settle: persist the per-unit branch outcomes + this launch's
      // worktree ledger ids on the row (the deferred create-pr / discard actions
      // reconstruct their inputs from these — nothing survives in memory), then
      // hand the decision to the user. 0 succeeded units → nothing deliverable;
      // keep the implementation card visible as a failed job state with run-log
      // chips instead of silently auto-discarding or leaving it at "building".
      const worktreeIds = allocated.map((a) => a.ledgerId)
      const anySucceeded = results.some((r) => r.succeeded)
      const settledContinuation = anySucceeded ? launchContinuation : null
      let continuationPushFailed = false
      let continuationPushFailureReason: string | null = null
      if (settledContinuation) {
        const pushed = await pushBranch(exec, {
          repoDir: baseRepo,
          branch: settledContinuation.branch,
          baseBranch: settledContinuation.baseBranch,
        })
        if (pushed.state === 'local-only') {
          continuationPushFailed = true
          continuationPushFailureReason = pushed.reason
          console.warn(`[rail-isolated] existing PR follow-up push failed for ${settledContinuation.branch}: ${continuationPushFailureReason}`)
        }
      }
      const next = anySucceeded
        ? (settledContinuation
            ? (continuationPushFailed
                ? 'pr_failed' as const
                : (settledContinuation.isDraft === false ? 'pr_ready' as const : 'pr_draft' as const))
            : 'on_review' as const)
        : 'implementation_failed' as const
      const patch = settledContinuation
        ? {
            branches,
            worktreeIds,
            branch: settledContinuation.branch,
            prUrl: settledContinuation.prUrl,
            prNumber: settledContinuation.prNumber,
            prState: continuationPushFailed ? 'local-only' as const : 'pr-created' as const,
          }
        : { branches, worktreeIds }
      if (prDeliveryId && transitionDecision(ctx.db, prDeliveryId, 'building', next, patch)) {
        if (settledContinuation && !continuationPushFailed) {
          await releaseRailWorktrees({ db: ctx.db, git, repoDir: baseRepo, worktreeIds })
        }
        broadcastPrState()
        // Completion driver: refresh the origin conversation's card in place —
        // on_review asks the question, discarded informs the outcome.
        syncOriginCard('update')
      }
      if (!anySucceeded) {
        // FAILED-IMPLEMENTATION CLEANUP (0 succeeded): unmount every worktree NOW rather
        // than leaving it for a restart's reconcile sweep — a still-mounted
        // worktree POISONS the next run of the same ticket: the worktree path is
        // keyed by ticketId, so the next allocation silently reuses this
        // checkout and its stale branch. BRANCHES are kept: per-run settle
        // committed partial work to them and a re-launch resumes a kept branch
        // by name (createWorktree's resume path); user-discard remains the one
        // explicit branch-deleting action. Ledger rows are already terminal
        // ('failed') from per-run settle — ensured defensively here.
        for (const a of allocated) {
          await remove(git, {
            repoDir: baseRepo, worktreePath: a.handle.worktreePath, branch: a.handle.branch, deleteBranch: false,
          }).catch(() => {})
          const wt = getRailWorktree(ctx.db, a.ledgerId)
          if (wt && !isTerminalMergeState(wt.merge_state)) updateRailWorktreeState(ctx.db, a.ledgerId, 'failed')
        }
      }
      return // legacy merge-back never runs in PR mode
    }

    try {
      const outcomes = await runMergeBack({
        git, executor: createLoopExecutors(), baseDir: baseRepo,
        provider, model, effort, constants, branches,
        // CRIT-2: record every merge-back AI step (verify/resolve-merge/fix) as a
        // `surface='job'` invocation tied to the rail (surface_ref_id
        // `${jobId}:merge:${step}`), primary ticket = ticketIds[0].
        recording: {
          db: ctx.db,
          projectId: ctx.project.id,
          jobId: `rail-${railIndex}-${loopId}`,
          ticketId: ticketIds[0] ?? null,
          broadcast: (msg) => ctx.broadcast(msg),
        },
        onState: (ticketId, state) => {
          const r = results.find((x) => x.run.ticketId === ticketId)
          if (state === 'merged' || state === 'needs-review') {
            if (r) updateRailWorktreeState(ctx.db, r.run.ledgerId, state)
            ctx.broadcast({ type: 'rail.worktree_progress', projectId: ctx.project.id, railIndex, ticketId, state })
          }
        },
      })
      for (const o of outcomes) {
        const r = results.find((x) => x.run.ticketId === o.ticketId)
        if (!r) continue
        // Merged → drop the branch; needs-review / skipped → keep the branch for the human.
        await remove(git, {
          repoDir: baseRepo, worktreePath: r.run.handle.worktreePath, branch: o.branch,
          deleteBranch: o.state === 'merged',
        }).catch(() => {})
      }
    } catch (err) {
      console.error('[rail-isolated] merge-back failed:', err)
    }
  })

  return allocated.map((a) => a.runId)
}

/**
 * Startup reconciliation: a crash mid-fan-out leaves worktrees on disk and ledger
 * rows stuck in a non-terminal state. Remove each orphan's worktree (best-effort,
 * keeping its branch for inspection) and mark the row `failed`. No-op (no git
 * calls) when there are no stuck rows — so it is free for projects that never used
 * isolation. Returns how many rows were reconciled.
 */
export async function reconcileRailWorktrees(
  db: DbInstance,
  repoDir: string,
  io: { git?: GitRunner; remove?: typeof removeWorktree } = {}
): Promise<number> {
  const git = io.git ?? defaultGitRunner
  const remove = io.remove ?? removeWorktree
  const stuck = listNonTerminalRailWorktrees(db)
  for (const row of stuck) {
    await remove(git, { repoDir, worktreePath: row.worktree_path, branch: row.branch, deleteBranch: false }).catch(() => {})
    updateRailWorktreeState(db, row.id, 'failed')
  }
  return stuck.length
}
