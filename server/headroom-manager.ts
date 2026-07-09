import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ChildProcess } from 'child_process'
import type { DbInstance } from './db'
import { getDesktopSetting, setDesktopSetting } from './desktop-db'
import type { WsMessage } from './types'
import { setHeadroomRoutingState, type HeadroomProvider } from './headroom-routing'
import { treeKillSafe } from './util/win-spawn'

export type HeadroomPhase =
  | 'idle'
  | 'installing'
  | 'installed'
  | 'starting-proxy'
  | 'active'
  | 'failed'

export type HeadroomErrorCode =
  | 'uv_missing_or_corrupt'
  | 'network_unavailable'
  | 'package_resolution_failed'
  | 'install_permission_failed'
  | 'headroom_not_found_after_install'
  | 'learning_setup_failed'
  | 'metrics_unavailable'
  | 'proxy_port_busy'
  | 'proxy_unhealthy'
  | 'provider_route_failed'
  | 'provider_config_conflict'
  | 'activation_partially_applied'
  | 'not_installed'
  | 'uninstall_failed'
  | 'unknown'

export interface HeadroomIssue {
  code: HeadroomErrorCode
  title: string
  guidance: string
  detail?: string
  command?: string
}

export type HeadroomInstallSource = 'managed' | 'system'

export interface HeadroomProviderMetric {
  provider: HeadroomProvider
  label: string
  active: boolean
  available: boolean
  detectedRoute: boolean
  requests: number
  inputTokens: number
  inputTokensSaved: number
  outputTokens: number
  outputTokensSaved: number
  outputSavingsPercent: number
  outputSavingsMethod: 'estimated' | 'measured' | 'none'
  outputSavingsAllocated: boolean
}

export interface HeadroomMetricsState {
  updatedAt: string | null
  proxyStatsAvailable: boolean
  durableSavingsAvailable: boolean
  outputSavingsAvailable: boolean
  outputSavingsMethod: 'estimated' | 'measured' | null
  outputConfidence: {
    lowPercent: number
    highPercent: number
  } | null
  providers: Record<HeadroomProvider, HeadroomProviderMetric>
  lastIssue: HeadroomIssue | null
}

export interface HeadroomLearningState {
  enabled: boolean
  baselineReady: boolean
  baselineSamples: number
  updatedAt: string | null
  lastIssue: HeadroomIssue | null
}

export interface HeadroomState {
  installed: boolean
  installSource: HeadroomInstallSource | null
  version: string | null
  executablePath: string | null
  uvPath: string | null
  port: number
  phase: HeadroomPhase
  activeProviders: Record<HeadroomProvider, boolean>
  availableProviders: Record<HeadroomProvider, boolean>
  detectedRoutes: Record<HeadroomProvider, boolean>
  proxyRunning: boolean
  proxyPid: number | null
  learning: HeadroomLearningState
  metrics: HeadroomMetricsState
  lastIssue: HeadroomIssue | null
  updatedAt: string | null
}

export interface HeadroomActionResult {
  ok: boolean
  state: HeadroomState
  issue?: HeadroomIssue
  logs?: string[]
}

type Broadcast = (msg: WsMessage) => void

interface HeadroomProcessControl {
  spawnProxy?: typeof spawn
  killTree?: typeof treeKillSafe
}

const STATE_KEY = 'plugins.headroom.state'
const DEFAULT_PORT = 8787
export const HEADROOM_MANAGED_PYTHON_VERSION = '3.12'

interface PersistedHeadroomState {
  installed?: boolean
  version?: string | null
  executablePath?: string | null
  installSource?: HeadroomInstallSource | null
  ignoreSystemInstall?: boolean
  port?: number
  activeProviders?: Partial<Record<HeadroomProvider, boolean>>
  detectedRoutes?: Partial<Record<HeadroomProvider, boolean>>
  learningEnabled?: boolean
  learningUpdatedAt?: string | null
  learningIssue?: HeadroomIssue | null
  lastIssue?: HeadroomIssue | null
  updatedAt?: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function specrailsHome(): string {
  return process.env.SPECRAILS_REGISTRY_HOME || os.homedir()
}

function toolRoot(): string {
  return path.join(specrailsHome(), '.specrails', 'tools')
}

function uvToolDir(): string {
  return path.join(toolRoot(), 'uv', 'tools')
}

function uvCacheDir(): string {
  return path.join(toolRoot(), 'uv', 'cache')
}

function uvPythonInstallDir(): string {
  return path.join(toolRoot(), 'uv', 'python')
}

function uvPythonCacheDir(): string {
  return path.join(toolRoot(), 'uv', 'python-cache')
}

function uvPythonBinDir(): string {
  return path.join(toolRoot(), 'uv', 'python-bin')
}

function uvBinDir(): string {
  return path.join(toolRoot(), 'bin')
}

function headroomExeName(): string {
  return process.platform === 'win32' ? 'headroom.exe' : 'headroom'
}

function fileExists(p: string | null | undefined): p is string {
  if (!p) return false
  try { return fs.existsSync(p) } catch { return false }
}

function bundledUvCandidates(): string[] {
  const base = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
  if (!base) return []
  if (process.platform === 'win32') {
    return [
      path.join(base, 'uv', 'uv.exe'),
      path.join(base, 'uv', 'bin', 'uv.exe'),
    ]
  }
  return [
    path.join(base, 'uv', 'bin', 'uv'),
    path.join(base, 'uv', 'uv'),
  ]
}

function which(command: string): string | null {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    encoding: 'utf8',
    timeout: 5000,
    env: process.env,
  })
  if (probe.status !== 0) return null
  return `${probe.stdout ?? ''}`.trim().split(/\r?\n/)[0] || null
}

function parseHeadroomVersion(raw: string): string | null {
  const match = raw.match(/(\d+\.\d+\.\d+)/)
  return match?.[1] ?? null
}

