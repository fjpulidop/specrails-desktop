import { writeRuntimeHistory } from './agent-runtime-history'
import { toolRepositories, type RuntimeLogRepository } from './agent-runtime-repositories'
import { stripVTControlCharacters } from 'node:util'
import { resolveEffectiveRuntimeConfig } from './agent-runtime-effective-config'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix } from 'node:path'
import { createInterface } from 'node:readline'
import { findCoreAgentRuntimeCli, loadCoreAgentRuntime, validateRequestedRoleEfforts } from './agent-runtime-loader'
import { retainAgentRuntime, resolveRetainedAgentRuntime } from './agent-runtime-package'
import { loadRuntimeConfigFile, loadRuntimeRolePrompts, stripDesktopConnectionFields, coreConnectionFieldGates } from './agent-runtime-settings'
import { resolveCoreNodeRuntime } from '../../../core-node-runtime'
import { treeKillSafe, windowsSpawnEnv } from '../../../util/win-spawn'
import type { DefinitionCompletion, DefinitionInterrupt, DefinitionPrepared } from '../../loops/runtime/loop-definition-run'
import type { RuntimeConfig } from './agent-runtime-settings'
import type { AiStepResult } from '../../loops/runtime/loop-run-manager'

export function runtimeChangeName(runId: string): string {
  return 'runtime-' + createHash('sha256').update(runId).digest('hex').slice(0, 20)
}

/**
 * Host checks belong to the directory the user registered: for a package of a
 * larger checkout (Core scope) they run in that package, never at the checkout
 * root where a monorepo test script fans out to every workspace. An explicit
 * cwd is relative to the registered directory; one already inside the scope is kept.
 */
export function scopedHostChecks<T extends { repositoryId: string; cwd?: string }>(checks: readonly T[], repositories: ReadonlyArray<{ id: string; scope?: string[] }> = []): T[] {
  return checks.map(check => {
    const scope = repositories.find(repository => repository.id === check.repositoryId)?.scope?.[0]
    if (!scope || (check.cwd !== undefined && isAbsolute(check.cwd))) return check
    const cwd = (check.cwd ?? '.').replace(/\\/g, '/')
    const inside = cwd === scope || cwd.startsWith(scope + '/')
    return { ...check, cwd: inside ? cwd : posix.normalize(posix.join(scope, cwd)) }
  })
}

export const RUNTIME_HOST_ENV_KEYS = [
  'SPECRAILS_REPO_DIR', 'SPECRAILS_GIT_AUTO', 'SPECRAILS_REPO_MAP_PATH',
  'SPECRAILS_EXECUTION_CONTEXT', 'SPECRAILS_EXECUTION_MANIFEST', 'SPECRAILS_REPOSITORIES',
  'SPECRAILS_WORKSPACE_DIR', 'SPECRAILS_TICKETS_PATH', 'SPECRAILS_STATE_DIR',
  'SPECRAILS_BACKLOG_CONFIG_PATH', 'SPECRAILS_PROFILES_DIR',
  'SPECRAILS_PROFILE_PATH',
] as const

