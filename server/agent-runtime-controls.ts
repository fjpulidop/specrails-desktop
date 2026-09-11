import { execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { findCoreAgentRuntimeCli } from './agent-runtime-loader'
import { RUNTIME_HOST_ENV_KEYS, runAgentRuntimeInvocation } from './agent-runtime-bridge'
import { resolveCoreNodeRuntime } from './core-node-runtime'
import { treeKillSafe, windowsSpawnEnv } from './util/win-spawn'
import { resolveLoopBaseEnv, resolveProjectExecution } from './workspace-resolution'
import { getLoopRun, readLoopJobUsage, stageLoopStepRecovery, setLoopStepSettledResult, updateLoopStepActivityCheckpoint } from './loop-runs-store'
import { readExecutionManifest } from './multi-repo-execution-store'
import { appendEvent } from './db'
import { recoverOrphanLoopStepAccounting } from './loop-run-manager'
import type { ProjectContext } from './project-registry'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STEP_IDS = ['architect', 'developer', 'verify', 'reviewer', 'archive']
export interface RuntimeResumeInput { approve?: string[]; recover?: string[]; invalidate?: string[] }
interface FrozenContext { runId: string; backlogRoot: string; artifactRoot: string; repositories: Array<{ id: string; name: string; path: string }> }
interface RuntimeState {
  runId: string; status: string; nextStep: string | null; updatedAt?: string; error?: string
  pendingApproval?: { stepId: string; reason?: string }
  steps: Record<string, { status: string }>
}
export interface RuntimeRunSummary {
  runId: string; status: string; nextStep: string | null; updatedAt?: string; error?: string
  pendingApproval?: { stepId: string; reason?: string }
  recoverableSteps: string[]; active: boolean; canResume: boolean; canCancel: boolean
}
export class RuntimeControlError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message) }
}

export function validateRuntimeResumeInput(input: unknown): RuntimeResumeInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeControlError(400, 'invalid_resume_request', 'Resume request must be an object')
  const body = input as Record<string, unknown>
  for (const [key, value] of Object.entries(body)) {
    if (!['approve', 'recover', 'invalidate'].includes(key) || !Array.isArray(value) || value.length > STEP_IDS.length || !value.every((id) => typeof id === 'string' && STEP_IDS.includes(id)) || new Set(value).size !== value.length) throw new RuntimeControlError(400, 'invalid_resume_request', 'Only approve, recover and invalidate arrays of known phase IDs are allowed')
  }
  return body as RuntimeResumeInput
}

