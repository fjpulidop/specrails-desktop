import { runtimeEfficiencyEventLine, isRecordedRuntimeEfficiencyEvent } from './agent-runtime-events'
import { readRuntimeHistory } from './agent-runtime-history'
import { settleRuntimeContinuation } from './agent-runtime-settlement'
import { applyRuntimeSelectionOrigins, readRuntimeEfficiencySummary, readRuntimeEfficiency, type RuntimeEfficiencySummary, type RuntimeEfficiency, type RuntimeMetricsCatalog } from './agent-runtime-metrics'
import { execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveRetainedAgentRuntime } from './agent-runtime-package'
import { RUNTIME_HOST_ENV_KEYS, runAgentRuntimeInvocation, runAgentRuntimeControl } from './agent-runtime-bridge'
import { resolveCoreNodeRuntime } from '../../../core-node-runtime'
import { treeKillSafe, windowsSpawnEnv } from '../../../util/win-spawn'
import { resolveLoopBaseEnv, resolveProjectExecution } from '../../../workspace-resolution'
import { getLoopRun, readLoopJobUsage, stageLoopStepRecovery, setLoopStepSettledResult, updateLoopStepActivityCheckpoint } from '../../loops/runtime/loop-runs-store'
import { readExecutionManifest } from '../../delivery/runtime/multi-repo-execution-store'
import { appendEvent } from '../../../db'
import { recoverOrphanLoopStepAccounting } from '../../loops/runtime/loop-run-manager'
import type { ProjectContext } from '../../../project-registry'
import { invokeRuntimeRecovery, recoveryRequestSchema } from './agent-runtime-recovery'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const LEGACY_STEP_IDS = ['architect', 'developer', 'fixer', 'verify', 'reviewer', 'archive']
const NODE_PATH = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}(\/[A-Za-z0-9][A-Za-z0-9_-]{0,119}){0,3}$/
function isNodePath(value: string): boolean {
  return NODE_PATH.test(value) && value.split('/').every(id => !['START', 'END', '__start__', '__end__', 'next'].includes(id))
}
const ANSWER_LIMIT = 20_000
/** Core contract (engine/steering/inbox.ts): 1–20,000 UTF-16 code units per message. Its 80,000-byte cap cannot be reached below that length. */
export const STEERING_TEXT_LIMIT = 20_000
const STEERING_PREVIEW_LENGTH = 240
const STEERING_RECEIPT_LIMIT = 512
const STEERING_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export interface RuntimeSteeringAccepted { id: string; acceptedAt: string }
export interface RuntimeSteeringReceipt {
  id: string
  /** Core's durable inbox timestamp, preserved across idempotent retries. */
  acceptedAt: string
  preview: string
  length: number
  /** pending: accepted by Core's inbox and not yet claimed by an attempt (or consumption unreported). consumed: claimed by consumedAttemptId at that attempt's admission. */
  status: 'pending' | 'consumed'
  consumedAttemptId?: string
  consumedAt?: string
}
export interface RuntimeSteeringState {
  receipts: RuntimeSteeringReceipt[]
  pending: number
  consumed: number
  /** false: the retained Core does not report inbox consumption, so accepted messages stay pending here even after an attempt claimed them. */
  consumptionReported: boolean
  truncated?: boolean
  /** The Desktop receipt projection could not be read; Core's inbox remains authoritative. */
  receiptsUnavailable?: true
}
/** Core owns receipt durability; Desktop never infers consumption from process state. */
export function readRuntimeSteering(value: unknown): RuntimeSteeringState | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Core returned invalid steering receipts')
  const state = value as RuntimeSteeringState
  const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  if (state.consumptionReported !== true || !Number.isSafeInteger(state.pending) || state.pending < 0 || !Number.isSafeInteger(state.consumed) || state.consumed < 0 || typeof state.truncated !== 'boolean' ||
    !Array.isArray(state.receipts) || state.receipts.length > STEERING_RECEIPT_LIMIT || state.receipts.some(item => !item || typeof item.id !== 'string' || !item.id || item.id.length > 256 || !timestamp(item.acceptedAt) || typeof item.preview !== 'string' || item.preview.length > STEERING_PREVIEW_LENGTH || !Number.isSafeInteger(item.length) || item.length < item.preview.length || item.length > STEERING_TEXT_LIMIT || !['pending', 'consumed'].includes(item.status) ||
      (item.status === 'consumed' && (typeof item.consumedAttemptId !== 'string' || !item.consumedAttemptId || !timestamp(item.consumedAt))) ||
      (item.status === 'pending' && (item.consumedAt !== undefined || item.consumedAttemptId !== undefined)))) throw new Error('Core returned invalid steering receipts')
  return { receipts: state.receipts.map(({ id, acceptedAt, preview, length, status, consumedAttemptId, consumedAt }) => ({ id, acceptedAt, preview, length, status, ...(consumedAttemptId ? { consumedAttemptId, consumedAt } : {}) })), pending: state.pending, consumed: state.consumed, truncated: state.truncated, consumptionReported: true }
}
export interface RuntimeResumeInput { approve?: string[]; recover?: string[]; invalidate?: string[]; answer?: string }
export interface RuntimePendingQuestion { stepId: string; requestedAt: string; question: string; answeredAt?: string; answer?: string }
interface RuntimeFailure { stepId: string; status: string; at: string; error?: string }
interface RuntimeInspection {
  resumePhase?: string | null
  verification?: { valid: boolean; reasons: string[] }
  acceptance?: { valid: boolean; reasons: string[] }
}
interface FrozenContext { runId: string; backlogRoot: string; artifactRoot: string; repositories: Array<{ id: string; name: string; path: string }> }
export interface RuntimeState {
  lease?: { active: boolean } | null
  recoverableSteps?: Array<{ attemptId: string; nodePath: string; scopeId: string }>
  pendingInterrupts?: Array<{ id: string; nodePath: string; kind: 'question' | 'approval' | 'gate'; value?: unknown }>