function saveHostContext(options: AgentRuntimeInvocationOptions): void {
  const file = join(dirname(options.contextPath), 'desktop-runtime-host.json')
  const serialized = JSON.stringify({ schemaVersion: 1, cwd: realpathSync(options.cwd), env: Object.fromEntries(
    RUNTIME_HOST_ENV_KEYS.filter(key => options.env[key] !== undefined).map(key => [key, options.env[key]]),
  ) }, null, 2) + '\n'
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  try { writeFileSync(file, serialized, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (readFileSync(file, 'utf8') !== serialized) throw new Error('Desktop runtime scope changed; resume using its frozen host context')
  }
}

/** Recover the original host scope; project settings may have changed since admission. */
export function readFrozenRuntimeHost(contextPath: string, baseEnv: NodeJS.ProcessEnv, runId: string): {cwd: string; env: NodeJS.ProcessEnv} {
  const context = JSON.parse(readFileSync(contextPath,'utf8')) as {runId?: unknown;backlogRoot?: string;artifactRoot?: string;repositories?: Array<{path?: string}>}
  const roots = [context.backlogRoot, ...(context.repositories ?? []).map(repository => repository.path)]
  if (context.runId !== runId || !context.repositories?.length || !context.repositories.some(repository => repository.path === context.artifactRoot) || roots.some(root => typeof root !== 'string' || !isAbsolute(root) || realpathSync(root) !== root)) throw new Error('runtime_scope_changed: Original workflow scope is unavailable')
  const host = JSON.parse(readFileSync(join(dirname(contextPath),'desktop-runtime-host.json'),'utf8')) as {schemaVersion?: number;cwd?: string;env?: Record<string,string>}
  if (host.schemaVersion !== 1 || typeof host.cwd !== 'string' || !roots.includes(host.cwd) || !host.env || typeof host.env !== 'object' || Array.isArray(host.env) || Object.entries(host.env).some(([key,value]) => !(RUNTIME_HOST_ENV_KEYS as readonly string[]).includes(key) || typeof value !== 'string') || host.env.SPECRAILS_GIT_AUTO !== 'false') throw new Error('runtime_host_invalid: Original workflow host settings are invalid')
  const env = {...baseEnv}
  for (const key of RUNTIME_HOST_ENV_KEYS) delete env[key]
  return {cwd:host.cwd,env:{...env,...host.env,SPECRAILS_EXECUTION_CONTEXT:contextPath}}
}

export interface AgentRuntimeInvocationOptions {
  contextPath: string
  cwd: string
  env: NodeJS.ProcessEnv
  configPath?: string
  definitionPath?: string
  engineVersion?: 2
  /** Pure compile callback receives the same effective config that Core will read. */
  onPrepared?(metadata: DefinitionPrepared): void
  prepareDefinition?(config: Readonly<RuntimeConfig>): unknown
  defaultProvider?: string
  /** A selected launch provider applies to every role; absent selection preserves role settings. */
  providerOverride?: { provider: string; model?: string; effort?: string }
  change?: string
  resume?: boolean
  approve?: string[]
  recover?: string[]
  invalidate?: string[]
  /** Answers the pending architect question on resume. */
  answer?: string
  interruptId?: string
  /** Durable projection errors abort observation; ordinary log callbacks remain advisory. */
  onRuntimeEvent?(event: Record<string, unknown>): void
  timeoutMs?: number
  onLine?: (line: string, source?: 'stdout' | 'stderr') => void
  onRawLine?: (line: string) => void
  onSpawn?: (child: ChildProcess) => void
}

interface RuntimeResult {
  type: 'runtime-result'
  runId?: string
  status?: string
  engineVersion?: number
  error?: string | { code?: string; message?: string }
  completion?: DefinitionCompletion
  pendingInterrupts?: DefinitionInterrupt[]
  pendingApproval?: { stepId?: string; reason?: string }
  pendingQuestion?: { stepId?: string; question?: string }
  usage?: { durationMs?: number | null }
  invocationUsage?: { costUsd?: number | null; inputTokens?: number | null; outputTokens?: number | null }
}

/** Core owns the complete agent workflow in one managed process. The existing
 * rail's cancellation and worktree ownership remain in Desktop. */
export async function runAgentRuntimeInvocation(options: AgentRuntimeInvocationOptions): Promise<AiStepResult> {
  const definitionEngine = options.engineVersion === 2 || options.definitionPath !== undefined || options.prepareDefinition !== undefined
  if (options.resume && (options.definitionPath || options.prepareDefinition)) throw new Error('Resume must use the frozen workflow definition')
  const selectedCli = options.resume ? resolveRetainedAgentRuntime(options.contextPath) : findCoreAgentRuntimeCli()
  let cli = selectedCli
  if (!cli) throw new Error('Programmatic agent runtime is enabled but its Core CLI is unavailable. Build or bundle the compatible Core runtime.')
  if (!options.resume && (!options.configPath || !options.change)) throw new Error('New programmatic runs require configuration and a change name')
  const admittedContext = JSON.parse(readFileSync(options.contextPath, 'utf8')) as { runId?: unknown; artifactRoot?: string; repositories?: Array<RuntimeLogRepository & { scope?: string[] }> }
  if (typeof admittedContext.runId !== 'string') throw new Error('Core context is missing its run identity')
  const args = [cli, options.resume ? 'resume' : 'run', '--context', options.contextPath]
  if (!options.resume) {
    if (!Array.isArray(admittedContext.repositories) || !admittedContext.repositories.length || admittedContext.repositories.some(repo => !repo || typeof repo.id !== 'string' || !repo.id)) throw new Error('Core context is missing its repository scope')
    const source = existsSync(options.configPath!) ? 'project-role' : 'default'
    const { config, origins } = resolveEffectiveRuntimeConfig(loadRuntimeConfigFile(options.configPath!, options.defaultProvider), {
      repositoryIds: admittedContext.repositories.map(repo => repo.id), source, providerOverride: options.providerOverride,
    })
    config.verification = scopedHostChecks(config.verification, admittedContext.repositories)
    config.rolePrompts = { ...(await loadCoreAgentRuntime()).rolePromptDefaults(), ...loadRuntimeRolePrompts(), ...config.rolePrompts }
    // Core rejects unknown connection keys: drop the desktop-only local-engine
    // fields (label/defaultModel/rates/supportsReasoningEffort) before Core sees it.
    const runtime = await loadCoreAgentRuntime()
    config.providers = stripDesktopConnectionFields(config.providers, coreConnectionFieldGates(runtime.api?.capabilities))
    if (runtime.api?.capabilities?.configurableGuardrails !== 1) delete (config as { guardrails?: unknown }).guardrails
    if (definitionEngine && (runtime.api?.capabilities?.engineV2 !== 1 || runtime.api?.capabilities?.workflowDefinitions !== 1)) throw new Error('engine_unsupported: Update Core to run workflow definitions')
    const override = options.providerOverride
    runtime.validateRuntimeConfig(JSON.parse(JSON.stringify(config)))
    validateRequestedRoleEfforts(runtime, config)
    cli = retainAgentRuntime(cli, options.contextPath)
    args[0] = cli
    saveHostContext(options)
    const selectionFile = join(dirname(options.contextPath), 'desktop-runtime-selection.json')
    const selection = JSON.stringify({ schemaVersion: 1, runId: admittedContext.runId, providerOverride: override ?? null, origins }) + '\n'
    try { writeFileSync(selectionFile, selection, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(selectionFile, 'utf8') !== selection) throw new Error('Runtime selection provenance changed; start a new run') }
    const scopedPath = join(dirname(options.contextPath), 'desktop-runtime-config.json')
    const serialized = JSON.stringify(config, null, 2) + '\n'
    try { writeFileSync(scopedPath, serialized, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (readFileSync(scopedPath, 'utf8') !== serialized) throw new Error('Desktop runtime configuration changed; start a new run')
    }
    if (definitionEngine) {
      const draft = options.prepareDefinition
        ? options.prepareDefinition(structuredClone(config))
        : options.definitionPath ? JSON.parse(readFileSync(options.definitionPath, 'utf8')) : undefined
      if (!draft) throw new Error('A new Core workflow requires a definition')
      const validation = runtime.validateWorkflowDefinition(draft, { configPath: scopedPath, structural: false })
      if (!validation.ok) throw new Error('definition_invalid: ' + validation.errors.map(error => `${error.path ?? error.nodeId ?? 'graph'}: ${error.message}`).join('; '))
      const definitionPath = join(dirname(options.contextPath), 'desktop-workflow-definition.json')
      const serializedDefinition = JSON.stringify(validation.definition, null, 2) + '\n'
      try { writeFileSync(definitionPath, serializedDefinition, { flag: 'wx', mode: 0o600 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(definitionPath, 'utf8') !== serializedDefinition) throw new Error('Frozen workflow definition changed; start a new run') }
      const pinPath = join(dirname(options.contextPath), 'desktop-runtime-package.json')
      options.onPrepared?.({ contextPath: options.contextPath, runtimeDirectory: dirname(options.contextPath), definitionPath, configPath: scopedPath, definitionHash: validation.version, definition: validation.definition as Record<string, unknown>, context: admittedContext as Record<string, unknown>, ...(existsSync(pinPath) ? {runtimeIdentity: JSON.parse(readFileSync(pinPath,'utf8')) as Record<string,unknown>} : {}) })
      args.push('--definition', definitionPath)
    }
    args.push('--config', scopedPath, '--change', options.change!)
  }
  const frozenPath = join(dirname(options.contextPath), 'desktop-runtime-config.json')
  if (existsSync(frozenPath)) {
    const frozen = JSON.parse(readFileSync(frozenPath, 'utf8')) as { agents: Record<string, { provider: string; model?: string }>; fixer?: { provider: string; model?: string } }
    for (const [role, assignment] of [...Object.entries(frozen.agents), ...(frozen.fixer ? [['fixer', frozen.fixer] as const] : [])]) {
      try { options.onLine?.(`[runtime] ${role}: ${assignment.provider}/${assignment.model ?? 'provider default'}\n`) } catch { /* Log observers cannot prevent execution. */ }
    }
  }
  for (const [flag, values] of [['approve', options.approve], ['recover', options.recover], ['invalidate', options.invalidate]] as const) {
    if (values?.length) args.push('--' + flag, values.join(','))
  }
  if (options.answer !== undefined) {
    if (!options.resume) throw new Error('Answers apply to runtime resume')
    args.push('--answer', options.answer)
  }
  if (options.interruptId) { if (!options.resume) throw new Error('Interrupt selection applies to resume'); args.push('--interrupt-id', options.interruptId) }
  const started = Date.now()
  writeRuntimeHistory(options.contextPath, { status: 'running' })
  return new Promise<AiStepResult>((resolve) => {
    let result: RuntimeResult | undefined
    let graph: Record<string, unknown> | undefined
    let stderr = '', summary = '', invalidProtocol = false, timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const child = spawn(resolveCoreNodeRuntime(), args, {
      cwd: options.cwd, env: windowsSpawnEnv(options.env), shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Always leave a terminal result, including synchronous observer failures.
    let observerError: string | undefined
    try { options.onSpawn?.(child) } catch (error) {
      observerError = error instanceof Error ? error.message : String(error)
      if (child.pid) treeKillSafe(child.pid, 'SIGKILL')
    }
    const observe = (callback: (() => void) | undefined): void => { try { callback?.() } catch { /* Logging cannot replay a workflow. */ } }
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', line => {
      if (line.length > 2_000_000) { invalidProtocol = true; if (child.pid) treeKillSafe(child.pid, 'SIGKILL'); return }
      let event: Record<string, unknown>
      try { event = JSON.parse(line) as Record<string, unknown> } catch { invalidProtocol = true; return }
      if (!event || typeof event !== 'object') { invalidProtocol = true; return }
      if (event.type === 'agent-event' && event.event && typeof event.event === 'object' && (event.event as { kind?: string }).kind === 'tool-start' && (admittedContext.repositories?.length ?? 0) > 1) {
        const repositories = toolRepositories(event.event, admittedContext.repositories!, admittedContext.artifactRoot ?? options.cwd)
        if (repositories.length) event.repositories = repositories.map(repo => ({ id: repo.id, name: repo.name || repo.id }))
      }
      if (definitionEngine && ((typeof event.runId === 'string' && event.runId !== admittedContext.runId) || (event.type === 'workflow-event' && (event.event as { runId?: unknown })?.runId !== admittedContext.runId))) { invalidProtocol = true; if (child.pid) treeKillSafe(child.pid, 'SIGKILL'); return }
      try { options.onRuntimeEvent?.(event) } catch (error) {
        observerError = error instanceof Error ? error.message : String(error)
        if (child.pid) treeKillSafe(child.pid, 'SIGKILL')
        return
      }
      if (event.type === 'runtime-graph') graph = event
      observe(() => options.onRawLine?.(event.repositories ? JSON.stringify(event) : line))
      if (event.type === 'runtime-result') {
        if (result) invalidProtocol = true
        result = event as unknown as RuntimeResult
      } else if (event.type === 'workflow-event') {
        const payload = event.event as { type?: string; stepId?: string; message?: string }
        if (payload?.type) observe(() => options.onLine?.(`[runtime] ${payload.type}${payload.stepId ? ': ' + payload.stepId : ''}${payload.message ? ' — ' + payload.message : ''}\n`))
      } else if (event.type === 'agent-event') {
        const payload = event.event as { kind?: string; text?: string; tool?: string; detail?: string }
        const role = typeof event.role === 'string' ? event.role : 'agent'
        if (payload?.kind === 'text' && typeof payload.text === 'string') {
          summary = (summary + payload.text).slice(-32_000)
          observe(() => options.onLine?.(payload.text + '\n'))
        } else if (payload?.kind === 'tool-start' && typeof payload.tool === 'string') {
          // Live tool activity keeps a long developer turn from looking hung.
          const repositories = event.repositories as Array<{ name: string }> | undefined
          const scope = repositories?.length ? ` [${repositories.map(repo => repo.name).join(' + ')}]` : ''
          observe(() => options.onLine?.(`[${role}]${scope} ${payload.tool}${payload.detail ? ' ' + payload.detail : ''}\n`))
        }
      } else if (event.type === 'verification-output' && typeof event.text === 'string') {
        observe(() => options.onLine?.(stripVTControlCharacters(String(event.text))))
      } else if (event.type === 'span') {
        // Trace spans are telemetry; the raw line is already recorded for diagnostics.
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-32_000)
      observe(() => options.onLine?.(chunk.toString('utf8'), 'stderr'))
    })
    child.on('error', error => { stderr = error.message })
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        if (child.pid) treeKillSafe(child.pid, 'SIGKILL')
      }, options.timeoutMs)
      timer.unref?.()
    }
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      lines.close()
      const usage = result?.invocationUsage
      const known = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
      const cost = known(usage?.costUsd), tokensIn = known(usage?.inputTokens), tokensOut = known(usage?.outputTokens)
      if (result?.status === 'succeeded' && result.runId !== admittedContext.runId) invalidProtocol = true
      if (definitionEngine && result?.status === 'succeeded' && (!result.completion || typeof result.completion.ok !== 'boolean' || typeof result.completion.verified !== 'boolean' || (!Array.isArray(result.completion.reasons) || result.completion.reasons.some(reason => typeof reason !== 'string')))) invalidProtocol = true
      if (definitionEngine && result?.status === 'paused' && result.runId !== admittedContext.runId) invalidProtocol = true
      const validPause = definitionEngine && code === 2 && result?.status === 'paused'
      const failed = (!validPause && (code !== 0 || result?.status !== 'succeeded')) || invalidProtocol || timedOut || Boolean(observerError)
      const runtimeError = typeof result?.error === 'string' ? result.error : result?.error?.message
      const runtimeStatus: AiStepResult['runtimeStatus'] = invalidProtocol || timedOut || observerError || (result?.status === 'paused' && !validPause) || (result?.status === 'succeeded' && code !== 0) ? 'failed' : ['succeeded', 'paused', 'failed', 'blocked', 'cancelled'].includes(result?.status ?? '') ? result!.status as AiStepResult['runtimeStatus'] : 'failed'
      const errorText = observerError ?? (timedOut ? 'Programmatic workflow timed out; inspect its checkpoint before recovery'
        : invalidProtocol ? 'Core returned an invalid runtime event stream'
        : runtimeError ?? (result?.status === 'paused' ? (typeof result.pendingQuestion?.question === 'string' && result.pendingQuestion.question.trim()
          ? `Workflow awaits an answer in Agent Runtime settings: ${result.pendingQuestion.question.trim().slice(0, 500)}`
          : 'Workflow awaits approval in Agent Runtime settings')
        : failed ? stderr || 'Core exited without a successful programmatic workflow result' : undefined))
      try { writeRuntimeHistory(options.contextPath, invalidProtocol || timedOut || observerError || !result ? { status: 'failed', error: errorText } : { ...result }) } catch { /* Projection failure cannot replay a completed execution. */ }
      resolve({
        text: summary || (failed ? errorText ?? '' : definitionEngine ? 'Workflow execution completed.' : 'Programmatic implementation verified and archived.'),
        provider: 'agent-runtime', model: 'per-role', failed, errorText,
        ...(definitionEngine ? { runtimeStatus, completion: result?.completion, pendingInterrupts: result?.pendingInterrupts, pendingQuestion: result?.pendingQuestion, pendingApproval: result?.pendingApproval, graph } : {}),
        cost, tokensIn, tokensOut, tokens: tokensIn === undefined || tokensOut === undefined ? undefined : tokensIn + tokensOut,
        estimated: cost === undefined, durationMs: definitionEngine ? known(result?.usage?.durationMs) : Date.now() - started,
      })
    })
  })
}