function issue(code: HeadroomErrorCode, detail?: string, command?: string): HeadroomIssue {
  const copy: Record<HeadroomErrorCode, { title: string; guidance: string }> = {
    uv_missing_or_corrupt: {
      title: 'Bundled uv is not available',
      guidance: 'Specrails could not start its bundled uv runtime. Reinstall Specrails or use Repair once the runtime is available.',
    },
    network_unavailable: {
      title: 'Headroom could not be downloaded',
      guidance: 'Check your network connection and retry. Specrails will keep the install isolated in its own tool directory.',
    },
    package_resolution_failed: {
      title: 'Headroom dependencies could not be resolved',
      guidance: 'Retry the install. If it keeps failing, open diagnostics and share the uv output.',
    },
    install_permission_failed: {
      title: 'Specrails cannot write its tool directory',
      guidance: 'Check permissions under ~/.specrails/tools, then retry the install.',
    },
    headroom_not_found_after_install: {
      title: 'Install finished but Headroom was not found',
      guidance: 'Run Repair install. Specrails will reinstall Headroom and verify the executable.',
    },
    learning_setup_failed: {
      title: 'Headroom learning could not be enabled',
      guidance: 'Headroom is installed, but output-savings calibration did not finish. Retry learning from diagnostics or keep using proxy routing while metrics warm up.',
    },
    metrics_unavailable: {
      title: 'Headroom metrics are not available yet',
      guidance: 'Start routing traffic through Headroom. Specrails will refresh token-savings metrics as soon as the proxy reports samples.',
    },
    proxy_port_busy: {
      title: 'Headroom proxy port is already in use',
      guidance: 'Choose another port or stop the process using the current port, then retry activation.',
    },
    proxy_unhealthy: {
      title: 'Headroom proxy did not become healthy',
      guidance: 'Retry activation. If it repeats, open diagnostics to inspect the proxy output.',
    },
    provider_route_failed: {
      title: 'Provider route verification failed',
      guidance: 'Specrails could not verify the provider route. The provider remains inactive; retry after checking diagnostics.',
    },
    provider_config_conflict: {
      title: 'Existing provider configuration conflicts with Headroom',
      guidance: 'Review diagnostics before enabling system-wide activation. Specrails-managed routing remains reversible.',
    },
    activation_partially_applied: {
      title: 'Activation was only partially applied',
      guidance: 'Specrails attempted rollback. Review diagnostics and retry the affected provider.',
    },
    not_installed: {
      title: 'Headroom is not installed',
      guidance: 'Install Headroom first, then activate Codex or Claude.',
    },
    uninstall_failed: {
      title: 'Headroom could not be uninstalled',
      guidance: 'Specrails disabled Headroom routing but could not remove the managed tool. Open diagnostics, then retry uninstall.',
    },
    unknown: {
      title: 'Headroom operation failed',
      guidance: 'Retry the operation. If it repeats, open diagnostics and share the details.',
    },
  }
  return { code, title: copy[code].title, guidance: copy[code].guidance, detail, command }
}

function classifyInstallFailure(output: string, command: string): HeadroomIssue {
  const lower = output.toLowerCase()
  if (lower.includes('permission') || lower.includes('eacces') || lower.includes('access is denied')) {
    return issue('install_permission_failed', output, command)
  }
  if (
    lower.includes('network') ||
    lower.includes('timed out') ||
    lower.includes('temporary failure') ||
    lower.includes('could not resolve') ||
    lower.includes('connection refused') ||
    lower.includes('connection reset')
  ) {
    return issue('network_unavailable', output, command)
  }
  if (lower.includes('no solution') || lower.includes('failed to resolve') || lower.includes('resolution')) {
    return issue('package_resolution_failed', output, command)
  }
  return issue('unknown', output, command)
}

export function getHeadroomManagedInstallPlan(): {
  pythonVersion: string
  pythonInstallArgs: string[]
  toolInstallArgs: string[]
  env: Record<string, string>
} {
  return {
    pythonVersion: HEADROOM_MANAGED_PYTHON_VERSION,
    pythonInstallArgs: [
      'python',
      'install',
      HEADROOM_MANAGED_PYTHON_VERSION,
      '--managed-python',
    ],
    toolInstallArgs: [
      'tool',
      'install',
      '--python',
      HEADROOM_MANAGED_PYTHON_VERSION,
      '--managed-python',
      '--force',
      'headroom-ai[all]',
    ],
    env: {
      UV_TOOL_DIR: uvToolDir(),
      UV_TOOL_BIN_DIR: uvBinDir(),
      UV_CACHE_DIR: uvCacheDir(),
      UV_PYTHON: HEADROOM_MANAGED_PYTHON_VERSION,
      UV_MANAGED_PYTHON: 'true',
      UV_PYTHON_DOWNLOADS: 'automatic',
      UV_PYTHON_INSTALL_DIR: uvPythonInstallDir(),
      UV_PYTHON_CACHE_DIR: uvPythonCacheDir(),
      UV_PYTHON_BIN_DIR: uvPythonBinDir(),
      UV_PYTHON_NO_REGISTRY: 'true',
      UV_PYTHON_INSTALL_REGISTRY: 'false',
      UV_NO_PROGRESS: '1',
    },
  }
}

function classifyProxyFailure(output: string, command: string): HeadroomIssue {
  const lower = output.toLowerCase()
  if (
    lower.includes('address already in use') ||
    lower.includes('eaddrinuse') ||
    lower.includes('only one usage of each socket address')
  ) {
    return issue('proxy_port_busy', output, command)
  }
  return issue('proxy_unhealthy', output, command)
}

function providerLabel(provider: HeadroomProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude'
}

function providerRecord(value?: Partial<Record<HeadroomProvider, boolean>>): Record<HeadroomProvider, boolean> {
  return {
    codex: !!value?.codex,
    claude: !!value?.claude,
  }
}

