/**
 * Admission and launch of one loop run: freezes the request, resolves the
 * run's guards, commits the loop run + backing job (and ticket ownership) in
 * one transaction before any executor starts, writes the run header and graph
 * snapshot, and binds the per-run soft cap.
 */
import { createJob, type DbInstance } from '../../../db'
import { validateRuntimeProviderOverride } from '../../agent-runtime/runtime/agent-runtime-settings'
import { claimRailTickets, claimTicketOutcomeOwners } from '../../delivery/runtime/rails-store'
import type { ProviderAdapter } from '../../../providers/types'
import { recordLegacyLaunch } from './legacy-launch-telemetry'
import { assertLoopFailureRecovery, assertLoopShellRepositoryScope } from './loop-graph'
import { resolveLoopStepIdleTimeoutMs } from './loop-step-idle'
import { createLoopRun, readLoopRunCap, resumeLoopRun, saveDefinitionRun, writeLoopRunCap } from './loop-runs-store'
import type { LoopRunContext, LoopRunLimits } from './loop-run-context'
import type { LoopGraphEventPayload, LoopRunRequest } from './loop-run-contract'

/** Deep-clone everything a run reads later so the caller (or a backlog/loop
 *  edit) cannot change an admitted run, and reject unsafe shell scopes. */
export function normalizeLoopRunRequest(input: LoopRunRequest): LoopRunRequest {
  // Later fresh steps must verify the admitted spec, even if its caller or
  // backlog changes while the implementation is running.
  let req = { ...input, runtimeProviderOverride: validateRuntimeProviderOverride(input.runtimeProviderOverride), graph: structuredClone(input.graph) }
  assertLoopFailureRecovery(req.graph)
  if (req.addenda) req = { ...req, addenda: structuredClone(req.addenda) }
  if (req.followUp) req = { ...req, followUp: structuredClone(req.followUp) }
  if (req.constants) req = { ...req, constants: structuredClone(req.constants) }
  if (req.spec) req = { ...req, spec: structuredClone(req.spec) }
  if (req.executionManifest) req = { ...req, executionManifest: structuredClone(req.executionManifest) }
  assertLoopShellRepositoryScope(req.graph, req.executionManifest?.selectedRepositoryIds ?? (req.repositoryId ? [req.repositoryId] : []))
  if (req.executionManifest) {
    for (const node of req.graph.nodes) {
      if (node.type !== 'shell') continue
      const repositoryId = node.data?.repositoryId
      if (typeof repositoryId !== 'string' || !req.executionManifest.repositories.some((repo) => repo.repositoryId === repositoryId)) {
        throw new Error(`Shell step ${node.id} requires an explicit selected repositoryId for this execution`)
      }
    }
  }
  return req
}

export function resolveRunLimits(req: LoopRunRequest, usageTelemetryAvailable: boolean, now: number, idleTimeoutOverride: number | undefined): LoopRunLimits & { deadline: number } {
  const maxIterations = req.graph.config.maxIterations
  // 0 ⇒ no whole-run deadline (built-in pipeline loops opt out of the wall
  // clock; maxIterations / maxCostUsd remain the runaway guards).
  const deadline = req.graph.config.timeoutMinutes > 0
    ? now + req.graph.config.timeoutMinutes * 60_000
    : Infinity
  // Per-step AI timeout (ms) — undefined falls back to the executor default,
  // 0 disables the per-step watchdog entirely.
  const aiStepTimeoutMs = req.graph.config.aiStepTimeoutMinutes != null
    ? req.graph.config.aiStepTimeoutMinutes * 60_000
    : undefined
  // Inactivity bound for every AI step (loop-step-idle): an UNTIMED step is
  // still bounded by silence, so a wedged provider never leaves the run
  // `running` forever. 0 ⇒ disabled.
  const idleTimeoutMs = idleTimeoutOverride ?? resolveLoopStepIdleTimeoutMs({
    ...process.env,
    // Preserve installations configured with the previous watchdog name.
    SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS: process.env.SPECRAILS_LOOP_STEP_IDLE_TIMEOUT_MS ?? process.env.SPECRAILS_LOOP_INACTIVITY_MS,
  })
  // Optional cost cap (USD). Like maxIterations/timeout, it's a BETWEEN-STEPS
  // guard: per-step cost is only known when that step's process exits, so the
  // loop is stopped before the NEXT step once the accumulated total crosses the
  // cap (may overshoot by at most one step). Honest accuracy caveat: for
  // non-Claude providers the per-step cost is ESTIMATED (rate card) — see the
  // fail-open warning below when a step yields no priced cost.
  const configuredMaxCostUsd = typeof req.graph.config.maxCostUsd === 'number' && req.graph.config.maxCostUsd > 0
    ? req.graph.config.maxCostUsd
    : undefined
  // A cap with no observable usage is not a guard at all. Disable it rather
  // than pretending an unknown bill is $0 and surface the limitation in the
  // run log below.
  const maxCostUsd = usageTelemetryAvailable ? configuredMaxCostUsd : undefined
  return { maxIterations, deadline, aiStepTimeoutMs, idleTimeoutMs, configuredMaxCostUsd, maxCostUsd }
}