// ─── Retained-runtime control verbs (fork / cancel) ──────────────────────────

interface AgentRuntimeControlBase {
  contextPath: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** The run the frozen context belongs to; a mismatch never spawns. */
  runId: string
  timeoutMs?: number
  onLine?: (line: string, source?: 'stdout' | 'stderr') => void
}
export type AgentRuntimeControlInvocation =
  | (AgentRuntimeControlBase & { kind: 'fork'; childRunId: string; fromNodePath: string; scopeId?: string; visit?: number; state?: Record<string, unknown> })
  | (AgentRuntimeControlBase & { kind: 'cancel'; requestId: string })
  | (AgentRuntimeControlBase & { kind: 'signal'; requestId: string; text: string })
export interface AgentRuntimeForkResult {
  kind: 'fork'
  runId: string
  forkOf: string
  fromNodePath: string
  scopeId: string | null
  visit: number | null
  revision: number | null
  /** Core's private run directory of the child (`.../pipeline/<child>/agent-workflow`). */
  directory: string
  contextPath: string
  runtimeDirectory: string
  definitionPath: string
  configPath: string
  context: Record<string, unknown>
}
export interface AgentRuntimeCancelResult { kind: 'cancel'; requestId: string | null; accepted: Record<string, unknown> }
export interface AgentRuntimeSignalResult { kind: 'signal'; id: string; acceptedAt: string }