function emptyProviderMetric(provider: HeadroomProvider): HeadroomProviderMetric {
  return {
    provider,
    label: providerLabel(provider),
    active: false,
    available: false,
    detectedRoute: false,
    requests: 0,
    inputTokens: 0,
    inputTokensSaved: 0,
    outputTokens: 0,
    outputTokensSaved: 0,
    outputSavingsPercent: 0,
    outputSavingsMethod: 'none',
    outputSavingsAllocated: false,
  }
}

function emptyMetricsState(issueValue: HeadroomIssue | null = null): HeadroomMetricsState {
  return {
    updatedAt: null,
    proxyStatsAvailable: false,
    durableSavingsAvailable: false,
    outputSavingsAvailable: false,
    outputSavingsMethod: null,
    outputConfidence: null,
    providers: {
      codex: emptyProviderMetric('codex'),
      claude: emptyProviderMetric('claude'),
    },
    lastIssue: issueValue,
  }
}

function normalizeProviderKey(value: unknown): HeadroomProvider | null {
  const raw = String(value ?? '').trim().toLowerCase().replace(/_/g, '-')
  if (!raw) return null
  if (raw === 'codex' || raw === 'codex-cli' || raw === 'openai') return 'codex'
  if (raw === 'claude' || raw === 'claude-code' || raw === 'claude-cli' || raw === 'anthropic') return 'claude'
  return null
}

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function maxNumericField(row: Record<string, unknown>, fields: string[]): number {
  return Math.max(0, ...fields.map((field) => Math.trunc(num(row[field]))))
}

const INPUT_TOKEN_FIELDS = [
  'input_tokens',
  'input_tokens_total',
  'input_tokens_processed',
  'total_input_tokens',
  'prompt_tokens',
  'prompt_tokens_total',
  'prompt_tokens_processed',
  'tokens_in',
  'tokens_input',
  'original_tokens',
  'tokens_original',
  'tokens_before',
]

const OUTPUT_TOKEN_FIELDS = [
  'output_tokens',
  'output_tokens_total',
  'output_tokens_processed',
  'total_output_tokens',
  'completion_tokens',
  'completion_tokens_total',
  'tokens_out',
  'tokens_output',
]

export class HeadroomManager {
  private proxy: ChildProcess | null = null
  private proxyTail = ''
  private routeDetectionCache: {
    executablePath: string
    expiresAt: number
    routes: Record<HeadroomProvider, boolean>
    raw: unknown
  } | null = null
  private metricsCache: HeadroomMetricsState = emptyMetricsState()
  private metricsRefresh: Promise<void> | null = null

  constructor(
    private readonly db: DbInstance,
    private readonly broadcast: Broadcast,
    private readonly availableProvidersSupplier: () => HeadroomProvider[] = () => ['claude', 'codex'],
    private readonly processControl: HeadroomProcessControl = {},
  ) {
    this.syncRouting()
  }

  getState(): HeadroomState {
    const persisted = this.readPersisted()
    const uvPath = this.resolveUvPath()
    const install = this.resolveHeadroomInstall(persisted.executablePath ?? null, !!persisted.ignoreSystemInstall)
    const exe = install?.path ?? null
    const version = exe ? this.readHeadroomVersion(exe) : null
    const installed = !!exe && !!version
    const availableProviders = this.availableProviderRecord()
    const detectedRoutes = installed && exe ? this.detectProviderRoutes(exe) : providerRecord(persisted.detectedRoutes)
    const activeProviders = {
      codex: persisted.activeProviders?.codex ?? (availableProviders.codex && detectedRoutes.codex),
      claude: persisted.activeProviders?.claude ?? (availableProviders.claude && detectedRoutes.claude),
    }

    if (installed) {
      const shouldPersistInstall =
        persisted.installed !== true ||
        persisted.executablePath !== exe ||
        persisted.version !== version ||
        persisted.installSource !== install?.source ||
        persisted.ignoreSystemInstall === true
      const shouldPersistRoutes =
        persisted.detectedRoutes?.codex !== detectedRoutes.codex ||
        persisted.detectedRoutes?.claude !== detectedRoutes.claude ||
        persisted.activeProviders?.codex !== activeProviders.codex ||
        persisted.activeProviders?.claude !== activeProviders.claude
      if (shouldPersistInstall || shouldPersistRoutes) {
        this.updatePersisted({
          installed: true,
          version,
          executablePath: exe,
          installSource: install?.source ?? null,
          ignoreSystemInstall: false,
          detectedRoutes,
          activeProviders,
        })
      }
    }

    this.refreshMetricsInBackground()

    const learning: HeadroomLearningState = {
      enabled: persisted.learningEnabled ?? installed,
      ...this.readLearningBaseline(),
      updatedAt: persisted.learningUpdatedAt ?? null,
      lastIssue: persisted.learningIssue ?? null,
    }
    const metrics = this.decorateMetrics(this.metricsCache, activeProviders, availableProviders, detectedRoutes)

    return {
      installed,
      installSource: installed ? install?.source ?? null : null,
      version: version ?? persisted.version ?? null,
      executablePath: exe,
      uvPath,
      port: this.validPort(persisted.port),
      phase: installed ? (activeProviders.codex || activeProviders.claude ? 'active' : 'installed') : 'idle',
      activeProviders,
      availableProviders,
      detectedRoutes,
      proxyRunning: (activeProviders.codex || activeProviders.claude) && this.isProxyAvailable(),
      proxyPid: this.proxy?.pid ?? null,
      learning,
      metrics,
      lastIssue: persisted.lastIssue ?? null,
      updatedAt: persisted.updatedAt ?? null,
    }
  }

  async getFreshState(): Promise<HeadroomState> {
    await this.refreshMetrics()
    return this.getState()
  }