/** Commit the loop run, its backing job and ticket ownership together, before
 *  any spawn; a continuation instead reopens the retained run and job. */
export function persistLoopRunLaunch(db: DbInstance, input: {
  req: LoopRunRequest
  runId: string
  exactTicketIds: number[]
  definitionEngine: boolean
  maxIterations: number
  startedAt: string
  continuation: boolean
}): void {
  const { req, runId, exactTicketIds, definitionEngine, maxIterations, startedAt: launchStartedAt } = input
  const jobCommand = `loop: ${req.loopName ?? req.loopId}${req.ticketId != null ? ` #${req.ticketId}` : ''}`
  const persistLaunch = db.transaction(() => {
    claimTicketOutcomeOwners(db, exactTicketIds, runId)
    if (req.railIndex != null && exactTicketIds.length > 0) {
      claimRailTickets(db, req.railIndex, exactTicketIds, runId)
    }
    createLoopRun(db, {
      id: runId,
      projectId: req.projectId,
      loopId: req.loopId,
      loopName: req.loopName ?? null,
      railIndex: req.railIndex ?? null,
      ticketId: req.ticketId ?? null,
      provider: req.provider,
      model: req.model,
      reasoningEffort: req.effort ?? null,
      ticketIds: exactTicketIds,
      ticketCompletionStatus: req.ticketCompletionStatus ?? 'done',
      causalOwnership: true,
      iterationLimit: maxIterations,
      startedAt: launchStartedAt,
    })
    if (definitionEngine) saveDefinitionRun(db, runId, { request: req, source: 'definition' })
    if (req.launchConfig) db.prepare('UPDATE loop_runs SET launch_config_json = ? WHERE id = ?').run(JSON.stringify(req.launchConfig), runId)
    if (req.executionManifest) db.prepare('UPDATE loop_runs SET execution_manifest = ? WHERE id = ?').run(JSON.stringify(req.executionManifest), runId)
    createJob(db, {
      id: runId,
      command: jobCommand,
      started_at: launchStartedAt,
      provider: req.provider,
      owner: 'loop',
      causal_ownership: true,
    })
    if (!definitionEngine) recordLegacyLaunch(db, { kind: 'legacy_loop_traversal', projectId: req.projectId, runId, at: launchStartedAt })
  })
  if (input.continuation) {
    resumeLoopRun(db, runId)
    db.prepare("UPDATE jobs SET status='running',finished_at=NULL,exit_code=NULL WHERE id=? AND owner='loop'").run(runId)
  } else persistLaunch()
}

/** The run's first event seq: 0 for a fresh job row, after the last persisted
 *  event for a continuation. */
export function initialEventSeq(db: DbInstance, runId: string, continuation: boolean): number {
  return continuation ? Number((db.prepare('SELECT COALESCE(MAX(seq),-1)+1 AS next FROM events WHERE job_id=?').get(runId) as { next: number }).next) : 0
}