const CONTROL_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CONTROL_TIMEOUT_MS = 60_000

function controlError(event: Record<string, unknown> | undefined, fallback: string): Error {
  const error = event?.error as string | { code?: string; message?: string } | undefined
  if (typeof error === 'string') return new Error(error)
  if (error && typeof error === 'object') return new Error([error.code, error.message].filter(Boolean).join(': ') || fallback)
  return new Error(fallback)
}

function runControlProcess(args: string[], options: AgentRuntimeControlBase, input?: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const events: Array<Record<string, unknown>> = []
    let stderr = '', invalid = false, timedOut = false
    const child = spawn(resolveCoreNodeRuntime(), args, { cwd: options.cwd, env: windowsSpawnEnv(options.env), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin!.on('error', () => { /* An early Core rejection is handled through its exit/result. */ })
    child.stdin!.end(input)
    let bytes = 0
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) { invalid = true; if (child.pid) treeKillSafe(child.pid, 'SIGKILL') }
    })
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', line => {
      if (invalid || !line.trim()) return
      try {
        const event = JSON.parse(line) as unknown
        if (!event || typeof event !== 'object' || Array.isArray(event)) { invalid = true; return }
        events.push(event as Record<string, unknown>)
      } catch { invalid = true }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-32_000)
      try { options.onLine?.(chunk.toString('utf8'), 'stderr') } catch { /* advisory */ }
    })
    child.on('error', error => { stderr = error.message })
    const timer = setTimeout(() => { timedOut = true; if (child.pid) treeKillSafe(child.pid, 'SIGKILL') }, options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : CONTROL_TIMEOUT_MS)
    timer.unref?.()
    child.on('close', code => {
      clearTimeout(timer)
      lines.close()
      const failure = events.find(event => event.type === 'runtime-result' && event.status === 'failed')
      if (timedOut) return reject(new Error('timeout: Core control command did not finish in time'))
      if (failure) return reject(controlError(failure, 'Core control command failed'))
      if (invalid) return reject(new Error('Core returned an invalid control event stream'))
      if (code !== 0) return reject(new Error(stderr.trim() || `Core control command exited with code ${code}`))
      resolve(events)
    })
  })
}