  async install(): Promise<HeadroomActionResult> {
    const uv = this.resolveUvPath()
    if (!uv) {
      const failure = issue('uv_missing_or_corrupt')
      this.updatePersisted({ lastIssue: failure })
      return { ok: false, state: this.getState(), issue: failure }
    }

    fs.mkdirSync(uvToolDir(), { recursive: true })
    fs.mkdirSync(uvCacheDir(), { recursive: true })
    fs.mkdirSync(uvBinDir(), { recursive: true })
    fs.mkdirSync(uvPythonInstallDir(), { recursive: true })
    fs.mkdirSync(uvPythonCacheDir(), { recursive: true })
    fs.mkdirSync(uvPythonBinDir(), { recursive: true })

    const plan = getHeadroomManagedInstallPlan()
    const pythonCommand = `${uv} ${plan.pythonInstallArgs.join(' ')}`
    const installCommand = `${uv} ${plan.toolInstallArgs.join(' ')}`
    const logs: string[] = [
      `Ensuring Headroom Python runtime (CPython ${plan.pythonVersion})`,
      `Running ${pythonCommand}`,
    ]
    this.emit('installing', logs[0])
    this.emit('installing', logs[1])

    const pythonResult = await this.runCommand(uv, plan.pythonInstallArgs, plan.env, logs)
    if (pythonResult.code !== 0) {
      const failure = classifyInstallFailure(logs.join('\n'), pythonCommand)
      this.updatePersisted({ lastIssue: failure })
      this.emit('failed', failure.title)
      return { ok: false, state: this.getState(), issue: failure, logs }
    }

    logs.push(`Installing Headroom with managed CPython ${plan.pythonVersion}`)
    logs.push(`Running ${installCommand}`)
    this.emit('installing', logs[logs.length - 2])
    this.emit('installing', logs[logs.length - 1])

    const result = await this.runCommand(uv, plan.toolInstallArgs, plan.env, logs)

    if (result.code !== 0) {
      const failure = classifyInstallFailure(logs.join('\n'), installCommand)
      this.updatePersisted({ lastIssue: failure })
      this.emit('failed', failure.title)
      return { ok: false, state: this.getState(), issue: failure, logs }
    }

    const exe = this.resolveHeadroomInstall(null, false)?.path ?? null
    const version = exe ? this.readHeadroomVersion(exe) : null
    if (!exe || !version) {
      const failure = issue('headroom_not_found_after_install', logs.join('\n'), installCommand)
      this.updatePersisted({ lastIssue: failure })
      this.emit('failed', failure.title)
      return { ok: false, state: this.getState(), issue: failure, logs }
    }

    this.updatePersisted({
      installed: true,
      version,
      executablePath: exe,
      installSource: 'managed',
      ignoreSystemInstall: false,
      lastIssue: null,
    })

    await this.enableOutputLearning(exe, logs)
    this.emit('installed', `Headroom ${version} installed`)
    await this.refreshMetrics()
    return { ok: true, state: this.getState(), logs }
  }

  async activate(provider: HeadroomProvider): Promise<HeadroomActionResult> {
    const state = this.getState()
    if (!state.installed || !state.executablePath) {
      const failure = issue('not_installed')
      this.updatePersisted({ lastIssue: failure })
      return { ok: false, state: this.getState(), issue: failure }
    }

    const proxy = await this.ensureProxy()
    if (!proxy.ok) return proxy

    const current = this.readPersisted()
    const activeProviders = { ...current.activeProviders, [provider]: true }
    this.updatePersisted({ activeProviders, lastIssue: null })
    this.syncRouting()

    if (!this.verifyProviderRoute(provider)) {
      const rolledBack = { ...activeProviders, [provider]: false }
      this.updatePersisted({ activeProviders: rolledBack, lastIssue: issue('provider_route_failed') })
      this.syncRouting()
      return { ok: false, state: this.getState(), issue: issue('provider_route_failed') }
    }

    this.emit('active', `${provider} routed through Headroom`)
    return { ok: true, state: this.getState() }
  }

  async deactivate(provider: HeadroomProvider): Promise<HeadroomActionResult> {
    const current = this.readPersisted()
    const activeProviders = { ...current.activeProviders, [provider]: false }
    this.updatePersisted({ activeProviders, lastIssue: null })
    this.syncRouting()
    if (!activeProviders.codex && !activeProviders.claude) this.stopProxy()
    this.emit('installed', `${provider} Headroom route disabled`)
    return { ok: true, state: this.getState() }
  }

  async uninstall(): Promise<HeadroomActionResult> {
    const before = this.getState()
    this.updatePersisted({
      activeProviders: { codex: false, claude: false },
      lastIssue: null,
    })
    this.stopProxy()
    this.syncRouting()

    if (!before.installed && !before.executablePath) {
      this.updatePersisted({
        installed: false,
        version: null,
        executablePath: null,
        installSource: null,
        activeProviders: { codex: false, claude: false },
        detectedRoutes: { codex: false, claude: false },
        lastIssue: null,
      })
      return { ok: true, state: this.getState() }
    }

    if (before.installSource === 'system') {
      this.updatePersisted({
        installed: false,
        version: null,
        executablePath: null,
        installSource: null,
        ignoreSystemInstall: true,
        activeProviders: { codex: false, claude: false },
        detectedRoutes: { codex: false, claude: false },
        lastIssue: null,
      })
      this.emit('idle', 'External Headroom detached from Specrails')
      return { ok: true, state: this.getState(), logs: ['External Headroom install left untouched; Specrails routing disabled.'] }
    }

    const uv = this.resolveUvPath()
    if (!uv) {
      const failure = issue('uv_missing_or_corrupt')
      this.updatePersisted({ lastIssue: failure })
      return { ok: false, state: this.getState(), issue: failure }
    }

    const args = ['tool', 'uninstall', 'headroom-ai']
    const command = `${uv} ${args.join(' ')}`
    const logs: string[] = [`Running ${command}`]
    this.emit('installing', logs[0])

    const result = await this.runCommand(uv, args, {
      UV_TOOL_DIR: uvToolDir(),
      UV_TOOL_BIN_DIR: uvBinDir(),
      UV_CACHE_DIR: uvCacheDir(),
      UV_NO_PROGRESS: '1',
    }, logs)

    const stillInstalled = fileExists(path.join(uvBinDir(), headroomExeName()))
    if (result.code !== 0 || stillInstalled) {
      const failure = issue('uninstall_failed', logs.join('\n'), command)
      this.updatePersisted({ lastIssue: failure })
      this.emit('failed', failure.title)
      return { ok: false, state: this.getState(), issue: failure, logs }
    }

    this.updatePersisted({
      installed: false,
      version: null,
      executablePath: null,
      installSource: null,
      activeProviders: { codex: false, claude: false },
      detectedRoutes: { codex: false, claude: false },
      lastIssue: null,
    })
    this.emit('idle', 'Headroom uninstalled')
    return { ok: true, state: this.getState(), logs }
  }