/** Run banner, isolation/environment notices and the graph snapshot. */
export function writeRunHeader(ctx: LoopRunContext, adapter: ProviderAdapter): void {
  const { host, req, runId, state } = ctx
  const { logLine, emitRunEvent } = ctx.events
  logLine(`▶ Loop "${req.loopName ?? req.loopId}" started${req.spec?.title ? ` — spec: ${req.spec.title}` : ''}`)
  if (req.isolation) logLine(`⎇ Isolated worktree: ${req.isolation.worktreePath} (branch ${req.isolation.branch})`)
  if (!ctx.continuation) for (const notice of req.launchNotices ?? []) logLine(notice)
  let environmentNotice: string | null = null
  try { environmentNotice = host.executors.environmentNotice?.() ?? null } catch { /* diagnostic only */ }
  if (environmentNotice) logLine(environmentNotice, 'stderr')
  if (!ctx.definitionEngine && !state.usageTelemetryAvailable) {
    logLine(
      `⚠️ ${adapter.displayName} does not report token/cost usage in headless mode; usage totals will remain unavailable.` +
        (ctx.limits.configuredMaxCostUsd !== undefined
          ? ' The configured maxCostUsd guard is disabled because it cannot be verified.'
          : ''),
      'stderr',
    )
  }
  // Per-run graph SNAPSHOT — once, before the first loop_step — so a later
  // edit/delete of the loop never breaks the historical replay of this run.
  const graphPayload: LoopGraphEventPayload = {
    graph: req.graph,
    loopId: req.loopId,
    loopName: req.loopName ?? req.loopId,
    provider: req.provider,
    model: req.model,
    iterationLimit: ctx.limits.maxIterations,
  }
  if (!ctx.continuation) emitRunEvent('loop_graph', graphPayload)
  console.log(`[loop] start run=${runId} loop=${req.loopId} provider=${req.provider} model=${req.model} nodes=${req.graph.nodes.length} cwd=${req.cwd}`)
}

/** Per-run soft cap ("pause and ask at $X"): this launch's override, else what
 *  the run was already given (a restart keeps the person's choice), else the
 *  project/app default. The cost read is the run's provider-reported total. */
/** The run's turns by cost: one physical provider call each (a multi-ticket call is split per ticket and summed back). */
export function readRunTurnCosts(db: LoopRunContext['host']['db'], runId: string): { largestUsd: number | null; lastUsd: number | null } {
  const rows = db.prepare(`SELECT SUM(total_cost_usd) AS cost, MAX(finished_at) AS at FROM ai_invocations
    WHERE loop_run_id = ? AND total_cost_usd IS NOT NULL GROUP BY COALESCE(surface_ref_id, id) ORDER BY at DESC`).all(runId) as Array<{ cost: number; at: string | null }>
  if (!rows.length) return { largestUsd: null, lastUsd: null }
  return { largestUsd: Math.max(...rows.map(row => row.cost)), lastUsd: rows[0]!.cost }
}

export function bindRunCap(ctx: LoopRunContext): void {
  const { host, req, runId, state } = ctx
  let cap: number | null = null
  try {
    const stored = readLoopRunCap(host.db, runId)
    // A resumed run keeps what it was given (and what the person decided
    // since): the frozen request's override applies to a FRESH launch only.
    const override = !ctx.continuation && req.runCapUsd !== undefined ? req.runCapUsd : undefined
    if (override !== undefined) cap = override > 0 ? override : null
    else if (stored !== undefined) cap = stored > 0 ? stored : null
    else cap = host.options.runCapDefault?.() ?? null
    if (override !== undefined || stored === undefined) writeLoopRunCap(host.db, runId, cap ?? 0)
  } catch { cap = null }
  host.trackRunCap(runId, { capUsd: cap, cost: () => state.totalCost, turns: () => readRunTurnCosts(host.db, runId) })
}