function swapRunId(file: string, runId: string): string {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  return JSON.stringify({ ...parsed, runId }, null, 2) + '\n'
}

/** Freeze the child's Desktop-side files from the SOURCE run's frozen files, never from live project settings. */
function materializeForkedRun(sourceContextPath: string, childRunId: string, childContextPath: string): Pick<AgentRuntimeForkResult, 'contextPath' | 'runtimeDirectory' | 'definitionPath' | 'configPath' | 'context'> {
  const source = dirname(sourceContextPath), target = dirname(childContextPath)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const write = (name: string, content: string): string => { const file = join(target, name); writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); return file }
  const copy = (name: string, required = false): string | undefined => {
    const from = join(source, name)
    if (!existsSync(from)) { if (required) throw new Error(`Source run is missing ${name}`); return undefined }
    copyFileSync(from, join(target, name), 1 /* COPYFILE_EXCL */)
    return join(target, name)
  }
  const context = swapRunId(sourceContextPath, childRunId)
  write('desktop-context.json', context)
  copy('desktop-runtime-package.json', true)
  const hostFile = join(source, 'desktop-runtime-host.json')
  if (existsSync(hostFile)) {
    const host = JSON.parse(readFileSync(hostFile, 'utf8')) as { env?: Record<string, string> }
    if (host.env && typeof host.env === 'object' && host.env.SPECRAILS_EXECUTION_CONTEXT !== undefined) host.env = { ...host.env, SPECRAILS_EXECUTION_CONTEXT: childContextPath }
    write('desktop-runtime-host.json', JSON.stringify(host, null, 2) + '\n')
  }
  const configPath = copy('desktop-runtime-config.json') ?? join(target, 'desktop-runtime-config.json')
  const definitionPath = copy('desktop-workflow-definition.json') ?? join(target, 'desktop-workflow-definition.json')
  if (existsSync(join(source, 'desktop-runtime-selection.json'))) write('desktop-runtime-selection.json', swapRunId(join(source, 'desktop-runtime-selection.json'), childRunId))
  return { contextPath: childContextPath, runtimeDirectory: target, definitionPath, configPath, context: JSON.parse(context) as Record<string, unknown> }
}