  completion?: { ok: boolean; verified: boolean; reasons: string[] } | null
  steering?: RuntimeSteeringState
  engineVersion?: number
  /** IDs from the original frozen runtime configuration, not an observed metrics row. */
  roleIds?: string[]
  recentFailures?: RuntimeFailure[]
  inspection?: RuntimeInspection
  efficiencySummary?: RuntimeEfficiencySummary
  metrics?: RuntimeEfficiency
  runId: string; traceId?: string; status: string; nextStep: string | null; updatedAt?: string; error?: string
  pendingApproval?: { stepId: string; reason?: string }
  pendingQuestion?: RuntimePendingQuestion
  steps: Record<string, { status: string; visits?: number; kind?: string }>
}
export interface RuntimeRunSummary {
  recoveryAttempts?: RuntimeState['recoverableSteps']
  completion?: RuntimeState['completion']
  steering?: RuntimeSteeringState
  engineVersion?: number
  historical?: boolean
  efficiencySummary?: RuntimeEfficiencySummary
  canSettle?: boolean
  metrics?: RuntimeEfficiency
  runId: string; traceId?: string; status: string; nextStep: string | null; updatedAt?: string; error?: string
  pendingApproval?: { stepId: string; reason?: string }
  pendingQuestion?: RuntimePendingQuestion
  recoverableSteps: string[]; active: boolean; canResume: boolean; canCancel: boolean
  /** A settled continuation (blocked/failed/interrupted/succeeded) can be dismissed from the rail card; it stays in the history. */
  canDismiss?: boolean
  dismissed?: boolean
}
/**
 * Whether a continuation still deserves the rail card. Anything that needs a
 * human (blocked, failed, interrupted, a pending question or approval, a
 * settle still owed) pins the rail; a run that SUCCEEDED and offers no action
 * does not — its evidence lives in the job log and the Settings history, and
 * the delivery decision (when one exists) has its own strip. Observed: a rail
 * kept a "Completed" card with only Dismiss on it after every green run.
 */
export function pinsRailCard(summary: RuntimeRunSummary): boolean {
  if (summary.dismissed) return false
  if (summary.active || summary.canResume || summary.canSettle || summary.canCancel || summary.pendingQuestion || summary.pendingApproval || summary.recoverableSteps.length) return true
  return summary.status !== 'succeeded'
}
export class RuntimeControlError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message) }
}

export function stepIdsFor(state: Pick<RuntimeState, 'engineVersion' | 'steps'>): string[] {
  return state.engineVersion === 2 ? Object.keys(state.steps) : [...LEGACY_STEP_IDS]
}

function metricsCatalogFor(state: RuntimeState): RuntimeMetricsCatalog | undefined {
  return state.engineVersion === 2 ? { stepIds: stepIdsFor(state), roleIds: state.roleIds } : undefined
}

/** Open roles belong to the original run, even after project settings change. */
function frozenRoleIds(contextPath: string): string[] | undefined {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(path.dirname(contextPath), 'desktop-runtime-config.json'), 'utf8'))
    const catalogs = [config.agents, config.roles].filter(value => value !== undefined)
    if (!catalogs.length || catalogs.some(value => !value || typeof value !== 'object' || Array.isArray(value))) return undefined
    const ids = [...new Set(catalogs.flatMap(value => Object.keys(value)))]
    return ids.every(id => /^[a-z][a-z0-9-]{0,63}$/.test(id)) ? ids : undefined
  } catch { return undefined }
}

export function validateRuntimeResumeInput(input: unknown, state?: RuntimeState): RuntimeResumeInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeControlError(400, 'invalid_resume_request', 'Resume request must be an object')
  const body = input as Record<string, unknown>
  const stepIds = state ? new Set(stepIdsFor(state)) : undefined
  for (const [key, value] of Object.entries(body)) {
    if (key === 'answer') {
      if (typeof value !== 'string' || !value.trim() || value.length > ANSWER_LIMIT) throw new RuntimeControlError(400, 'invalid_resume_request', `An answer must be a nonempty string of at most ${ANSWER_LIMIT} characters`)
      continue
    }
    if (!['approve', 'recover', 'invalidate'].includes(key) || !Array.isArray(value) || value.length > 10_000 || !value.every((id) => typeof id === 'string' && isNodePath(id)) || new Set(value).size !== value.length) throw new RuntimeControlError(400, 'invalid_resume_request', 'Only approve, recover and invalidate arrays of safe node paths are allowed')
    if (stepIds && value.some(id => !stepIds.has(id))) throw new RuntimeControlError(400, 'invalid_resume_request', 'Resume node paths must belong to the saved workflow')
  }
  return body as RuntimeResumeInput
}

/** A question stays pending until Core records its answer. */
function openQuestion(state: RuntimeState): RuntimePendingQuestion | undefined {
  return state.pendingQuestion && state.pendingQuestion.answeredAt === undefined ? state.pendingQuestion : undefined
}

