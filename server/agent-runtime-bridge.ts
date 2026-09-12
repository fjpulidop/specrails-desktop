import { toolRepositories, type RuntimeLogRepository } from './agent-runtime-repositories'
import { stripVTControlCharacters } from 'node:util'
import { getAdapter } from './providers'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { findCoreAgentRuntimeCli, loadCoreAgentRuntime } from './agent-runtime-loader'
import { loadRuntimeConfigFile, loadRuntimeRolePrompts } from './agent-runtime-settings'
import { resolveCoreNodeRuntime } from './core-node-runtime'
import { treeKillSafe, windowsSpawnEnv } from './util/win-spawn'
import type { AiStepResult } from './loop-run-manager'

export function runtimeChangeName(runId: string): string {
  return 'runtime-' + createHash('sha256').update(runId).digest('hex').slice(0, 20)
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

export interface AgentRuntimeInvocationOptions {
  contextPath: string
  cwd: string
  env: NodeJS.ProcessEnv
  configPath?: string
  defaultProvider?: string
  selectedModel?: string
  change?: string
  resume?: boolean
  approve?: string[]
  recover?: string[]
  invalidate?: string[]
  /** Answers the pending architect question on resume. */
  answer?: string
  timeoutMs?: number
  onLine?: (line: string, source?: 'stdout' | 'stderr') => void
  onRawLine?: (line: string) => void
  onSpawn?: (child: ChildProcess) => void
}

interface RuntimeResult {
  type: 'runtime-result'
  runId?: string
  status?: string
  error?: string
  pendingQuestion?: { stepId?: string; question?: string }
  invocationUsage?: { costUsd?: number | null; inputTokens?: number | null; outputTokens?: number | null }
}

/** Core owns the complete agent workflow in one managed process. The existing
 * rail's cancellation and worktree ownership remain in Desktop. */
export async function runAgentRuntimeInvocation(options: AgentRuntimeInvocationOptions): Promise<AiStepResult> {
  const cli = findCoreAgentRuntimeCli()
  if (!cli) throw new Error('Programmatic agent runtime is enabled but its Core CLI is unavailable. Build or bundle the compatible Core runtime.')
  if (!options.resume && (!options.configPath || !options.change)) throw new Error('New programmatic runs require configuration and a change name')
  const admittedContext = JSON.parse(readFileSync(options.contextPath, 'utf8')) as { runId?: unknown; artifactRoot?: string; repositories?: RuntimeLogRepository[] }
  if (typeof admittedContext.runId !== 'string') throw new Error('Core context is missing its run identity')
  if (!options.resume) saveHostContext(options)
  const args = [cli, options.resume ? 'resume' : 'run', '--context', options.contextPath]
  if (!options.resume) {
    if (!Array.isArray(admittedContext.repositories) || !admittedContext.repositories.length || admittedContext.repositories.some(repo => !repo || typeof repo.id !== 'string' || !repo.id)) throw new Error('Core context is missing its repository scope')
    const config = loadRuntimeConfigFile(options.configPath!, options.defaultProvider)
    config.rolePrompts = { ...(await loadCoreAgentRuntime()).rolePromptDefaults(), ...loadRuntimeRolePrompts() }
    if (options.defaultProvider) {
      const provider = config.providers.find(entry => entry.id === options.defaultProvider)
      if (!provider) throw new Error(`Selected runtime provider is not configured: ${options.defaultProvider}`)
      for (const role of Object.values(config.agents)) {
        if (role.provider !== provider.id) {
          role.provider = provider.id
          role.model = options.selectedModel ?? (provider.kind === 'cli' ? getAdapter(provider.cli).defaultModel() : undefined)
          if (!role.model) throw new Error(`Selected runtime provider requires a model: ${provider.id}`)
        }
        if (!role.model && provider.kind === 'cli') role.model = getAdapter(provider.cli).defaultModel()
      }
      if (options.selectedModel) config.agents.developer.model = options.selectedModel
    }
    const selected = new Set(admittedContext.repositories.map(repo => repo.id))
    // Project settings cover every repository; a ticket may select only a subset.
    // Freeze that subset for admission without changing the project settings.
    config.verification = config.verification.filter(command => selected.has(command.repositoryId))
    const scopedPath = join(dirname(options.contextPath), 'desktop-runtime-config.json')
    const serialized = JSON.stringify(config, null, 2) + '\n'
    try { writeFileSync(scopedPath, serialized, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (readFileSync(scopedPath, 'utf8') !== serialized) throw new Error('Desktop runtime configuration changed; start a new run')
    }
    args.push('--config', scopedPath, '--change', options.change!)
  }
  const frozenPath = join(dirname(options.contextPath), 'desktop-runtime-config.json')
  if (existsSync(frozenPath)) {
    const frozen = JSON.parse(readFileSync(frozenPath, 'utf8')) as { agents: Record<string, { provider: string; model?: string }> }
    for (const [role, assignment] of Object.entries(frozen.agents)) {
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
  const started = Date.now()
  return new Promise<AiStepResult>((resolve) => {
    let result: RuntimeResult | undefined
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
      const failed = code !== 0 || result?.status !== 'succeeded' || invalidProtocol || timedOut || Boolean(observerError)
      const errorText = observerError ?? (timedOut ? 'Programmatic workflow timed out; inspect its checkpoint before recovery'
        : invalidProtocol ? 'Core returned an invalid runtime event stream'
        : result?.error ?? (result?.status === 'paused' ? (typeof result.pendingQuestion?.question === 'string' && result.pendingQuestion.question.trim()
          ? `Workflow awaits an answer in Agent Runtime settings: ${result.pendingQuestion.question.trim().slice(0, 500)}`
          : 'Workflow awaits approval in Agent Runtime settings')
        : failed ? stderr || 'Core exited without a successful programmatic workflow result' : undefined))
      resolve({
        text: summary || (failed ? errorText ?? '' : 'Programmatic implementation verified and archived.'),
        provider: 'agent-runtime', model: 'per-role', failed, errorText,
        cost, tokensIn, tokensOut, tokens: tokensIn === undefined || tokensOut === undefined ? undefined : tokensIn + tokensOut,
        estimated: cost === undefined, durationMs: Date.now() - started,
      })
    })
  })
}
