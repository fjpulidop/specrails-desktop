/**
 * Loop runs store — per-project record (jobs.sqlite `loop_runs`) of each
 * executed loop. The manager creates a row at launch, updates counters as it
 * iterates, and finalises it at the end. Powers loop analytics + the
 * active derived state (a loop is active iff a row here has status='running'
 * or status='paused').
 */
import path from 'path'
import type { DbInstance } from '../../../db'
import type { LoopRunRequest } from './loop-run-manager'

export type LoopRunStatus = 'running' | 'paused' | 'completed'
// `blocked` — halted on a human decision the Decider flagged (not a failure,
// not done). `stalled` — aborted after consecutive iterations made zero change
// to the working tree (non-convergence guard). Both are terminal + distinct
// from `success` so metrics never count a stuck run as a win.
export type LoopRunOutcome = 'success' | 'max-iterations' | 'max-cost' | 'stopped' | 'failed' | 'blocked' | 'stalled'

export interface LoopRunRow {
  id: string
  project_id: string
  loop_id: string
  loop_name: string | null
  rail_index: number | null
  ticket_id: number | null
  provider: string | null
  model: string | null
  reasoning_effort: string | null
  status: LoopRunStatus
  final_outcome: LoopRunOutcome | null
  iteration_limit: number
  iteration_count: number
  total_cost_usd: number
  total_tokens: number
  total_duration_ms: number
  started_at: string
  finished_at: string | null
  created_at: string
  /** Exact launch ownership. Added in migration 45; old rows read as []. */
  ticket_ids_json?: string
  ticket_completion_status?: 'done' | 'on_review'
  causal_ownership?: number
  engine_version?: number | null
  run_request_json?: string | null
  runtime_metadata_json?: string | null
  runtime_status_json?: string | null
  core_revision?: number | null
  core_event_cursor?: number | null
  fork_of?: string | null
  fork_cut_json?: string | null
  restart_reason?: string | null
}

export interface DefinitionRunMetadata {
  source: 'definition'
  contextPath?: string
  definitionPath?: string
  definitionHash?: string
  workflowId?: string
  definition?: Record<string, unknown>
  configPath?: string
  runtimeDirectory?: string
  context?: Record<string, unknown>
  runtimeIdentity?: Record<string, unknown>
}
export interface DefinitionRunSnapshot {
  row: LoopRunRow
  request: LoopRunRequest
  metadata: DefinitionRunMetadata
}
export interface DefinitionCheckpoint {
  revision?: number
  eventCursor?: number
  status?: string
  pendingInterrupts?: unknown[]
  recoverableSteps?: unknown[]
  [key: string]: unknown
}

function frozenJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item)) throw new Error('Durable workflow inputs must contain only JSON data')
    return item
  })
  if (!serialized || Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error('Durable workflow inputs exceed 4 MiB')
  const sort = (input: unknown): unknown => Array.isArray(input) ? input.map(sort) : input && typeof input === 'object'
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sort(item)])) : input
  return JSON.stringify(sort(JSON.parse(serialized)))
}

/** Freeze launch data before spawn; preparation may add fields, never replace them. */
export function saveDefinitionRun(db: DbInstance, runId: string, input: Partial<DefinitionRunMetadata> & { request?: LoopRunRequest }): DefinitionRunSnapshot {
  return db.transaction(() => {
    const row = getLoopRun(db, runId)
    if (!row || row.engine_version !== null && row.engine_version !== undefined && row.engine_version !== 2) throw new Error('Definition run is missing or belongs to another engine')
    const { request, ...fields } = input
    const requestJson = request ? frozenJson({ ...request, runId }) : row.run_request_json
    if (!requestJson || row.run_request_json && row.run_request_json !== requestJson) throw new Error('Frozen loop request cannot change')
    const normalized = JSON.parse(requestJson) as LoopRunRequest
    if (normalized.projectId !== row.project_id || normalized.loopId !== row.loop_id) throw new Error('Frozen loop request belongs to another project or loop')
    const prior = JSON.parse(row.runtime_metadata_json ?? '{"source":"definition"}') as DefinitionRunMetadata
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && key in prior && frozenJson(prior[key as keyof DefinitionRunMetadata]) !== frozenJson(value)) throw new Error('Frozen Core metadata cannot change: ' + key)
    }
    const metadata = { ...prior, ...JSON.parse(frozenJson(fields)) }
    if (metadata.source !== 'definition' || metadata.definitionHash !== undefined && !/^[a-f0-9]{64}$/.test(metadata.definitionHash)) throw new Error('Invalid Core definition identity')
    db.prepare('UPDATE loop_runs SET engine_version=2,run_request_json=?,runtime_metadata_json=? WHERE id=?').run(requestJson, frozenJson(metadata), runId)
    return { row: getLoopRun(db, runId)!, request: normalized, metadata }
  })()
}