/** Status is a read-only Core CLI operation. It never invokes a provider. */
export async function readAgentRuntimeStatus(contextPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<RuntimeState | null> {
  let cli: string
  try { cli = resolveRetainedAgentRuntime(contextPath) }
  catch (error) { throw new RuntimeControlError(409, 'original_runtime_unavailable', error instanceof Error ? error.message : 'The original runtime package is unavailable') }
  if (!cli) throw new RuntimeControlError(503, 'runtime_unavailable', 'Update Core to inspect or resume agent runtime executions')
  const { stdout } = await promisify(execFile)(resolveCoreNodeRuntime(), [cli, 'status', '--context', contextPath, '--compact'], {
    cwd, env: windowsSpawnEnv(env), windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
  })
  const result = JSON.parse(stdout) as { type?: string; engineVersion?: number; completion?: RuntimeState['completion']; state?: (RuntimeState & { nextNodePath?: string | null }) | null; pipeline?: RuntimeInspection; metrics?: unknown; efficiencySummary?: unknown }
  if (result.type !== 'runtime-status' || result.state === undefined) throw new Error('Core returned an invalid runtime status')
  if (result.engineVersion !== undefined && (!Number.isSafeInteger(result.engineVersion) || result.engineVersion < 1)) throw new Error('Core returned an invalid runtime engine version')
  if (!result.state) return null
  const state = { ...result.state, ...(result.engineVersion === undefined ? {} : { engineVersion: result.engineVersion }) }
  if (state.engineVersion === 2) {
    if (!state.steps || typeof state.steps !== 'object' || Array.isArray(state.steps) || !Object.entries(state.steps).every(([id, step]) => isNodePath(id) && step && typeof step.status === 'string')) throw new Error('Core returned an invalid runtime step catalog')
    if (state.nextNodePath !== null && (typeof state.nextNodePath !== 'string' || !Object.hasOwn(state.steps, state.nextNodePath))) throw new Error('Core returned an invalid next node path')
    if (state.recoverableSteps !== undefined && (!Array.isArray(state.recoverableSteps) || state.recoverableSteps.some(step => !step || typeof step.attemptId !== 'string' || !step.attemptId || typeof step.nodePath !== 'string' || typeof step.scopeId !== 'string'))) throw new Error('Core returned invalid recovery attempt identities')
    if (state.lease !== undefined && state.lease !== null && (typeof state.lease !== 'object' || typeof state.lease.active !== 'boolean')) throw new Error('Core returned an invalid execution lease')
    if (state.pendingInterrupts !== undefined && (!Array.isArray(state.pendingInterrupts) || state.pendingInterrupts.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.nodePath !== 'string' || !['question', 'approval', 'gate'].includes(item.kind)))) throw new Error('Core returned invalid pending interrupts')
    // Legacy display fields use node paths. Controls must use an exact pending
    // interrupt, including when parallel branches pause at the same node.
    if (state.pendingApproval) {
      const approval = state.pendingInterrupts?.find(item => item.nodePath === state.pendingApproval!.stepId && item.kind !== 'question')
      state.pendingApproval = approval ? { ...state.pendingApproval, stepId: approval.id } : undefined
    }
    if (state.pendingQuestion) {
      const question = state.pendingInterrupts?.find(item => item.nodePath === state.pendingQuestion!.stepId && item.kind === 'question')
      state.pendingQuestion = question ? { ...state.pendingQuestion, stepId: question.id } : undefined
    }
    state.nextStep = state.nextNodePath
    state.roleIds = frozenRoleIds(contextPath)
    state.steering = readRuntimeSteering(state.steering)
    if (result.completion !== undefined && result.completion !== null && (typeof result.completion !== 'object' || typeof result.completion.ok !== 'boolean' || typeof result.completion.verified !== 'boolean' || !Array.isArray(result.completion.reasons) || result.completion.reasons.some(reason => typeof reason !== 'string'))) throw new Error('Core returned invalid completion evidence')
    state.completion = result.completion
  }
  let selection: unknown
  try { selection = JSON.parse(fs.readFileSync(path.join(path.dirname(contextPath), 'desktop-runtime-selection.json'), 'utf8')) } catch { /* Original hosts may not record selection origins. */ }
  const catalog = metricsCatalogFor(state)
  return { ...state, inspection: result.pipeline, metrics: readRuntimeEfficiency(result.metrics ?? state.metrics, catalog), efficiencySummary: applyRuntimeSelectionOrigins(readRuntimeEfficiencySummary(result.efficiencySummary, catalog), selection, state.runId) }
}

/** One controller per ProjectContext; Core's durable lease remains the final
 * cross-process guard. Resume never constructs a new context or worktree. */
export class AgentRuntimeControls {
  isActive(runId: string): boolean { return this.active.has(runId) }
  activeRunIds(): string[] { return [...this.active.keys()] }
  private active = new Map<string, { child?: ChildProcess; cancelled: boolean; forceKillTimer?: ReturnType<typeof setTimeout> }>()
  private errors = new Map<string, string>()
  private statusCache = new Map<string, { fingerprint: string; state: RuntimeState }>()
  private disposed = false
  constructor(private ctx: Pick<ProjectContext, 'project' | 'db'> & Partial<Pick<ProjectContext, 'broadcast' | 'railLoopRuns' | 'railJobs'>>, private dependencies: { status: typeof readAgentRuntimeStatus; execute: typeof runAgentRuntimeInvocation; kill: typeof treeKillSafe; settle?: typeof settleRuntimeContinuation; recovery?: typeof invokeRuntimeRecovery; control?: typeof runAgentRuntimeControl } = { status: readAgentRuntimeStatus, execute: runAgentRuntimeInvocation, kill: treeKillSafe, settle: settleRuntimeContinuation }) {}