/**
 * Fork or cancel a retained Core run. Both verbs use the ORIGINAL retained
 * runtime and the frozen context: current project settings never enter. Fork
 * produces the child's Core database through Core and then freezes the child's
 * Desktop files as copies of the source's frozen inputs; the source directory
 * is only read. Cancel is Core's idempotent inbox request.
 */
export async function runAgentRuntimeControl(options: AgentRuntimeControlInvocation & { kind: 'fork' }): Promise<AgentRuntimeForkResult>
export async function runAgentRuntimeControl(options: AgentRuntimeControlInvocation & { kind: 'cancel' }): Promise<AgentRuntimeCancelResult>
export async function runAgentRuntimeControl(options: AgentRuntimeControlInvocation & { kind: 'signal' }): Promise<AgentRuntimeSignalResult>
export async function runAgentRuntimeControl(options: AgentRuntimeControlInvocation): Promise<AgentRuntimeForkResult | AgentRuntimeCancelResult | AgentRuntimeSignalResult> {
  const cli = resolveRetainedAgentRuntime(options.contextPath)
  const admitted = JSON.parse(readFileSync(options.contextPath, 'utf8')) as { runId?: unknown }
  if (typeof admitted.runId !== 'string' || admitted.runId !== options.runId) throw new Error('runtime_scope_changed: Frozen context belongs to another run')
  const args = [cli, options.kind, '--context', options.contextPath]
  if (options.kind === 'signal') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.requestId) || typeof options.text !== 'string' || !options.text.trim() || options.text.length > 20_000) throw new Error('invalid_arguments: Steering requires a safe request id and 1–20,000 characters')
    args.push('--request-id', options.requestId, '--stdin')
    const events = await runControlProcess(args, options, options.text)
    const accepted = events.find(event => event.type === 'runtime-signal-accepted')
    if (accepted?.id !== options.requestId || typeof accepted.acceptedAt !== 'string' || !Number.isFinite(Date.parse(accepted.acceptedAt))) throw new Error('Core did not acknowledge the steering request')
    return { kind: 'signal', id: accepted.id as string, acceptedAt: accepted.acceptedAt }
  }
  if (options.kind === 'cancel') {
    if (typeof options.requestId !== 'string' || !options.requestId.trim()) throw new Error('invalid_arguments: Cancellation requires a request id')
    args.push('--request-id', options.requestId)
    const events = await runControlProcess(args, options)
    const accepted = events.find(event => event.type === 'runtime-cancellation-accepted')
    if (!accepted) throw new Error('Core did not acknowledge the cancellation request')
    return { kind: 'cancel', requestId: options.requestId, accepted }
  }
  if (!CONTROL_RUN_ID.test(options.childRunId) || options.childRunId === options.runId) throw new Error('invalid_arguments: Fork requires a distinct child run id')
  if (typeof options.fromNodePath !== 'string' || !options.fromNodePath.trim()) throw new Error('invalid_arguments: Fork requires a node path')
  if (options.visit !== undefined && (!Number.isSafeInteger(options.visit) || options.visit < 1)) throw new Error('invalid_arguments: Fork visit must be a positive integer')
  if (options.scopeId !== undefined && (typeof options.scopeId !== 'string' || !options.scopeId)) throw new Error('invalid_arguments: Fork scope must be a non-empty string')
  const childContextPath = join(dirname(dirname(options.contextPath)), options.childRunId, 'desktop-context.json')
  const childRuntimeDirectory = dirname(childContextPath)
  if (existsSync(childRuntimeDirectory)) throw new Error('run_exists: A run directory already exists for the fork child')
  args.push('--from', options.fromNodePath, '--run-id', options.childRunId)
  if (options.scopeId !== undefined) args.push('--scope-id', options.scopeId)
  if (options.visit !== undefined) args.push('--visit', String(options.visit))
  let staged: string | undefined
  if (options.state !== undefined) {
    if (!options.state || typeof options.state !== 'object' || Array.isArray(options.state)) throw new Error('invalid_arguments: Fork state must be an object')
    staged = mkdtempSync(join(tmpdir(), 'specrails-fork-'))
    const stateFile = join(staged, 'state.json')
    writeFileSync(stateFile, JSON.stringify(options.state), { mode: 0o600 })
    args.push('--state', stateFile)
  }
  const cleanupChild = (): void => {
    // Only the brand-new child directory is removable; it sits next to the source under pipeline/.
    if (basename(childRuntimeDirectory) === options.childRunId && basename(dirname(childRuntimeDirectory)) === 'pipeline') rmSync(childRuntimeDirectory, { recursive: true, force: true })
  }
  try {
    const events = await runControlProcess(args, options)
    const forked = events.find(event => event.type === 'runtime-forked') as { runId?: unknown; forkOf?: unknown; fromNodePath?: unknown; scopeId?: unknown; visit?: unknown; revision?: unknown; directory?: unknown } | undefined
    if (!forked || forked.runId !== options.childRunId || forked.forkOf !== options.runId || typeof forked.directory !== 'string') throw new Error('Core returned an invalid fork result')
    if (!existsSync(join(forked.directory, 'run.sqlite')) || realpathSync(dirname(forked.directory)) !== realpathSync(childRuntimeDirectory)) throw new Error('Core placed the fork outside the expected run directory')
    const frozen = materializeForkedRun(options.contextPath, options.childRunId, childContextPath)
    return { kind: 'fork', runId: options.childRunId, forkOf: options.runId, fromNodePath: options.fromNodePath,
      scopeId: typeof forked.scopeId === 'string' ? forked.scopeId : null, visit: typeof forked.visit === 'number' ? forked.visit : null,
      revision: typeof forked.revision === 'number' ? forked.revision : null, directory: forked.directory, ...frozen }
  } catch (error) {
    try { cleanupChild() } catch { /* the failure below is authoritative */ }
    throw error
  } finally {
    if (staged) rmSync(staged, { recursive: true, force: true })
  }
}