export function readDefinitionRun(db: DbInstance, runId: string): DefinitionRunSnapshot | undefined {
  const row = getLoopRun(db, runId)
  if (!row || row.engine_version !== 2 || !row.run_request_json) return undefined
  const request = JSON.parse(row.run_request_json) as LoopRunRequest, metadata = JSON.parse(row.runtime_metadata_json ?? '{"source":"definition"}') as DefinitionRunMetadata
  if (request.runId !== runId || request.projectId !== row.project_id || request.loopId !== row.loop_id || metadata.source !== 'definition') throw new Error('Frozen workflow ownership is inconsistent')
  return { row, request, metadata }
}

/** The projection cursor is independent of the aggregate accounting totals. */
export function recordDefinitionCheckpoint(db: DbInstance, runId: string, checkpoint: DefinitionCheckpoint): void {
  for (const value of [checkpoint.revision, checkpoint.eventCursor]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Core checkpoint cursors must be nonnegative integers')
  const serialized = frozenJson(checkpoint)
  db.transaction(() => {
    const row = readDefinitionRun(db, runId)?.row
    if (!row) throw new Error('Frozen definition run is missing')
    if (checkpoint.revision !== undefined && checkpoint.revision < (row.core_revision ?? 0) || checkpoint.eventCursor !== undefined && checkpoint.eventCursor < (row.core_event_cursor ?? 0)) return
    db.prepare('UPDATE loop_runs SET core_revision=?,core_event_cursor=?,runtime_status_json=? WHERE id=?')
      .run(checkpoint.revision ?? row.core_revision ?? null, checkpoint.eventCursor ?? row.core_event_cursor ?? null, serialized, runId)
  })()
}

/** Startup preserves the job and launch ownership; no terminal callback is queued. */
export function markDefinitionRestart(db: DbInstance, runId: string, checkpoint: DefinitionCheckpoint = {}): void {
  db.transaction(() => {
    if (!readDefinitionRun(db, runId)) throw new Error('Frozen definition run is missing')
    recordDefinitionCheckpoint(db, runId, checkpoint)
    db.prepare("UPDATE loop_runs SET status='paused',final_outcome=NULL,finished_at=NULL,restart_reason='restart' WHERE id=? AND status IN ('running','paused')").run(runId)
  })()
}

export interface DefinitionExecutionClaimInput {
  /** The live process/manager identity holding the worktree. */
  owner: string
  /** Every checkout the run may write to (worktrees, relocated repo, spawn cwd). */
  repositoryMounts: string[]
  /** The source run a fork child is launched from (its worktree is shared). */
  parentRunId?: string
}
export type DefinitionExecutionClaim =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'active_owner' | 'lineage_conflict'; conflictingRunId: string }

interface ClaimRow { run_id: string; owner: string; repository_mounts_json: string }

function normalizeMount(mount: string): string {
  const resolved = path.resolve(mount)
  const trimmed = resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}
function mountsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
}
function parseMounts(raw: string): string[] {
  try { const parsed = JSON.parse(raw) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [] } catch { return [] }
}
/** Direct fork ancestry of a run: itself, its parents up the fork_of chain and every descendant. */
function definitionLineageIds(db: DbInstance, runId: string, parentRunId?: string): Set<string> {
  const lineage = new Set<string>()
  const parents = db.prepare('SELECT fork_of FROM loop_runs WHERE id = ?')
  const children = db.prepare('SELECT id FROM loop_runs WHERE fork_of = ?')
  const queue = [runId, ...(parentRunId ? [parentRunId] : [])]
  while (queue.length) {
    const current = queue.shift()!
    if (lineage.has(current)) continue
    lineage.add(current)
    const parent = (parents.get(current) as { fork_of: string | null } | undefined)?.fork_of
    if (parent && !lineage.has(parent)) queue.push(parent)
    for (const child of children.all(current) as Array<{ id: string }>) if (!lineage.has(child.id)) queue.push(child.id)
  }
  return lineage
}

/** The checkouts a frozen request may write to. Nested paths share a mount. */
export function definitionRepositoryMounts(request: Pick<LoopRunRequest, 'cwd' | 'repoDir' | 'executionManifest' | 'isolation'>): string[] {
  const mounts = [
    ...(request.executionManifest?.repositories.map(repository => repository.worktreePath) ?? []),
    ...(request.isolation ? [request.isolation.worktreePath] : []),
    ...(request.executionManifest ? [] : [request.repoDir ?? request.cwd]),
  ].filter((mount): mount is string => typeof mount === 'string' && mount.length > 0)
  return [...new Set(mounts.map(normalizeMount))].sort()
}