  async signal(runId: string, input: unknown): Promise<RuntimeSteeringAccepted> {
    if (this.disposed) throw new RuntimeControlError(503, 'runtime_shutting_down', 'Project runtime is shutting down')
    const body = input as { text?: unknown; requestId?: unknown } | null
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['text', 'requestId'].includes(key)) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > STEERING_TEXT_LIMIT || typeof body.requestId !== 'string' || !STEERING_REQUEST_ID.test(body.requestId)) throw new RuntimeControlError(400, 'invalid_steering_request', 'Steering requires text of 1–20,000 characters and a stable requestId')
    const { file, cwd, env } = this.context(runId)
    const state = await this.dependencies.status(file, cwd, env)
    if (!state || state.runId !== runId || state.engineVersion !== 2) throw new RuntimeControlError(409, 'steering_unsupported', 'This retained run does not support engine v2 steering')
    try {
      const accepted = await (this.dependencies.control ?? runAgentRuntimeControl)({ kind: 'signal', contextPath: file, cwd, env, runId, text: body.text, requestId: body.requestId })
      this.statusCache.delete(runId)
      return { id: accepted.id, acceptedAt: accepted.acceptedAt }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not send operator steering'
      const code = /^(control_conflict|run_terminal|inbox_full|invalid_arguments):/.exec(message)?.[1]
      throw new RuntimeControlError(code === 'invalid_arguments' ? 400 : code ? 409 : 503, code ?? 'runtime_steering_failed', message)
    }
  }

  private context(runId: string, historical = false): { file: string; frozen: FrozenContext; cwd: string; env: NodeJS.ProcessEnv } {
    if (!SAFE_ID.test(runId)) throw new RuntimeControlError(400, 'invalid_run_id', 'Invalid runtime run ID')
    const execution = resolveProjectExecution(this.ctx.project)
    const backlogRoot = fs.realpathSync(path.dirname(execution.specrailsDir))
    const directory = path.join(execution.specrailsDir, 'pipeline', runId)
    const file = path.join(directory, 'desktop-context.json')
    if (!fs.existsSync(file)) throw new RuntimeControlError(404, 'runtime_run_not_found', 'Runtime execution context is unavailable')
    if (fs.realpathSync(file) !== path.join(fs.realpathSync(execution.specrailsDir), 'pipeline', runId, 'desktop-context.json')) throw new RuntimeControlError(409, 'runtime_scope_changed', 'Runtime context path no longer matches its project')
    const frozen = JSON.parse(fs.readFileSync(file, 'utf8')) as FrozenContext
    try {
      if (frozen.runId !== runId || fs.realpathSync(frozen.backlogRoot) !== backlogRoot || !Array.isArray(frozen.repositories) || !frozen.repositories.length || !frozen.repositories.some((repository) => repository.path === frozen.artifactRoot)) throw new Error()
      for (const root of [frozen.artifactRoot, ...frozen.repositories.map((repository) => repository.path)]) {
        if (!path.isAbsolute(root) || (!historical && (fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()))) throw new Error()
      }
    } catch { throw new RuntimeControlError(409, 'runtime_scope_unavailable', 'The original runtime worktree or project scope is unavailable. Start a new implementation.') }
    const stored = this.ctx.db.prepare('SELECT execution_manifest FROM loop_runs WHERE id = ?').get(runId) as { execution_manifest?: string } | undefined
    const manifest = readExecutionManifest(stored?.execution_manifest)
    if (manifest && (manifest.projectId !== this.ctx.project.id || manifest.repositories.length !== frozen.repositories.length || !manifest.repositories.every((repository) => frozen.repositories.some((item) => item.id === repository.repositoryId && item.path === repository.worktreePath)))) throw new RuntimeControlError(409, 'runtime_scope_changed', 'The saved worktree manifest differs from the frozen runtime scope')
    const hostFile = path.join(directory, 'desktop-runtime-host.json')
    if (!fs.existsSync(hostFile)) throw new RuntimeControlError(409, 'runtime_host_unavailable', 'The original runtime host settings are missing. Start a new implementation.')
    const host = JSON.parse(fs.readFileSync(hostFile, 'utf8')) as { schemaVersion?: number; cwd?: string; env?: Record<string, string> }
    if (host.schemaVersion !== 1 || typeof host.cwd !== 'string' || ![frozen.backlogRoot, ...frozen.repositories.map((repository) => repository.path)].includes(host.cwd) || !host.env || typeof host.env !== 'object' || Array.isArray(host.env) || Object.entries(host.env).some(([key, value]) => !(RUNTIME_HOST_ENV_KEYS as readonly string[]).includes(key) || typeof value !== 'string')) throw new RuntimeControlError(409, 'runtime_host_invalid', 'The saved runtime host settings are invalid')
    const env = { ...resolveLoopBaseEnv(this.ctx.project) }
    for (const key of RUNTIME_HOST_ENV_KEYS) delete env[key]
    Object.assign(env, host.env, { SPECRAILS_EXECUTION_CONTEXT: file })
    return { file, frozen, cwd: host.cwd, env }
  }

  async evidence(runId: string, query: Record<string, unknown>): Promise<unknown> {
    const { file, frozen, env } = this.context(runId, true)
    const flags: string[] = []
    for (const [key, value] of Object.entries(query)) {
      if (!['id', 'section', 'sourceId', 'cursor', 'limit'].includes(key) || typeof value !== 'string' || value.length > 1024) throw new RuntimeControlError(400, 'invalid_evidence_query', 'Invalid evidence query')
      flags.push('--' + (key === 'sourceId' ? 'source-id' : key), value)
    }
    const cli = resolveRetainedAgentRuntime(file)
    const { stdout } = await promisify(execFile)(resolveCoreNodeRuntime(), [cli, 'evidence', '--context', file, ...flags], { cwd: frozen.backlogRoot, env: windowsSpawnEnv(env), windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
    const result = JSON.parse(stdout)
    if (result.schemaVersion !== 1 || typeof result.available !== 'boolean' || typeof result.truncated !== 'boolean') throw new RuntimeControlError(503, 'evidence_unavailable', 'Core evidence is unavailable or incompatible')
    return result
  }

  async recovery(runId: string, input: unknown): Promise<unknown> {
    const parsed = recoveryRequestSchema.safeParse(input)
    if (!parsed.success) throw new RuntimeControlError(400, 'invalid_recovery_request', parsed.error.message)
    if (this.disposed) throw new RuntimeControlError(503, 'runtime_shutting_down', 'Project runtime is shutting down')
    const parent = getLoopRun(this.ctx.db, runId)
    const idle = () => parent?.status === 'completed' && !this.ctx.railLoopRuns?.size && !this.ctx.railJobs?.size
      && !this.ctx.db.prepare("SELECT 1 FROM jobs WHERE status = 'running' LIMIT 1").get()
    if (!idle() || this.active.size) throw new RuntimeControlError(409, 'runtime_run_active', 'Wait for project executions to settle before scoped recovery')
    const context = this.context(runId)
    const active: { child?: ChildProcess; cancelled: boolean; forceKillTimer?: ReturnType<typeof setTimeout> } = { cancelled: false }
    this.active.set(runId, active)
    if (parent?.rail_index != null) this.ctx.railLoopRuns?.set(runId, { railIndex: parent.rail_index, ticketIds: [], requiresTerminalIntent: true })
    try {
      const result = await (this.dependencies.recovery ?? invokeRuntimeRecovery)({ contextPath: context.file, cwd: context.cwd, env: context.env, request: parsed.data,
        onSpawn: child => { active.child = child; if (active.cancelled || this.disposed) this.cancel(runId) },
      })
      if (parsed.data.action === 'patch' || parsed.data.action === 'check') {
        this.statusCache.delete(runId)
        this.ctx.db.transaction(() => {
          const seq = (this.ctx.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM events WHERE job_id = ?').get(runId) as { seq: number }).seq
          appendEvent(this.ctx.db, runId, seq, { event_type: 'runtime-recovery', source: 'stdout', payload: JSON.stringify({ action: parsed.data.action, result }) })
        })()
      }
      return result
    } catch (error) {
      if (error instanceof RuntimeControlError) throw error
      throw new RuntimeControlError(409, 'runtime_recovery_blocked', error instanceof Error ? error.message : 'Recovery failed; inspect history before retrying')
    } finally { clearTimeout(active.forceKillTimer); this.active.delete(runId); this.ctx.railLoopRuns?.delete(runId); this.statusCache.delete(runId) }
  }

  /** Read-only recovery assessment. canResume is admission, not a repair claim. */
  async diagnose(runId: string): Promise<unknown> {
    const summary = await this.summary(runId)
    if (summary.historical || summary.status === 'unavailable') return {
      runId, summary, recommendation: 'inspect_saved_evidence',
      reason: 'Live original runtime scope is unavailable. Preserve saved work and inspect the missing scope before proposing a fresh run.',
      repeatFailureCount: null, recentFailures: [],
    }
    const { file, frozen, cwd, env } = this.context(runId)
    const state = await this.dependencies.status(file, cwd, env)
    if (!state || state.runId !== runId) throw new RuntimeControlError(409, 'runtime_state_unavailable', 'No saved workflow state is available')
    const failures = (state.recentFailures ?? []).slice(-8).map(item => ({ stepId: item.stepId, status: item.status, at: item.at, error: item.error?.slice(-6000) }))
    const matching = failures.filter(item => item.status === 'failed' && item.stepId === state.nextStep && !!item.error && item.error === state.error?.slice(-6000))
    const repeated = matching.length > 1
    const recommendation = summary.active ? 'wait_for_active_run'
      : summary.canSettle ? 'prepare_delivery'
      : summary.status === 'succeeded' ? 'inspect_delivery'
      : summary.pendingQuestion ? 'answer_question'
      : summary.pendingApproval ? 'inspect_and_approve'
      : repeated ? 'repair_before_retry'
      : summary.recoverableSteps.length ? 'inspect_interrupted_writes'
      : 'diagnose_before_retry'
    return {
      runId, summary, recommendation,
      reason: {
        wait_for_active_run: 'The original run is still active. Inspect its progress instead of starting a competing execution.',
        prepare_delivery: 'Core succeeded but Desktop settlement is still pending. Prepare delivery of the existing implementation.',
        inspect_delivery: 'Core already succeeded. Inspect the delivery state rather than restarting implementation.',
        answer_question: 'The run is waiting for the recorded question to be answered.',
        inspect_and_approve: 'The run is waiting for approval of the recorded candidate; inspect its evidence first.',
        repair_before_retry: 'The same step failed with the same error more than once. Identify and verify a changed precondition before spending on another attempt.',
        inspect_interrupted_writes: 'An interrupted step may have partially changed files. Inspect the original worktree before explicitly recovering it.',
        diagnose_before_retry: 'Determine the failing precondition from the saved evidence. A resumable run may still need a repair; a fresh run is not a diagnosis.',
      }[recommendation],
      originalScope: { artifactRoot: frozen.artifactRoot, repositories: frozen.repositories },
      completedSteps: Object.entries(state.steps).filter(([, step]) => step.status === 'succeeded').map(([id]) => id),
      recentFailures: failures, repeatFailureCount: state.recentFailures ? matching.length : null,
      verification: state.inspection?.verification ? { valid: state.inspection.verification.valid, reasons: state.inspection.verification.reasons } : null,
      acceptance: state.inspection?.acceptance ? { valid: state.inspection.acceptance.valid, reasons: state.inspection.acceptance.reasons } : null,
      resumePhase: state.inspection?.resumePhase ?? null,
      limitations: [
        'Recent failure history is bounded to eight attempts; null means the retained Core does not expose it.',
        'Completed steps are historical outcomes. Resume revalidates receipts and may repeat verification/review after changes; do not promise zero cost.',
        'This diagnostic does not execute repairs, resume, relaunch, publish or discard work.',
      ],
    }
  }

  async list(): Promise<RuntimeRunSummary[]> {
    const directory = path.join(resolveProjectExecution(this.ctx.project).specrailsDir, 'pipeline')
    if (!fs.existsSync(directory)) return []
    const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name) && fs.existsSync(path.join(directory, entry.name, 'agent-runtime-request.json')))
      .sort((a, b) => fs.statSync(path.join(directory, b.name)).mtimeMs - fs.statSync(path.join(directory, a.name)).mtimeMs).slice(0, 20)
    const runs: RuntimeRunSummary[] = []
    // Bounded sequential reads avoid spawning one Node process per historical run at once.
    for (const entry of entries) runs.push(await this.summary(entry.name))
    return runs
  }

  async summary(runId: string): Promise<RuntimeRunSummary> {
    try {
      const { file, cwd, env } = this.context(runId)
      // Core owns checkpoint parsing. Its atomic file revision is only a cache
      // key, keeping idle settings panes from spawning CLI processes repeatedly.
      const checkpoint = path.join(path.dirname(file), 'agent-workflow', runId, 'checkpoint.json')
      // A v2 run can also contain a legacy implementation journal; that file
      // cannot invalidate the SQLite/WAL status, so leave v2 inspection uncached.
      const stat = !fs.existsSync(path.join(path.dirname(file), 'agent-workflow', 'run.sqlite')) && fs.existsSync(checkpoint) ? fs.statSync(checkpoint) : null
      const fingerprint = stat ? createHash('sha256').update(fs.readFileSync(checkpoint)).digest('hex') : null
      const cached = this.statusCache.get(runId)
      const state = fingerprint && cached?.fingerprint === fingerprint ? cached.state : await this.dependencies.status(file, cwd, env)
      if (!state || state.runId !== runId) throw new Error('No saved workflow state is available')
      if (fingerprint) this.statusCache.set(runId, { fingerprint, state })
      const parent = getLoopRun(this.ctx.db, runId)
      const definition = state.engineVersion === 2 && parent?.engine_version === 2
      const active = definition ? state.lease?.active === true : this.active.has(runId) || parent?.status === 'running' || parent?.status === 'paused'
      let projection: ReturnType<typeof readRuntimeHistory> = null
      try { projection = readRuntimeHistory(file) } catch { /* Invalid advisory history cannot replace live state. */ }
      const superseding = !active && projection && ['failed', 'cancelled', 'running'].includes(projection.status) && Date.parse(projection.updatedAt) > Date.parse(state.updatedAt ?? '1970-01-01') ? projection : null
      const recoverableSteps = state.engineVersion === 2 ? (state.recoverableSteps ?? []).map(step => step.attemptId) : Object.entries(state.steps).filter(([, step]) => ['running', 'interrupted'].includes(step.status)).map(([id]) => id)
      const catalog = metricsCatalogFor(state)
      return { runId, engineVersion: state.engineVersion, status: superseding ? (superseding.status === 'running' ? 'interrupted' : superseding.status) : state.status === 'running' && !active ? 'interrupted' : state.status, nextStep: state.nextStep,
        updatedAt: superseding?.updatedAt ?? state.updatedAt, error: this.errors.get(runId) ?? superseding?.error ?? state.error, pendingApproval: state.pendingApproval,
        traceId: state.traceId, pendingQuestion: openQuestion(state), steering: state.steering, completion: state.completion,
        metrics: readRuntimeEfficiency(superseding ? superseding.metrics : state.metrics, catalog), efficiencySummary: readRuntimeEfficiencySummary(superseding ? superseding.efficiencySummary : state.efficiencySummary, catalog),
        canSettle: definition
          ? !active && parent.status === 'completed' && state.status === 'succeeded' && !!this.ctx.db.prepare(`SELECT 1 FROM definition_delivery_settlements s JOIN rail_pr_deliveries d ON d.id=s.delivery_id WHERE s.project_id=? AND s.run_id=? AND d.decision IN ('building','pr_failed','implementation_failed') LIMIT 1`).get(this.ctx.project.id, runId)
          : !superseding && !active && state.status === 'succeeded' && (this.ctx.db.prepare('SELECT status FROM jobs WHERE id = ?').get(runId) as { status?: string } | undefined)?.status !== 'completed',
        recoverableSteps, ...(state.engineVersion === 2 ? { recoveryAttempts: state.recoverableSteps ?? [] } : {}), active, canCancel: definition ? !state.completion && !['succeeded', 'cancelled'].includes(state.status) : this.active.has(runId), canResume: state.engineVersion === 2 ? definition && !active && parent.status !== 'completed' && state.status !== 'cancelled' : !active && parent?.status === 'completed' && state.status !== 'succeeded',
        canDismiss: !active, dismissed: this.isDismissed(runId) }
    } catch (error) {
      try {
        const { file } = this.context(runId, true)
        const historical = readRuntimeHistory(file)
        if (historical) return { ...historical, runId, status: historical.status === 'running' ? 'interrupted' : historical.status, historical: true, active: this.active.has(runId), canResume: false, canSettle: false, canCancel: this.active.has(runId), recoverableSteps: [], error: error instanceof RuntimeControlError ? error.message : 'Historical result; live runtime verification is unavailable' }
      } catch { /* No trustworthy historical projection is available. */ }
      return { runId, status: 'unavailable', nextStep: null, active: this.active.has(runId), canResume: false, canCancel: this.active.has(runId), recoverableSteps: [], error: error instanceof RuntimeControlError ? error.message : 'Could not inspect the saved runtime execution' }
    }
  }

  async resume(runId: string, input: RuntimeResumeInput): Promise<void> {
    if (this.disposed) throw new RuntimeControlError(503, 'runtime_shutting_down', 'Project runtime is shutting down')
    const parent = getLoopRun(this.ctx.db, runId)
    if (parent?.engine_version === 2) throw new RuntimeControlError(409, 'definition_lifecycle_required', 'Resume this workflow through its definition lifecycle')
    if (!parent || parent.status !== 'completed' || this.active.has(runId)) throw new RuntimeControlError(409, 'runtime_run_active', 'Wait for the original Desktop execution to settle before resuming')
    if (parent.rail_index != null && [...(this.ctx.railLoopRuns?.values() ?? []), ...(this.ctx.railJobs?.values() ?? [])].some(meta => meta.railIndex === parent.rail_index)) throw new RuntimeControlError(409, 'runtime_rail_active', 'Wait for the implementation card to finish its active job before resuming')
    const context = this.context(runId)
    // Reserve before awaiting status so concurrent resume requests cannot race.
    const active = { cancelled: false } as { child?: ChildProcess; cancelled: boolean; forceKillTimer?: ReturnType<typeof setTimeout> }
    this.active.set(runId, active)
    try {
      // Accounting from a prior continuation must settle even when Core now
      // reports success and correctly refuses any further execution.
      const state = await this.dependencies.status(context.file, context.cwd, context.env)
      if (state?.engineVersion === 2) throw new RuntimeControlError(409, 'definition_lifecycle_required', 'Resume this workflow through its definition lifecycle')
      recoverOrphanLoopStepAccounting(this.ctx.db, new Date().toISOString(), runId)
      if (!state || state.runId !== runId || state.status === 'succeeded') throw new RuntimeControlError(409, 'runtime_not_resumable', 'This execution has no resumable workflow')
      validateRuntimeResumeInput(input, state)
      if (parent.rail_index != null && [...(this.ctx.railLoopRuns?.values() ?? []), ...(this.ctx.railJobs?.values() ?? [])].some(meta => meta.railIndex === parent.rail_index)) throw new RuntimeControlError(409, 'runtime_rail_active', 'The implementation card became active while checking the saved execution')
      // A pending question resumes the architect only with the operator's answer.
      if (openQuestion(state) && !input.answer) throw new RuntimeControlError(400, 'answer_required', 'This execution is waiting for an answer to the architect\'s question')
      this.errors.delete(runId)
      this.statusCache.delete(runId)
      const startedAt = new Date().toISOString()
      const invocationId = randomUUID()
      const stepKey = `runtime-resume:${invocationId}`
      // Both live settlement and restart use the existing loop ledger.
      const previous = getLoopRun(this.ctx.db, runId)!
      let sequence = (this.ctx.db.prepare('SELECT COALESCE(MAX(seq), -1) AS seq FROM events WHERE job_id = ?').get(runId) as { seq: number }).seq
      const startedAtMs = Date.parse(startedAt)
      let ticketIds: number[] = []
      try {
        const ids: unknown = JSON.parse(previous.ticket_ids_json ?? '[]')
        if (Array.isArray(ids)) ticketIds = ids.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id))
      } catch { /* Older loop records can lack a ticket scope. */ }
      stageLoopStepRecovery(this.ctx.db, {
        version: 1, runId, stepKey, invocationId, projectId: this.ctx.project.id,
        provider: 'agent-runtime', model: 'per-role', surfaceRefId: stepKey,
        ticketIds, startedAt, baseline: readLoopJobUsage(this.ctx.db, runId),
        completedEventSeq: sequence, providerCostBaseline: 0, providerTurnsBaseline: 0,
        loopDurationBaseline: previous.total_duration_ms, completedDurationMs: 0,
        iterationCount: previous.iteration_count, activeTurnStartedAtMs: startedAtMs, lastActivityAtMs: startedAtMs,
      })
      const logLine = (line: string, source: 'stdout' | 'stderr' = 'stdout'): void => {
        if (this.disposed) return
        try { appendEvent(this.ctx.db, runId, ++sequence, { event_type: 'log', source, payload: JSON.stringify({ line: line.replace(/\n$/, '') }) }) } catch { /* events table best-effort */ }
        try { this.ctx.broadcast?.({ type: 'log', source, line, timestamp: new Date().toISOString(), processId: runId }) } catch { /* persisted log remains authoritative */ }
      }
      if (parent.rail_index != null) this.ctx.railLoopRuns?.set(runId, { railIndex: parent.rail_index, ticketIds, requiresTerminalIntent: true })
      const publishActivity = (running: boolean) => {
        try { this.ctx.broadcast?.({ type: 'runtime.continuation', projectId: this.ctx.project.id, jobId: runId, railIndex: parent.rail_index, active: running }) } catch { /* durable log remains available */ }
      }
      publishActivity(true)
      const requested = [...(input.approve?.length ? ['approve ' + input.approve.join(',')] : []), ...(input.recover?.length ? ['recover ' + input.recover.join(',')] : []), ...(input.invalidate?.length ? ['invalidate ' + input.invalidate.join(',')] : []), ...(input.answer ? ['answered question'] : [])]
      logLine(`[runtime] continuation started from phase ${state.nextStep ?? 'end'}${requested.length ? ' (' + requested.join('; ') + ')' : ''}; the original worktree and frozen scope are reused`)
      void this.dependencies.execute({
        contextPath: context.file, cwd: context.cwd, env: context.env, resume: true, ...input,
        // Readable progress lands in the same job log as the original rail run.
        onLine: logLine,
        onRawLine: (line) => {
          if (this.disposed) return
          let eventType = 'agent-runtime'
          try { const parsed = JSON.parse(line) as { type?: unknown }; if (typeof parsed.type === 'string') eventType = parsed.type } catch { /* Keep raw diagnostics available to recovery. */ }
          if (eventType === 'runtime-efficiency-event') {
            const validated = runtimeEfficiencyEventLine(line, runId)
            if (!validated || isRecordedRuntimeEfficiencyEvent(this.ctx.db, runId, validated)) return
            line = validated
          }
          this.ctx.db.transaction(() => {
            appendEvent(this.ctx.db, runId, ++sequence, { event_type: eventType, source: 'stdout', payload: line })
            updateLoopStepActivityCheckpoint(this.ctx.db, runId, stepKey, undefined, Date.now())
          })()
          try { this.ctx.broadcast?.({ type: 'event', jobId: runId, event_type: eventType, source: 'stdout', payload: line, seq: sequence, timestamp: new Date().toISOString() }) } catch { /* persisted event remains authoritative */ }
        },
        onSpawn: (child) => {
          active.child = child
          if (this.disposed && child.pid) this.dependencies.kill(child.pid, 'SIGKILL')
          else if (active.cancelled) this.cancel(runId)
        },
      }).then(async (result) => {
        if (this.disposed) return
        logLine(result.failed ? `[runtime] continuation ended: ${result.errorText ?? 'failed'}` : '[runtime] continuation completed', result.failed ? 'stderr' : 'stdout')
        setLoopStepSettledResult(this.ctx.db, runId, stepKey, { ...result, provider: 'agent-runtime', model: 'per-role', failed: active.cancelled || result.failed })
        recoverOrphanLoopStepAccounting(this.ctx.db, new Date().toISOString(), runId)
        if (result.errorText) this.errors.set(runId, result.errorText)
        if (!result.failed && !active.cancelled) await this.dependencies.settle?.({ db: this.ctx.db, projectId: this.ctx.project.id, runId, contextPath: context.file, cwd: context.cwd, env: context.env, broadcast: this.ctx.broadcast })
      }).catch(() => {
        if (this.disposed) return
        const message = 'Runtime continuation failed. Inspect the saved phase state before retrying.'
        this.errors.set(runId, message)
        logLine(`[runtime] ${message}`, 'stderr')
      })
        .finally(() => {
          clearTimeout(active.forceKillTimer); this.active.delete(runId)
          this.ctx.railLoopRuns?.delete(runId)
          this.statusCache.delete(runId)
          publishActivity(false)
        })
    } catch (error) {
      this.active.delete(runId)
      this.ctx.railLoopRuns?.delete(runId)
      try { this.ctx.broadcast?.({ type: 'runtime.continuation', projectId: this.ctx.project.id, jobId: runId, railIndex: parent.rail_index, active: false }) } catch { /* admission failed */ }
      throw error
    }
  }

  async settle(runId: string): Promise<void> {
    if (this.active.has(runId) || getLoopRun(this.ctx.db, runId)?.status !== 'completed') throw new RuntimeControlError(409, 'runtime_run_active', 'Wait for the execution to settle')
    const context = this.context(runId)
    this.active.set(runId, { cancelled: false })
    try {
      await (this.dependencies.settle ?? settleRuntimeContinuation)({ db: this.ctx.db, projectId: this.ctx.project.id, runId, contextPath: context.file, cwd: context.cwd, env: context.env, broadcast: this.ctx.broadcast })
      this.errors.delete(runId)
    } catch (error) {
      throw new RuntimeControlError(409, 'runtime_settlement_blocked', error instanceof Error ? error.message : 'Could not prepare the recovered delivery')
    } finally {
      this.active.delete(runId); this.statusCache.delete(runId)
      this.ctx.broadcast?.({ type: 'runtime.continuation', projectId: this.ctx.project.id, jobId: runId, railIndex: getLoopRun(this.ctx.db, runId)?.rail_index ?? null, active: false })
    }
  }

  /** Marker next to the frozen context: the rail card stops showing this run; history/log stay intact. */
  private dismissMarker(runId: string): string { return path.join(path.dirname(this.context(runId).file), 'desktop-runtime-dismissed') }
  isDismissed(runId: string): boolean { try { return fs.existsSync(this.dismissMarker(runId)) } catch { return false } }
  dismiss(runId: string): void {
    if (this.active.has(runId)) throw new RuntimeControlError(409, 'runtime_run_active', 'Stop the execution before dismissing it')
    const parent = getLoopRun(this.ctx.db, runId)
    if (parent && (parent.status === 'running' || parent.status === 'paused')) throw new RuntimeControlError(409, 'runtime_run_active', 'Stop the rail run before dismissing it')
    fs.writeFileSync(this.dismissMarker(runId), new Date().toISOString() + '\n', { mode: 0o600 })
    this.statusCache.delete(runId)
    this.ctx.broadcast?.({ type: 'runtime.continuation', projectId: this.ctx.project.id, jobId: runId, railIndex: parent?.rail_index ?? null, active: false })
  }

  cancel(runId: string): void {
    const active = this.active.get(runId)
    if (!active) throw new RuntimeControlError(409, 'runtime_not_active', 'Only a continuation started here can be cancelled here; stop active rail runs from their job controls')
    active.cancelled = true
    if (active.child?.pid) {
      this.dependencies.kill(active.child.pid, this.disposed ? 'SIGKILL' : 'SIGTERM')
      if (!this.disposed && !active.forceKillTimer) {
        const pid = active.child.pid
        active.forceKillTimer = setTimeout(() => {
          if (this.active.get(runId) === active) this.dependencies.kill(pid, 'SIGKILL')
        }, 3000)
        active.forceKillTimer.unref?.()
      }
    }
  }

  shutdown(): void {
    this.disposed = true
    for (const runId of this.active.keys()) this.cancel(runId)
  }
}