/** Status is a read-only Core CLI operation. It never invokes a provider. */
export async function readAgentRuntimeStatus(contextPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<RuntimeState | null> {
  const cli = findCoreAgentRuntimeCli()
  if (!cli) throw new RuntimeControlError(503, 'runtime_unavailable', 'Update Core to inspect or resume agent runtime executions')
  const { stdout } = await promisify(execFile)(resolveCoreNodeRuntime(), [cli, 'status', '--context', contextPath, '--compact'], {
    cwd, env: windowsSpawnEnv(env), windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
  })
  const result = JSON.parse(stdout) as { type?: string; state?: RuntimeState | null }
  if (result.type !== 'runtime-status' || result.state === undefined) throw new Error('Core returned an invalid runtime status')
  return result.state
}

/** One controller per ProjectContext; Core's durable lease remains the final
 * cross-process guard. Resume never constructs a new context or worktree. */
export class AgentRuntimeControls {
  private active = new Map<string, { child?: ChildProcess; cancelled: boolean; forceKillTimer?: ReturnType<typeof setTimeout> }>()
  private errors = new Map<string, string>()
  private statusCache = new Map<string, { fingerprint: string; state: RuntimeState }>()
  private disposed = false
  constructor(private ctx: Pick<ProjectContext, 'project' | 'db'>, private dependencies = { status: readAgentRuntimeStatus, execute: runAgentRuntimeInvocation, kill: treeKillSafe }) {}

  private context(runId: string): { file: string; frozen: FrozenContext; cwd: string; env: NodeJS.ProcessEnv } {
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
        if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) throw new Error()
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
      const stat = fs.existsSync(checkpoint) ? fs.statSync(checkpoint) : null
      const fingerprint = stat ? `${stat.mtimeMs}:${stat.size}` : null
      const cached = this.statusCache.get(runId)
      const state = fingerprint && cached?.fingerprint === fingerprint ? cached.state : await this.dependencies.status(file, cwd, env)
      if (!state || state.runId !== runId) throw new Error('No saved workflow state is available')
      if (fingerprint) this.statusCache.set(runId, { fingerprint, state })
      const parent = getLoopRun(this.ctx.db, runId)
      const active = this.active.has(runId) || parent?.status === 'running' || parent?.status === 'paused'
      const recoverableSteps = Object.entries(state.steps).filter(([, step]) => ['running', 'interrupted'].includes(step.status)).map(([id]) => id)
      return { runId, status: state.status === 'running' && !active ? 'interrupted' : state.status, nextStep: state.nextStep,
        updatedAt: state.updatedAt, error: this.errors.get(runId) ?? state.error, pendingApproval: state.pendingApproval,
        recoverableSteps, active, canCancel: this.active.has(runId), canResume: !active && parent?.status === 'completed' && state.status !== 'succeeded' }
    } catch (error) {
      return { runId, status: 'unavailable', nextStep: null, active: this.active.has(runId), canResume: false, canCancel: this.active.has(runId), recoverableSteps: [], error: error instanceof RuntimeControlError ? error.message : 'Could not inspect the saved runtime execution' }
    }
  }

  async resume(runId: string, input: RuntimeResumeInput): Promise<void> {
    if (this.disposed) throw new RuntimeControlError(503, 'runtime_shutting_down', 'Project runtime is shutting down')
    const parent = getLoopRun(this.ctx.db, runId)
    if (!parent || parent.status !== 'completed' || this.active.has(runId)) throw new RuntimeControlError(409, 'runtime_run_active', 'Wait for the original Desktop execution to settle before resuming')
    const context = this.context(runId)
    // Reserve before awaiting status so concurrent resume requests cannot race.
    const active = { cancelled: false } as { child?: ChildProcess; cancelled: boolean; forceKillTimer?: ReturnType<typeof setTimeout> }
    this.active.set(runId, active)
    try {
      // Accounting from a prior continuation must settle even when Core now
      // reports success and correctly refuses any further execution.
      recoverOrphanLoopStepAccounting(this.ctx.db, new Date().toISOString(), runId)
      const state = await this.dependencies.status(context.file, context.cwd, context.env)
      if (!state || state.runId !== runId || state.status === 'succeeded') throw new RuntimeControlError(409, 'runtime_not_resumable', 'This execution has no resumable workflow')
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
      }
      const requested = [...(input.approve?.length ? ['approve ' + input.approve.join(',')] : []), ...(input.recover?.length ? ['recover ' + input.recover.join(',')] : []), ...(input.invalidate?.length ? ['invalidate ' + input.invalidate.join(',')] : [])]
      logLine(`[runtime] continuation started from phase ${state.nextStep ?? 'end'}${requested.length ? ' (' + requested.join('; ') + ')' : ''}; the original worktree and frozen scope are reused`)
      void this.dependencies.execute({
        contextPath: context.file, cwd: context.cwd, env: context.env, resume: true, ...input,
        // Readable progress lands in the same job log as the original rail run.
        onLine: logLine,
        onRawLine: (line) => {
          if (this.disposed) return
          let eventType = 'agent-runtime'
          try { const parsed = JSON.parse(line) as { type?: unknown }; if (typeof parsed.type === 'string') eventType = parsed.type } catch { /* Keep raw diagnostics available to recovery. */ }
          this.ctx.db.transaction(() => {
            appendEvent(this.ctx.db, runId, ++sequence, { event_type: eventType, source: 'stdout', payload: line })
            updateLoopStepActivityCheckpoint(this.ctx.db, runId, stepKey, undefined, Date.now())
          })()
        },
        onSpawn: (child) => {
          active.child = child
          if (this.disposed && child.pid) this.dependencies.kill(child.pid, 'SIGKILL')
          else if (active.cancelled) this.cancel(runId)
        },
      }).then((result) => {
        if (this.disposed) return
        logLine(result.failed ? `[runtime] continuation ended: ${result.errorText ?? 'failed'}` : '[runtime] continuation completed', result.failed ? 'stderr' : 'stdout')
        setLoopStepSettledResult(this.ctx.db, runId, stepKey, { ...result, provider: 'agent-runtime', model: 'per-role', failed: active.cancelled || result.failed })
        recoverOrphanLoopStepAccounting(this.ctx.db, new Date().toISOString(), runId)
        if (result.errorText) this.errors.set(runId, result.errorText)
      }).catch(() => { this.errors.set(runId, 'Runtime continuation failed. Inspect the saved phase state before retrying.') })
        .finally(() => { clearTimeout(active.forceKillTimer); this.active.delete(runId) })
    } catch (error) { this.active.delete(runId); throw error }
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