/**
 * Synchronous, atomic admission for one Core process over a worktree. A live
 * claim of another run that overlaps any repository mount rejects: a parent
 * and its fork share the checkout, and two owners of the same run are never
 * allowed. Paused rows are not claims; only a resident process holds one, and
 * settlement, cancellation and restart reconciliation release it.
 */
export function claimDefinitionExecution(db: DbInstance, runId: string, claim: DefinitionExecutionClaimInput): DefinitionExecutionClaim {
  if (!runId || !claim.owner) throw new Error('Execution claims require a run and an owner')
  const mounts = [...new Set(claim.repositoryMounts.map(normalizeMount))].sort()
  return db.transaction((): DefinitionExecutionClaim => {
    const existing = db.prepare('SELECT run_id, owner, repository_mounts_json FROM definition_execution_claims WHERE run_id = ?').get(runId) as ClaimRow | undefined
    if (existing) return { ok: false, reason: 'active_owner', conflictingRunId: runId }
    if (mounts.length) {
      const lineage = definitionLineageIds(db, runId, claim.parentRunId)
      const live = db.prepare('SELECT run_id, owner, repository_mounts_json FROM definition_execution_claims ORDER BY claimed_at, run_id').all() as ClaimRow[]
      for (const row of live) {
        const overlap = parseMounts(row.repository_mounts_json).some(mount => mounts.some(candidate => mountsOverlap(candidate, mount)))
        if (!overlap) continue
        return { ok: false, reason: lineage.has(row.run_id) ? 'lineage_conflict' : 'active_owner', conflictingRunId: row.run_id }
      }
    }
    const at = new Date().toISOString()
    db.prepare('INSERT INTO definition_execution_claims (run_id, owner, repository_mounts_json, claimed_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, claim.owner, JSON.stringify(mounts), at, at)
    return { ok: true, release: () => releaseDefinitionExecution(db, runId, claim.owner) }
  })()
}

/** Idempotent: only the owner that holds the claim can release it. */
export function releaseDefinitionExecution(db: DbInstance, runId: string, owner: string): void {
  db.prepare('DELETE FROM definition_execution_claims WHERE run_id = ? AND owner = ?').run(runId, owner)
}

export function readDefinitionExecutionClaim(db: DbInstance, runId: string): { runId: string; owner: string; repositoryMounts: string[]; claimedAt: string; heartbeatAt: string } | undefined {
  const row = db.prepare('SELECT * FROM definition_execution_claims WHERE run_id = ?').get(runId) as (ClaimRow & { claimed_at: string; heartbeat_at: string }) | undefined
  return row ? { runId: row.run_id, owner: row.owner, repositoryMounts: parseMounts(row.repository_mounts_json), claimedAt: row.claimed_at, heartbeatAt: row.heartbeat_at } : undefined
}

export interface DefinitionLineage {
  runId: string
  forkOf: string | null
  children: string[]
  forkCut: unknown | null
}

export function readDefinitionLineage(db: DbInstance, runId: string): DefinitionLineage {
  const row = getLoopRun(db, runId)
  let forkCut: unknown = null
  if (row?.fork_cut_json) { try { forkCut = JSON.parse(row.fork_cut_json) as unknown } catch { forkCut = null } }
  const children = (db.prepare('SELECT id FROM loop_runs WHERE fork_of = ? ORDER BY started_at, id').all(runId) as Array<{ id: string }>).map(child => child.id)
  return { runId, forkOf: row?.fork_of ?? null, children, forkCut }
}

/** Persist fork ancestry and Core cut provenance on a NEW child row. The source row is never touched. */
export function linkDefinitionFork(db: DbInstance, childRunId: string, link: { forkOf: string; forkCut: Record<string, unknown> }): void {
  db.transaction(() => {
    const child = readDefinitionRun(db, childRunId)
    if (!child) throw new Error('Forked definition run is missing')
    if (childRunId === link.forkOf || !getLoopRun(db, link.forkOf)) throw new Error('Fork source is missing or identical to the child')
    if (child.row.fork_of && child.row.fork_of !== link.forkOf) throw new Error('Fork ancestry cannot change')
    db.prepare('UPDATE loop_runs SET fork_of = ?, fork_cut_json = ? WHERE id = ?').run(link.forkOf, frozenJson(link.forkCut), childRunId)
  })()
}

export interface CreateLoopRunInput {
  id: string
  projectId: string
  loopId: string
  loopName?: string | null
  railIndex?: number | null
  ticketId?: number | null
  provider?: string | null
  model?: string | null
  reasoningEffort?: string | null
  ticketIds?: number[]
  ticketCompletionStatus?: 'done' | 'on_review'
  causalOwnership?: boolean
  iterationLimit: number
  startedAt: string
}

export interface LoopRunCounters {
  iterationCount: number
  totalCostUsd: number
  totalTokens: number
  totalDurationMs: number
}

export function createLoopRun(db: DbInstance, input: CreateLoopRunInput): LoopRunRow {
  db.prepare(`
    INSERT INTO loop_runs (
      id, project_id, loop_id, loop_name, rail_index, ticket_id, provider, model,
      reasoning_effort, ticket_ids_json, ticket_completion_status,
      causal_ownership, status,
      iteration_limit, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(
    input.id,
    input.projectId,
    input.loopId,
    input.loopName ?? null,
    input.railIndex ?? null,
    input.ticketId ?? null,
    input.provider ?? null,
    input.model ?? null,
    input.reasoningEffort ?? null,
    JSON.stringify([...new Set(input.ticketIds ?? (input.ticketId == null ? [] : [input.ticketId]))]),
    input.ticketCompletionStatus ?? 'done',
    input.causalOwnership ? 1 : 0,
    input.iterationLimit,
    input.startedAt,
  )
  return getLoopRun(db, input.id)!
}

export interface LoopTerminalRecoveryPayload {
  version: 1
  runId: string
  projectId: string
  ticketIds: number[]
  railIndex: number | null
  outcome: LoopRunOutcome
  jobStatus: 'completed' | 'failed' | 'canceled'
  ticketCompletionStatus: 'done' | 'on_review'
  finishedAt: string
  /** New launches claimed ticket+rail ownership before spawn. False only for
   * pre-migration rows reconstructed through the legacy heuristic. */
  causalOwnership: boolean
  outcomeFinalized?: boolean
}

export interface LoopTerminalRecoveryRow {
  run_id: string
  payload: string
  callback_completed: number
  created_at: string
}

export interface LoopJobTerminalTotals {
  exitCode: number
  status: 'completed' | 'failed' | 'canceled'
  totalCostUsd: number | null
  tokensIn: number | null
  tokensOut: number | null
  tokensCacheRead: number | null
  tokensCacheCreate: number | null
  durationMs: number
  numTurns: number | null
}

function parseTicketIdsJson(raw: string | null | undefined): number[] {
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0))]
  } catch {
    return []
  }
}

/** Finalise the engine row, backing job and durable domain callback intent in
 * one commit. A caller may crash anywhere after this returns; startup can still
 * replay the exact launch ticket set without consulting an in-memory rail map. */
export function finishLoopRunAndJob(
  db: DbInstance,
  id: string,
  opts: {
    outcome: LoopRunOutcome
    finishedAt: string
    counters: LoopRunCounters
    job: LoopJobTerminalTotals
    callbackOutcome?: LoopRunOutcome
    outcomeFinalized?: boolean
  },
): LoopTerminalRecoveryPayload | undefined {
  const tx = db.transaction(() => {
    const run = getLoopRun(db, id)
    if (!run) return undefined
    updateLoopRunCounters(db, id, opts.counters)
    db.prepare(`
      UPDATE loop_runs
         SET status = 'completed', final_outcome = ?, finished_at = ?
       WHERE id = ?
    `).run(opts.outcome, opts.finishedAt, id)
    db.prepare(`
      UPDATE jobs
         SET exit_code = ?, status = ?, finished_at = ?,
             total_cost_usd = CASE WHEN EXISTS (
               SELECT 1 FROM loop_step_recovery WHERE run_id = ?
             ) THEN total_cost_usd ELSE ? END,
             tokens_in = CASE WHEN EXISTS (
               SELECT 1 FROM loop_step_recovery WHERE run_id = ?
             ) THEN tokens_in ELSE ? END,
             tokens_out = CASE WHEN EXISTS (
               SELECT 1 FROM loop_step_recovery WHERE run_id = ?
             ) THEN tokens_out ELSE ? END,
             tokens_cache_read = CASE WHEN EXISTS (
               SELECT 1 FROM loop_step_recovery WHERE run_id = ?
             ) THEN tokens_cache_read ELSE ? END,
             tokens_cache_create = CASE WHEN EXISTS (
               SELECT 1 FROM loop_step_recovery WHERE run_id = ?
             ) THEN tokens_cache_create ELSE ? END,
             duration_ms = CASE WHEN EXISTS (
               SELECT 1 FROM loop_step_recovery WHERE run_id = ?
             ) THEN duration_ms ELSE ? END,
             num_turns = CASE WHEN EXISTS (
               SELECT 1 FROM loop_step_recovery WHERE run_id = ?
             ) THEN num_turns ELSE ? END
       WHERE id = ? AND owner = 'loop'
    `).run(
      opts.job.exitCode,
      opts.job.status,
      opts.finishedAt,
      id,
      opts.job.totalCostUsd,
      id,
      opts.job.tokensIn,
      id,
      opts.job.tokensOut,
      id,
      opts.job.tokensCacheRead,
      id,
      opts.job.tokensCacheCreate,
      id,
      opts.job.durationMs,
      id,
      opts.job.numTurns,
      id,
    )
    const payload: LoopTerminalRecoveryPayload = {
      version: 1,
      runId: id,
      projectId: run.project_id,
      ticketIds: parseTicketIdsJson(run.ticket_ids_json),
      railIndex: run.rail_index,
      outcome: opts.callbackOutcome ?? opts.outcome,
      jobStatus: opts.job.status,
      ticketCompletionStatus: run.ticket_completion_status ?? 'done',
      finishedAt: opts.finishedAt,
      causalOwnership: run.causal_ownership === 1,
      outcomeFinalized: opts.outcomeFinalized ?? true,
    }
    db.prepare(`
      INSERT INTO loop_terminal_recovery (run_id, payload, callback_completed)
      VALUES (?, ?, 0)
      ON CONFLICT(run_id) DO UPDATE SET
        payload = excluded.payload,
        callback_completed = CASE
          WHEN loop_terminal_recovery.callback_completed = 1 THEN 1 ELSE 0 END
    `).run(id, JSON.stringify(payload))
    return payload
  })
  return tx() as LoopTerminalRecoveryPayload | undefined
}

export function listPendingLoopTerminalRecoveries(db: DbInstance): LoopTerminalRecoveryRow[] {
  return db.prepare(`
    SELECT run_id, payload, callback_completed, created_at
      FROM loop_terminal_recovery
     WHERE callback_completed = 0
     ORDER BY created_at, run_id
  `).all() as LoopTerminalRecoveryRow[]
}

export function getLoopTerminalRecovery(db: DbInstance, runId: string): LoopTerminalRecoveryRow | undefined {
  return db.prepare(`SELECT * FROM loop_terminal_recovery WHERE run_id = ?`).get(runId) as LoopTerminalRecoveryRow | undefined
}

export function completeLoopTerminalRecovery(db: DbInstance, runId: string): void {
  db.prepare(`UPDATE loop_terminal_recovery SET callback_completed = 1 WHERE run_id = ?`).run(runId)
  db.prepare(`DELETE FROM loop_terminal_recovery WHERE run_id = ? AND callback_completed = 1`).run(runId)
}

export interface LoopUsageSnapshot {
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheCreate: number
  totalCostUsd: number
  numTurns: number
}

export interface LoopStepRecoveryPayload {
  version: 1
  runId: string
  stepKey: string
  invocationId: string
  projectId: string
  provider: string
  model: string | null
  surfaceRefId: string
  ticketIds: number[]
  /** Compatibility with checkpoints written by an earlier WIP build. */
  ticketId?: number | null
  startedAt: string
  baseline: LoopUsageSnapshot
  completedEventSeq: number
  providerCostBaseline: number
  providerTurnsBaseline: number
  loopDurationBaseline: number
  completedDurationMs: number
  /** Iteration already entered by this step. Deciders increment before staging,
   * so startup replay can restore the durable loop counter after a hard crash. */
  iterationCount?: number
  /** Active turn wall-clock checkpoint. Updated before stdin delivery and on
   * raw activity; cleared atomically when a result frontier commits. */
  activeTurnStartedAtMs?: number
  lastActivityAtMs?: number
  settledResult?: {
    cost?: number; tokens?: number; tokensIn?: number; tokensOut?: number
    tokensCacheRead?: number; tokensCacheCreate?: number; durationMs?: number
    durationApiMs?: number; numTurns?: number; sessionId?: string
    provider?: string; model?: string; estimated?: boolean; failed?: boolean
  }
}

export interface LoopStepRecoveryRow {
  run_id: string
  step_key: string
  invocation_id: string
  payload: string
}

export function readLoopJobUsage(db: DbInstance, runId: string): LoopUsageSnapshot {
  const row = db.prepare(`
    SELECT tokens_in, tokens_out, tokens_cache_read, tokens_cache_create,
           total_cost_usd, num_turns
      FROM jobs WHERE id = ?
  `).get(runId) as {
    tokens_in: number | null; tokens_out: number | null
    tokens_cache_read: number | null; tokens_cache_create: number | null
    total_cost_usd: number | null; num_turns: number | null
  } | undefined
  return {
    tokensIn: row?.tokens_in ?? 0,
    tokensOut: row?.tokens_out ?? 0,
    tokensCacheRead: row?.tokens_cache_read ?? 0,
    tokensCacheCreate: row?.tokens_cache_create ?? 0,
    totalCostUsd: row?.total_cost_usd ?? 0,
    numTurns: row?.num_turns ?? 0,
  }
}

export function stageLoopStepRecovery(db: DbInstance, payload: LoopStepRecoveryPayload): void {
  db.prepare(`
    INSERT INTO loop_step_recovery (run_id, step_key, invocation_id, payload)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id, step_key) DO NOTHING
  `).run(payload.runId, payload.stepKey, payload.invocationId, JSON.stringify(payload))
}

export function updateLoopStepEventCheckpoint(
  db: DbInstance,
  runId: string,
  stepKey: string,
  completedEventSeq: number,
  providerCostBaseline?: number,
  providerTurnsBaseline?: number,
  completedDurationMs?: number,
): void {
  const row = db.prepare(`SELECT payload FROM loop_step_recovery WHERE run_id = ? AND step_key = ?`)
    .get(runId, stepKey) as { payload: string } | undefined
  if (!row) throw new Error(`Missing loop step checkpoint ${runId}/${stepKey}`)
  const payload = JSON.parse(row.payload) as LoopStepRecoveryPayload
  payload.completedEventSeq = Math.max(payload.completedEventSeq, completedEventSeq)
  if (providerCostBaseline !== undefined) payload.providerCostBaseline = providerCostBaseline
  if (providerTurnsBaseline !== undefined) payload.providerTurnsBaseline = providerTurnsBaseline
  if (completedDurationMs !== undefined) {
    payload.completedDurationMs = completedDurationMs
    // The completed duration now includes this turn. Leaving its active segment
    // behind would make a later no-result recovery count it twice.
    delete payload.activeTurnStartedAtMs
    delete payload.lastActivityAtMs
  }
  db.prepare(`UPDATE loop_step_recovery SET payload = ? WHERE run_id = ? AND step_key = ?`)
    .run(JSON.stringify(payload), runId, stepKey)
}

/** Persist the active turn's wall-clock bounds without advancing the raw-event
 * frontier. A result checkpoint later clears this segment in the same update
 * that commits completedDurationMs. */
export function updateLoopStepActivityCheckpoint(
  db: DbInstance,
  runId: string,
  stepKey: string,
  turnStartedAtMs: number | undefined,
  activityAtMs: number,
): void {
  const row = db.prepare(`SELECT payload FROM loop_step_recovery WHERE run_id = ? AND step_key = ?`)
    .get(runId, stepKey) as { payload: string } | undefined
  if (!row) throw new Error(`Missing loop step checkpoint ${runId}/${stepKey}`)
  const payload = JSON.parse(row.payload) as LoopStepRecoveryPayload
  if (!Number.isFinite(activityAtMs)) throw new Error('Loop step activity timestamp must be finite')
  const requestedStart = Number.isFinite(turnStartedAtMs)
    ? Math.max(0, Math.trunc(turnStartedAtMs!))
    : undefined
  const startedAt = requestedStart ?? payload.activeTurnStartedAtMs ?? Math.max(0, Math.trunc(activityAtMs))
  const activityAt = Math.max(startedAt, Math.trunc(activityAtMs))
  payload.activeTurnStartedAtMs = requestedStart ?? payload.activeTurnStartedAtMs ?? startedAt
  payload.lastActivityAtMs = Math.max(payload.lastActivityAtMs ?? startedAt, activityAt)
  db.prepare(`UPDATE loop_step_recovery SET payload = ? WHERE run_id = ? AND step_key = ?`)
    .run(JSON.stringify(payload), runId, stepKey)
}

export function setLoopStepSettledResult(
  db: DbInstance,
  runId: string,
  stepKey: string,
  settledResult: NonNullable<LoopStepRecoveryPayload['settledResult']>,
): void {
  const row = db.prepare(`SELECT payload FROM loop_step_recovery WHERE run_id = ? AND step_key = ?`)
    .get(runId, stepKey) as { payload: string } | undefined
  if (!row) throw new Error(`Missing loop step checkpoint ${runId}/${stepKey}`)
  const payload = JSON.parse(row.payload) as LoopStepRecoveryPayload
  payload.settledResult = settledResult
  db.prepare(`UPDATE loop_step_recovery SET payload = ? WHERE run_id = ? AND step_key = ?`)
    .run(JSON.stringify(payload), runId, stepKey)
}

export function getLoopStepRecovery(
  db: DbInstance,
  runId: string,
  stepKey: string,
): LoopStepRecoveryRow | undefined {
  return db.prepare(`SELECT * FROM loop_step_recovery WHERE run_id = ? AND step_key = ?`)
    .get(runId, stepKey) as LoopStepRecoveryRow | undefined
}

export function listLoopStepRecoveries(db: DbInstance): LoopStepRecoveryRow[] {
  return db.prepare(`SELECT * FROM loop_step_recovery ORDER BY created_at, run_id, step_key`).all() as LoopStepRecoveryRow[]
}

/** Execute the invocation insert and checkpoint removal under one SQLite
 * transaction. If either statement fails, neither survives. */
export function completeLoopStepRecovery(
  db: DbInstance,
  runId: string,
  stepKey: string,
  record: (payload: LoopStepRecoveryPayload) => void,
): boolean {
  const tx = db.transaction(() => {
    const row = getLoopStepRecovery(db, runId, stepKey)
    if (!row) return false
    const payload = JSON.parse(row.payload) as LoopStepRecoveryPayload
    record(payload)
    const removed = db.prepare(`DELETE FROM loop_step_recovery WHERE run_id = ? AND step_key = ?`)
      .run(runId, stepKey)
    if (removed.changes !== 1) throw new Error(`loop step checkpoint ${runId}/${stepKey} was not removed`)
    return true
  })
  return tx() as boolean
}

// Column allow-list — counters are interpolated into the SET clause, so gate
// the keys to prevent any future caller injecting SQL via an object key.
const COUNTER_COLUMNS: Record<keyof LoopRunCounters, string> = {
  iterationCount: 'iteration_count',
  totalCostUsd: 'total_cost_usd',
  totalTokens: 'total_tokens',
  totalDurationMs: 'total_duration_ms',
}

export function updateLoopRunCounters(db: DbInstance, id: string, counters: Partial<LoopRunCounters>): void {
  const keys = (Object.keys(counters) as (keyof LoopRunCounters)[]).filter((k) => counters[k] !== undefined)
  if (keys.length === 0) return
  const setClause = keys.map((k) => `${COUNTER_COLUMNS[k]} = ?`).join(', ')
  const values = keys.map((k) => counters[k] as number)
  db.prepare(`UPDATE loop_runs SET ${setClause} WHERE id = ?`).run(...values, id)
}

export function finishLoopRun(
  db: DbInstance,
  id: string,
  opts: { outcome: LoopRunOutcome; finishedAt: string; counters?: Partial<LoopRunCounters> }
): LoopRunRow | undefined {
  if (opts.counters) updateLoopRunCounters(db, id, opts.counters)
  db.prepare(
    `UPDATE loop_runs SET status = 'completed', final_outcome = ?, finished_at = ? WHERE id = ?`
  ).run(opts.outcome, opts.finishedAt, id)
  return getLoopRun(db, id)
}

export function pauseLoopRun(db: DbInstance, id: string, counters?: Partial<LoopRunCounters>): LoopRunRow | undefined {
  if (counters) updateLoopRunCounters(db, id, counters)
  db.prepare(`UPDATE loop_runs SET status = 'paused' WHERE id = ? AND status = 'running'`).run(id)
  return getLoopRun(db, id)
}

export function resumeLoopRun(db: DbInstance, id: string): LoopRunRow | undefined {
  db.prepare(`UPDATE loop_runs SET status = 'running' WHERE id = ? AND status = 'paused'`).run(id)
  return getLoopRun(db, id)
}

export function getLoopRun(db: DbInstance, id: string): LoopRunRow | undefined {
  return db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(id) as LoopRunRow | undefined
}

/** Activity-step count for one event, mirroring the client's deriveFrameActivity
 *  (../../client/src/features/browser/lib/frame-activity.ts) so the seeded count matches the live
 *  "pasos" the Job panel shows. A single assistant frame may carry several
 *  parallel tool_use blocks → each counts. Non-activity events → 0. */
function activityStepCount(eventType: string, payload: string): number {
  if (eventType === 'tool_use') return 1
  if (eventType === 'item.completed') return 1
  if (eventType === 'assistant') {
    try {
      const j = JSON.parse(payload) as { message?: { content?: Array<{ type?: string }> } }
      const content = j?.message?.content
      if (Array.isArray(content)) {
        const tu = content.filter((c) => c?.type === 'tool_use').length
        return tu > 0 ? tu : 1
      }
    } catch { /* unparseable → count the frame as 1 below */ }
    return 1
  }
  return 0
}

/** Step + log-line counts for a run, derived from its persisted events. Used to
 *  SEED the dashboard's live rail metrics after a page refresh — the WS stream
 *  alone can't replay events that already fired. steps = activity steps (SAME
 *  source as the Job panel's "pasos"); lines = number of `log` events. */
export function getRunEventCounts(db: DbInstance, runId: string): { steps: number; lines: number } {
  const rows = db
    .prepare("SELECT event_type, payload FROM events WHERE job_id = ? AND event_type IN ('log','assistant','tool_use','item.completed')")
    .all(runId) as { event_type: string; payload: string }[]
  let steps = 0
  let lines = 0
  for (const r of rows) {
    if (r.event_type === 'log') lines += 1
    else steps += activityStepCount(r.event_type, r.payload)
  }
  return { steps, lines }
}

/** All currently-running loop runs for a project, straight from the DB (NOT the
 *  in-memory rail map, which is cleared on every server restart). Authoritative
 *  source for seeding the dashboard's live rail metrics after a refresh. */
export function listRunningLoopRuns(db: DbInstance, projectId: string): LoopRunRow[] {
  return db
    .prepare("SELECT * FROM loop_runs WHERE project_id = ? AND status = 'running' ORDER BY started_at ASC")
    .all(projectId) as LoopRunRow[]
}

export function listActiveLoopRuns(db: DbInstance, projectId: string): LoopRunRow[] {
  return db
    .prepare("SELECT * FROM loop_runs WHERE project_id = ? AND status IN ('running','paused') ORDER BY started_at ASC")
    .all(projectId) as LoopRunRow[]
}

export function listLoopRuns(db: DbInstance, projectId: string, limit = 100): LoopRunRow[] {
  return db
    .prepare('SELECT * FROM loop_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(projectId, limit) as LoopRunRow[]
}

/** How many runs of a given loop definition are currently executing in this
 *  project's DB. Used (across all project DBs) for the global "is this loop
 *  Running?" guard that blocks edit/delete of a loop while it executes. */
export function countRunningForLoop(db: DbInstance, loopId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE loop_id = ? AND status IN ('running','paused')`)
    .get(loopId) as { n: number }
  return row.n
}