  async setPort(port: number): Promise<HeadroomActionResult> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      const failure = issue('proxy_port_busy', 'Port must be an integer between 1 and 65535.')
      return { ok: false, state: this.getState(), issue: failure }
    }
    const previous = this.readPersisted()
    const previousPort = this.validPort(previous.port)
    const active = this.getState().activeProviders
    const child = this.proxy
    this.proxy = null
    if (child) await this.terminateProxyChild(child)

    if (!active.codex && !active.claude) {
      this.updatePersisted({ port, lastIssue: null })
      return { ok: true, state: this.getState() }
    }

    // Keep routing disabled while the replacement is only a candidate. No job
    // may send provider credentials to it until our owned child is healthy.
    this.updatePersisted({
      port,
      activeProviders: { codex: false, claude: false },
      lastIssue: null,
    })
    const candidate = await this.ensureProxy()
    if (candidate.ok) {
      this.updatePersisted({ activeProviders: active, lastIssue: null })
      return { ok: true, state: this.getState() }
    }

    // Roll back the entire transition, including the old owned proxy. If even
    // that cannot be restored, remain fail-closed instead of persisting an
    // active route with no healthy service behind it.
    this.updatePersisted({
      port: previousPort,
      activeProviders: { codex: false, claude: false },
      lastIssue: candidate.issue ?? issue('proxy_unhealthy'),
    })
    const restored = await this.ensureProxy()
    if (restored.ok) {
      this.updatePersisted({
        activeProviders: active,
        lastIssue: candidate.issue ?? issue('proxy_unhealthy'),
      })
    } else {
      this.updatePersisted({
        activeProviders: { codex: false, claude: false },
        lastIssue: restored.issue ?? candidate.issue ?? issue('proxy_unhealthy'),
      })
    }
    return {
      ok: false,
      state: this.getState(),
      issue: candidate.issue ?? issue('proxy_unhealthy'),
    }
  }

  diagnostics(): Record<string, unknown> {
    const state = this.getState()
    return {
      state,
      toolDir: uvToolDir(),
      binDir: uvBinDir(),
      cacheDir: uvCacheDir(),
      pythonInstallDir: uvPythonInstallDir(),
      pythonBinDir: uvPythonBinDir(),
      pythonCacheDir: uvPythonCacheDir(),
      proxyTail: this.proxyTail.slice(-4000),
      installSource: state.installSource,
      detectedRoutes: state.detectedRoutes,
      availableProviders: state.availableProviders,
      learning: state.learning,
      metrics: state.metrics,
      routing: {
        codex: state.activeProviders.codex ? `OPENAI_BASE_URL=http://127.0.0.1:${state.port}/v1` : null,
        claude: state.activeProviders.claude ? `ANTHROPIC_BASE_URL=http://127.0.0.1:${state.port}` : null,
      },
    }
  }

  async startActiveProxyOnBoot(): Promise<void> {
    const active = this.getState().activeProviders
    this.syncRouting()
    if (active.codex || active.claude) {
      const result = await this.ensureProxy()
      if (!result.ok) {
        // Never keep provider credentials/prompts routed to a process we did not
        // spawn and therefore cannot authenticate. The user can retry activation
        // after resolving the port conflict.
        this.updatePersisted({
          activeProviders: { codex: false, claude: false },
          lastIssue: result.issue ?? issue('proxy_unhealthy'),
        })
        console.warn('[headroom] boot proxy start failed:', result.issue)
      }
    }
  }

  private async ensureProxy(): Promise<HeadroomActionResult> {
    const state = this.getState()
    if (!state.installed || !state.executablePath) {
      const failure = issue('not_installed')
      return { ok: false, state, issue: failure }
    }
    if (this.isProxyRunning()) return { ok: true, state }
    // A healthy endpoint is still not proof that the process belongs to this
    // Specrails instance. Adopting it would route provider auth and prompts to an
    // unauthenticated port occupant. Treat every pre-existing listener as a hard
    // conflict and only trust the child created below.
    if (await this.probeProxyHealthy(state.port)) {
      const failure = issue('proxy_port_busy')
      this.updatePersisted({ lastIssue: failure })
      this.emit('failed', failure.title)
      return { ok: false, state: this.getState(), issue: failure }
    }

    const args = ['proxy', '--host', '127.0.0.1', '--port', String(state.port)]
    const command = `${state.executablePath} ${args.join(' ')}`
    this.emit('starting-proxy', `Starting proxy on ${state.port}`)
    this.proxyTail = ''
    const child = (this.processControl.spawnProxy ?? spawn)(state.executablePath, args, {
      env: {
        ...process.env,
        HEADROOM_PORT: String(state.port),
        HEADROOM_OUTPUT_SHAPER: '1',
        HEADROOM_LEARN: state.learning.enabled ? '1' : '0',
        HEADROOM_SAVINGS_PROFILE: process.env.HEADROOM_SAVINGS_PROFILE ?? 'agent-90',
        HEADROOM_MODE: process.env.HEADROOM_MODE ?? 'token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proxy = child
    child.stdout?.on('data', (chunk) => { this.proxyTail += chunk.toString(); this.trimProxyTail() })
    child.stderr?.on('data', (chunk) => { this.proxyTail += chunk.toString(); this.trimProxyTail() })
    // `spawn()` reports ENOENT/EACCES asynchronously. Without this listener the
    // EventEmitter contract turns a recoverable activation failure into an
    // uncaught exception that terminates the desktop sidecar.
    child.on('error', (err) => {
      this.proxyTail += `${err.message}\n`
      this.trimProxyTail()
      if (this.proxy === child) this.proxy = null
    })
    child.on('close', () => {
      if (this.proxy === child) this.proxy = null
    })

    const healthy = await this.waitForProxyHealthy(state.port, 6000)
    if (!healthy) {
      const failure = classifyProxyFailure(this.proxyTail, command)
      this.stopProxy()
      this.updatePersisted({ lastIssue: failure })
      this.emit('failed', failure.title)
      return { ok: false, state: this.getState(), issue: failure }
    }
    this.updatePersisted({ lastIssue: null })
    await this.refreshMetrics()
    return { ok: true, state: this.getState() }
  }

  private resolveUvPath(): string | null {
    for (const p of bundledUvCandidates()) {
      if (fileExists(p)) return p
    }
    return which('uv')
  }

  private resolveHeadroomInstall(
    persisted: string | null,
    ignoreSystemInstall: boolean,
  ): { path: string; source: HeadroomInstallSource } | null {
    const managed = path.join(uvBinDir(), headroomExeName())
    if (fileExists(managed)) return { path: managed, source: 'managed' }
    if (fileExists(persisted)) {
      return { path: persisted, source: persisted === managed ? 'managed' : 'system' }
    }
    if (ignoreSystemInstall) return null
    const system = which('headroom')
    return system ? { path: system, source: 'system' } : null
  }

  private availableProviderRecord(): Record<HeadroomProvider, boolean> {
    const available = new Set(this.availableProvidersSupplier())
    return {
      codex: available.has('codex'),
      claude: available.has('claude'),
    }
  }

  private detectProviderRoutes(exe: string): Record<HeadroomProvider, boolean> {
    const now = Date.now()
    if (this.routeDetectionCache?.executablePath === exe && this.routeDetectionCache.expiresAt > now) {
      return this.routeDetectionCache.routes
    }

    const routes = { codex: false, claude: false }
    try {
      const state = this.readPersisted()
      const probe = spawnSync(exe, ['doctor', '--json', '--port', String(this.validPort(state.port))], {
        encoding: 'utf8',
        timeout: 5000,
        env: process.env,
      })
      const raw = `${probe.stdout ?? ''}`.trim()
      const parsed = raw ? JSON.parse(raw) as { checks?: Array<{ name?: string; status?: string; summary?: string }> } : {}
      for (const check of parsed.checks ?? []) {
        const provider = normalizeProviderKey(check.name)
        if (!provider) continue
        const routed = check.status === 'pass' || String(check.summary ?? '').toLowerCase().includes('routed')
        if (routed) routes[provider] = true
      }
      this.routeDetectionCache = { executablePath: exe, expiresAt: now + 10_000, routes, raw: parsed }
    } catch {
      this.routeDetectionCache = { executablePath: exe, expiresAt: now + 10_000, routes, raw: null }
    }
    return routes
  }

  private readHeadroomVersion(exe: string): string | null {
    const probe = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 5000 })
    if (probe.status !== 0) return null
    return parseHeadroomVersion(`${probe.stdout ?? ''}${probe.stderr ?? ''}`)
  }

  private readLearningBaseline(): Pick<HeadroomLearningState, 'baselineReady' | 'baselineSamples'> {
    const candidates = [
      process.env.HEADROOM_WORKSPACE_DIR
        ? path.join(process.env.HEADROOM_WORKSPACE_DIR, 'output_savings.json')
        : null,
      path.join(os.homedir(), '.headroom', 'output_savings.json'),
    ].filter((value): value is string => !!value)
    for (const candidate of candidates) {
      try {
        if (!fs.existsSync(candidate)) continue
        const raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { baseline?: { glob?: { n?: number } } }
        const samples = Math.max(0, Math.trunc(num(raw.baseline?.glob?.n)))
        return { baselineReady: samples > 0, baselineSamples: samples }
      } catch {
        // Keep looking; a corrupt baseline should not break plugin state.
      }
    }
    return { baselineReady: false, baselineSamples: 0 }
  }

  private async enableOutputLearning(exe: string, logs: string[]): Promise<void> {
    const args = ['learn', '--verbosity', '--apply']
    const command = `${exe} ${args.join(' ')}`
    logs.push(`Running ${command}`)
    this.emit('installing', 'Calibrating output-savings baseline')
    const result = await this.runCommand(exe, args, {
      HEADROOM_OUTPUT_SHAPER: '1',
      HEADROOM_SAVINGS_PROFILE: process.env.HEADROOM_SAVINGS_PROFILE ?? 'agent-90',
    }, logs)
    if (result.code === 0) {
      this.updatePersisted({
        learningEnabled: true,
        learningUpdatedAt: nowIso(),
        learningIssue: null,
      })
      return
    }

    const failure = issue('learning_setup_failed', logs.slice(-30).join('\n'), command)
    this.updatePersisted({
      learningEnabled: true,
      learningUpdatedAt: nowIso(),
      learningIssue: failure,
    })
  }

  private refreshMetricsInBackground(): void {
    const state = this.getMetricsPrereqState()
    if (!state.installed || !state.executablePath) return
    if (this.metricsRefresh) return
    const last = this.metricsCache.updatedAt ? Date.parse(this.metricsCache.updatedAt) : 0
    if (Date.now() - last < 5000) return
    this.metricsRefresh = this.refreshMetrics().finally(() => {
      this.metricsRefresh = null
    })
  }

  private getMetricsPrereqState(): Pick<HeadroomState, 'installed' | 'executablePath' | 'port' | 'activeProviders' | 'availableProviders' | 'detectedRoutes'> {
    const persisted = this.readPersisted()
    const install = this.resolveHeadroomInstall(persisted.executablePath ?? null, !!persisted.ignoreSystemInstall)
    const availableProviders = this.availableProviderRecord()
    const detectedRoutes = install?.path ? this.detectProviderRoutes(install.path) : providerRecord(persisted.detectedRoutes)
    return {
      installed: !!install?.path,
      executablePath: install?.path ?? null,
      port: this.validPort(persisted.port),
      availableProviders,
      detectedRoutes,
      activeProviders: {
        codex: persisted.activeProviders?.codex ?? (availableProviders.codex && detectedRoutes.codex),
        claude: persisted.activeProviders?.claude ?? (availableProviders.claude && detectedRoutes.claude),
      },
    }
  }

  private async refreshMetrics(): Promise<void> {
    const state = this.getMetricsPrereqState()
    if (!state.installed || !state.executablePath) {
      this.metricsCache = emptyMetricsState()
      return
    }

    const metrics = emptyMetricsState()
    const byProvider = {
      codex: { ...emptyProviderMetric('codex') },
      claude: { ...emptyProviderMetric('claude') },
    }

    try {
      const savings = await this.readDurableSavings(state.executablePath)
      if (savings) {
        metrics.durableSavingsAvailable = true
        for (const row of savings.by_client ?? []) {
          const provider = normalizeProviderKey(row.client)
          if (!provider) continue
          byProvider[provider].requests = Math.max(byProvider[provider].requests, Math.trunc(num(row.calls)))
          byProvider[provider].inputTokensSaved = Math.max(
            byProvider[provider].inputTokensSaved,
            Math.trunc(num(row.tokens_saved)),
          )
          byProvider[provider].inputTokens = Math.max(
            byProvider[provider].inputTokens,
            maxNumericField(row, INPUT_TOKEN_FIELDS),
          )
        }
      }
    } catch (err) {
      metrics.lastIssue = issue('metrics_unavailable', err instanceof Error ? err.message : String(err))
    }

    const stats = state.activeProviders.codex || state.activeProviders.claude
      ? await this.readProxyStats(state.port).catch((err) => {
          metrics.lastIssue = issue('metrics_unavailable', err instanceof Error ? err.message : String(err))
          return null
        })
      : null

    if (stats) {
      metrics.proxyStatsAvailable = true
      const agents = Array.isArray(stats.agent_usage?.agents) ? stats.agent_usage.agents : []
      for (const agent of agents) {
        const provider = normalizeProviderKey(agent.agent ?? agent.label ?? agent.source)
        if (!provider) continue
        byProvider[provider].requests = Math.max(byProvider[provider].requests, Math.trunc(num(agent.requests)))
        byProvider[provider].inputTokensSaved = Math.max(
          byProvider[provider].inputTokensSaved,
          Math.trunc(num(agent.tokens_saved)),
        )
        byProvider[provider].inputTokens = Math.max(
          byProvider[provider].inputTokens,
          maxNumericField(agent, INPUT_TOKEN_FIELDS),
        )
        byProvider[provider].outputTokens = Math.max(
          byProvider[provider].outputTokens,
          maxNumericField(agent, OUTPUT_TOKEN_FIELDS),
        )
      }

      const outputReduction = stats.tokens?.output_reduction
      if (outputReduction?.available) {
        const method = outputReduction.method === 'measured' ? 'measured' : 'estimated'
        const totalOutputSaved = Math.round(num(outputReduction.tokens_saved))
        const totalWeight = (['codex', 'claude'] as HeadroomProvider[]).reduce((sum, provider) => {
          const row = byProvider[provider]
          return sum + (row.outputTokens || row.requests || (state.activeProviders[provider] ? 1 : 0))
        }, 0)
        metrics.outputSavingsAvailable = true
        metrics.outputSavingsMethod = method
        metrics.outputConfidence = {
          lowPercent: num(outputReduction.ci_low_percent),
          highPercent: num(outputReduction.ci_high_percent),
        }
        for (const provider of (['codex', 'claude'] as HeadroomProvider[])) {
          const row = byProvider[provider]
          const weight = row.outputTokens || row.requests || (state.activeProviders[provider] ? 1 : 0)
          const outputSaved = totalWeight > 0 ? Math.round(totalOutputSaved * (weight / totalWeight)) : 0
          row.outputTokensSaved = outputSaved
          row.outputSavingsPercent = num(outputReduction.reduction_percent)
          row.outputSavingsMethod = method
          row.outputSavingsAllocated = totalWeight > weight
        }
      }
    }

    metrics.updatedAt = nowIso()
    metrics.providers = this.decorateMetricProviders(byProvider, state.activeProviders, state.availableProviders, state.detectedRoutes)
    this.metricsCache = metrics
  }

  private async readDurableSavings(exe: string): Promise<{ by_client?: Array<Record<string, unknown>> } | null> {
    const result = await this.runCommandCapture(exe, ['savings', '--json'], {}, 5000)
    if (result.code !== 0 || !result.output.trim()) return null
    return JSON.parse(result.output) as { by_client?: Array<Record<string, unknown>> }
  }

  private async readProxyStats(port: number): Promise<Record<string, any> | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2500)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/stats?cached=1`, { signal: controller.signal })
      if (!res.ok) return null
      return await res.json() as Record<string, any>
    } finally {
      clearTimeout(timer)
    }
  }

  private decorateMetrics(
    metrics: HeadroomMetricsState,
    activeProviders: Record<HeadroomProvider, boolean>,
    availableProviders: Record<HeadroomProvider, boolean>,
    detectedRoutes: Record<HeadroomProvider, boolean>,
  ): HeadroomMetricsState {
    return {
      ...metrics,
      providers: this.decorateMetricProviders(metrics.providers, activeProviders, availableProviders, detectedRoutes),
    }
  }

  private decorateMetricProviders(
    providers: Record<HeadroomProvider, HeadroomProviderMetric>,
    activeProviders: Record<HeadroomProvider, boolean>,
    availableProviders: Record<HeadroomProvider, boolean>,
    detectedRoutes: Record<HeadroomProvider, boolean>,
  ): Record<HeadroomProvider, HeadroomProviderMetric> {
    return {
      codex: {
        ...emptyProviderMetric('codex'),
        ...providers.codex,
        active: activeProviders.codex,
        available: availableProviders.codex,
        detectedRoute: detectedRoutes.codex,
      },
      claude: {
        ...emptyProviderMetric('claude'),
        ...providers.claude,
        active: activeProviders.claude,
        available: availableProviders.claude,
        detectedRoute: detectedRoutes.claude,
      },
    }
  }

  private async runCommand(
    command: string,
    args: string[],
    extraEnv: Record<string, string>,
    logs: string[],
  ): Promise<{ code: number | null }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (!line) continue
          logs.push(line)
          this.emit('installing', line)
        }
      })
      child.stderr?.on('data', (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (!line) continue
          logs.push(line)
          this.emit('installing', line)
        }
      })
      child.on('error', (err) => {
        logs.push(err.message)
        resolve({ code: null })
      })
      child.on('close', (code) => resolve({ code }))
    })
  }

  private async runCommandCapture(
    command: string,
    args: string[],
    extraEnv: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      let output = ''
      let settled = false
      const child = spawn(command, args, {
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const settle = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, output })
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        settle(null)
      }, timeoutMs)
      child.stdout?.on('data', (chunk) => { output += chunk.toString() })
      child.stderr?.on('data', (chunk) => { output += chunk.toString() })
      child.on('error', (err) => {
        output += err.message
        settle(null)
      })
      child.on('close', (code) => settle(code))
    })
  }

  private async waitForProxyHealthy(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/livez`)
        if (res.ok) return true
      } catch {
        // retry until timeout
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  private async probeProxyHealthy(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/livez`)
      return res.ok
    } catch {
      return false
    }
  }

  private verifyProviderRoute(provider: HeadroomProvider): boolean {
    const state = this.getState()
    return provider === 'codex'
      ? !!state.activeProviders.codex && state.port > 0
      : !!state.activeProviders.claude && state.port > 0
  }

  private isProxyRunning(): boolean {
    return !!this.proxy && this.proxy.exitCode == null && this.proxy.signalCode == null
  }

  private isProxyAvailable(): boolean {
    return this.isProxyRunning()
  }

  private stopProxy(): void {
    const child = this.proxy
    this.proxy = null
    if (child) void this.terminateProxyChild(child)
  }

  /** Stop the owned proxy before the app tears down its DB and HTTP server. */
  async shutdown(): Promise<void> {
    const child = this.proxy
    this.proxy = null
    // Runtime-only fail closed; persisted activation remains so a clean restart
    // can start a fresh owned proxy.
    setHeadroomRoutingState({ port: this.getState().port, activeProviders: {} })
    if (child) await this.terminateProxyChild(child)
  }

  private terminateProxyChild(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode != null || child.signalCode != null) return Promise.resolve()
    const pid = child.pid
    const killTree = this.processControl.killTree ?? treeKillSafe
    return new Promise((resolve) => {
      let closed = false
      let killTimer: NodeJS.Timeout | null = null
      let deadlineTimer: NodeJS.Timeout | null = null
      const finish = () => {
        if (closed) return
        closed = true
        if (killTimer) clearTimeout(killTimer)
        if (deadlineTimer) clearTimeout(deadlineTimer)
        child.removeListener('close', finish)
        resolve()
      }
      child.once('close', finish)
      try { killTree(pid, 'SIGTERM', () => { /* close is authoritative */ }) } catch { /* gone */ }
      killTimer = setTimeout(() => {
        if (closed) return
        try { killTree(pid, 'SIGKILL', () => { /* close is authoritative */ }) } catch { /* gone */ }
      }, 2_000)
      killTimer.unref?.()
      // A D-state process may never emit close. Do not wedge app shutdown after
      // escalation; the OS will reclaim it when possible.
      deadlineTimer = setTimeout(finish, 2_500)
      deadlineTimer.unref?.()
    })
  }

  private trimProxyTail(): void {
    if (this.proxyTail.length > 32_000) this.proxyTail = this.proxyTail.slice(-32_000)
  }

  private validPort(value: unknown): number {
    return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : DEFAULT_PORT
  }

  private readPersisted(): PersistedHeadroomState {
    const raw = getDesktopSetting(this.db, STATE_KEY)
    if (!raw) return { port: DEFAULT_PORT, activeProviders: {} }
    try {
      const parsed = JSON.parse(raw) as PersistedHeadroomState
      return { port: DEFAULT_PORT, activeProviders: {}, ...parsed }
    } catch {
      return { port: DEFAULT_PORT, activeProviders: {} }
    }
  }

  private updatePersisted(patch: Partial<PersistedHeadroomState>): void {
    const next = {
      ...this.readPersisted(),
      ...patch,
      updatedAt: nowIso(),
    }
    setDesktopSetting(this.db, STATE_KEY, JSON.stringify(next))
    this.syncRouting()
  }

  private syncRouting(): void {
    const persisted = this.readPersisted()
    setHeadroomRoutingState({
      port: this.validPort(persisted.port),
      activeProviders: {
        codex: !!persisted.activeProviders?.codex,
        claude: !!persisted.activeProviders?.claude,
      },
    })
  }

  private emit(phase: HeadroomPhase, line: string): void {
    this.broadcast(({
      type: 'plugin.headroom_progress',
      name: 'headroom-ai',
      status: phase,
      line,
      timestamp: nowIso(),
    } as unknown) as WsMessage)
  }
}