/** Reconcile orphan runs at startup: any row still active belongs to a process
 *  that is now dead (server restart, or a run killed before it could settle), so
 *  mark it terminal (`completed` + outcome `failed`). Its loop-owned backing
 *  jobs row is failed in the SAME transaction. QueueManager deliberately does
 *  not sweep those rows: LoopRunManager is the sole invocation authority, so
 *  treating the accumulated step total as a second surface='job' invocation
 *  would double-count spend. A paused row is active too: its resumable context
 *  lived in the old process. Execution claims of every active row are released
 *  in the same transaction. Returns the number of loop rows reconciled. */
export function reconcileOrphanLoopRuns(
  db: DbInstance,
  finishedAt: string,
  /** Compatibility only for pre-migration rows whose exact launch ticket set
   * was never persisted. New rows always use ticket_ids_json. */
  legacyTicketIdsByRun?: ReadonlyMap<string, readonly number[]>,
  definitionStates?: ReadonlyMap<string, DefinitionCheckpoint | null>,
): number {
  const reconcile = db.transaction(() => {
    const active = db.prepare(`
      SELECT * FROM loop_runs WHERE status IN ('running', 'paused')
    `).all() as LoopRunRow[]
    if (active.length === 0) return 0
    const updateJob = db.prepare(`
      UPDATE jobs
         SET status = 'failed', exit_code = -1,
             finished_at = COALESCE(finished_at, ?),
             duration_ms = COALESCE(
               (SELECT total_duration_ms FROM loop_runs WHERE loop_runs.id = jobs.id),
               duration_ms
             )
       WHERE owner = 'loop' AND status = 'running' AND id = ?
    `)
    const updateRun = db.prepare(`
      UPDATE loop_runs
         SET status = 'completed', final_outcome = 'failed',
             finished_at = COALESCE(finished_at, ?)
       WHERE id = ? AND status IN ('running', 'paused')
    `)
    const insertIntent = db.prepare(`
      INSERT INTO loop_terminal_recovery (run_id, payload, callback_completed)
      VALUES (?, ?, 0)
      ON CONFLICT(run_id) DO NOTHING
    `)
    // No process survived the restart: every execution claim of an active row is
    // stale, whether the row is retained as paused or settled as failed.
    const releaseClaim = db.prepare('DELETE FROM definition_execution_claims WHERE run_id = ?')
    for (const run of active) {
      releaseClaim.run(run.id)
      if (run.engine_version === 2 && run.run_request_json) {
        const state = definitionStates?.get(run.id)
        if (state !== null && (!state?.status || ['running', 'paused', 'interrupted'].includes(state.status))) {
          markDefinitionRestart(db, run.id, state ?? { status: 'unavailable', reason: 'Original Core status could not be read' })
          continue
        }
      }
      updateJob.run(finishedAt, run.id)
      updateRun.run(finishedAt, run.id)
      const persistedIds = parseTicketIdsJson(run.ticket_ids_json)
      const legacyIds = legacyTicketIdsByRun?.get(run.id) ?? []
      const payload: LoopTerminalRecoveryPayload = {
        version: 1,
        runId: run.id,
        projectId: run.project_id,
        ticketIds: persistedIds.length > 0 ? persistedIds : [...new Set(legacyIds)],
        railIndex: run.rail_index,
        outcome: 'failed',
        jobStatus: 'failed',
        ticketCompletionStatus: run.ticket_completion_status ?? 'done',
        finishedAt,
        causalOwnership: run.causal_ownership === 1,
        outcomeFinalized: true,
      }
      insertIntent.run(run.id, JSON.stringify(payload))
    }
    return active.length
  })
  return reconcile() as number
}
