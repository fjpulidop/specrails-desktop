import { spawn, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import fs from 'fs'
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import type { Duplex } from 'stream'
import type { ChildProcess } from 'child_process'
import type { DbInstance } from './db'
import { safeEqual } from './auth'
import { getDesktopSetting, setDesktopSetting } from './desktop-db'
import type { WsMessage } from './types'
import {
  setHeadroomRoutingState,
  terminateHeadroomRoutedChildren,
  type HeadroomProvider,
} from './headroom-routing'
import { treeKillSafe, windowsSpawnEnv } from './util/win-spawn'

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
  ownsProxyPort?: (pid: number, port: number) => boolean | Promise<boolean>
  /** Origin of the stable desktop HTTP server that owns the client endpoint. */
  relayOrigin?: string
}

interface LifecycleCommandControl {
  cancel: () => void
}

interface WindowsProcessRow {
  ProcessId?: unknown
  ParentProcessId?: unknown
}

interface WindowsOwnershipPayload {
  listeningPids?: unknown
  processes?: unknown
}

export interface WindowsOwnershipSnapshot {
  listeningPids: Set<number>
  parentByPid: Map<number, number>
}

const STATE_KEY = 'plugins.headroom.state'
const DEFAULT_PORT = 8787
const PROXY_HEALTH_REQUEST_TIMEOUT_MS = 750
/**
 * How long a freshly spawned proxy gets to answer `/livez` before activation
 * is declared failed. The proxy is a Python tool run through uv: a COLD start
 * (first run after install, or a wiped bytecode cache) compiles ~3 000
 * modules and only prints its banner ~4 s in, answering `/livez` after ~7.5 s
 * on an M-series Mac — the previous 6 s budget killed it every time and left
 * `proxyTail` empty, so the diagnostics said nothing. Warm starts take ~3.7 s.
 * A child that EXITS is failed immediately regardless of this budget.
 */
export const PROXY_START_TIMEOUT_MS = 30_000
const PROXY_START_TIMEOUT_ENV = 'SPECRAILS_HEADROOM_START_TIMEOUT_MS'
const RELAY_CONNECT_TIMEOUT_MS = 3_000

/** Effective proxy startup budget: the env override when it is a positive
 *  integer number of milliseconds, else the default. */
export function getProxyStartTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PROXY_START_TIMEOUT_ENV]
  if (raw === undefined || raw.trim() === '') return PROXY_START_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : PROXY_START_TIMEOUT_MS
}
export const HEADROOM_RELAY_PATH = '/_specrails/headroom'
export const HEADROOM_MANAGED_PYTHON_VERSION = '3.12'
export const HEADROOM_ACTIVATION_SCHEMA_VERSION = 1
export const HEADROOM_ACTIVATION_SOURCE = 'explicit-user-action'

interface PersistedHeadroomActivation {
  version?: number
  source?: string
  activeProviders?: Partial<Record<HeadroomProvider, boolean>>
}

interface PersistedHeadroomState {
  installed?: boolean
  version?: string | null
  executablePath?: string | null
  installSource?: HeadroomInstallSource | null
  ignoreSystemInstall?: boolean
  port?: number
  /**
   * Legacy mirror retained for downgrade visibility. It is never authoritative:
   * only a known activation envelope written by an explicit user action may
   * enable provider routing.
   */
  activeProviders?: Partial<Record<HeadroomProvider, boolean>>
  activation?: PersistedHeadroomActivation
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

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/** Parse the language-independent JSON emitted by the Windows ownership probe. */
export function parseWindowsOwnershipSnapshot(raw: string): WindowsOwnershipSnapshot | null {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '').trim()) as WindowsOwnershipPayload
    const listeningValues = Array.isArray(parsed.listeningPids)
      ? parsed.listeningPids
      : parsed.listeningPids == null
        ? []
        : [parsed.listeningPids]
    const processValues = Array.isArray(parsed.processes)
      ? parsed.processes
      : parsed.processes && typeof parsed.processes === 'object'
        ? [parsed.processes]
        : []

    const listeningPids = new Set<number>()
    for (const value of listeningValues) {
      const pid = positiveInteger(value)
      if (pid) listeningPids.add(pid)
    }

    const parentByPid = new Map<number, number>()
    for (const value of processValues) {
      if (!value || typeof value !== 'object') continue
      const row = value as WindowsProcessRow
      const pid = positiveInteger(row.ProcessId)
      const parentPid = positiveInteger(row.ParentProcessId)
      if (pid && parentPid) parentByPid.set(pid, parentPid)
    }
    return { listeningPids, parentByPid }
  } catch {
    return null
  }
}

/** True only when a listening PID is the spawned process or one of its descendants. */
export function windowsSnapshotHasOwnedListener(
  snapshot: WindowsOwnershipSnapshot,
  rootPid: number,
): boolean {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return false
  for (const listenerPid of snapshot.listeningPids) {
    let current = listenerPid
    const visited = new Set<number>()
    while (current > 0 && !visited.has(current)) {
      if (current === rootPid) return true
      visited.add(current)
      current = snapshot.parentByPid.get(current) ?? 0
    }
  }
  return false
}

function descendantPids(rootPid: number, parentByPid: Map<number, number>): Set<number> {
  const descendants = new Set<number>([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, parentPid] of parentByPid) {
      if (descendants.has(pid) || !descendants.has(parentPid)) continue
      descendants.add(pid)
      changed = true
    }
  }
  return descendants
}

async function captureCommandOutput(
  command: string,
  args: string[],
  options: {
    timeoutMs: number
    env?: NodeJS.ProcessEnv
    windowsHide?: boolean
    maxBuffer?: number
  },
): Promise<string | null> {
  return await new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: options.windowsHide,
      })
    } catch {
      resolve(null)
      return
    }

    let output = ''
    let size = 0
    let settled = false
    const maxBuffer = options.maxBuffer ?? 2 * 1024 * 1024
    const settle = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      settle(null)
    }, options.timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
      size += Buffer.byteLength(value)
      if (size > maxBuffer) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        settle(null)
        return
      }
      output += value
    })
    child.once('error', () => settle(null))
    child.once('close', (code) => settle(code === 0 ? output : null))
  })
}

async function readLinuxDescendantPids(rootPid: number): Promise<Set<number>> {
  const descendants = new Set<number>([rootPid])
  const pending = [rootPid]
  while (pending.length > 0) {
    const current = pending.shift()!
    try {
      const taskIds = await fs.promises.readdir(`/proc/${current}/task`)
      for (const taskId of taskIds) {
        let raw: string
        try { raw = await fs.promises.readFile(`/proc/${current}/task/${taskId}/children`, 'utf8') } catch { continue }
        for (const value of raw.trim().split(/\s+/)) {
          const childPid = positiveInteger(value)
          if (!childPid || descendants.has(childPid)) continue
          descendants.add(childPid)
          pending.push(childPid)
        }
      }
    } catch {
      // A process can exit while its descendants are enumerated. Omitting that
      // branch is fail-closed for listener ownership.
    }
  }
  return descendants
}

async function readPosixParentMap(): Promise<Map<number, number>> {
  const args = ['-axo', 'pid=,ppid=']
  const raw = await captureCommandOutput('/bin/ps', args, { timeoutMs: 2_000 })
    ?? await captureCommandOutput('/usr/bin/ps', args, { timeoutMs: 2_000 })
  const parentByPid = new Map<number, number>()
  if (raw === null) return parentByPid
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/)
    const pid = positiveInteger(match?.[1])
    const parentPid = positiveInteger(match?.[2])
    if (pid && parentPid) parentByPid.set(pid, parentPid)
  }
  return parentByPid
}

async function windowsProcessOwnsListeningPort(pid: number, port: number): Promise<boolean> {
  const env = windowsSpawnEnv()
  const systemRoot = (env.SystemRoot || env.windir || 'C:\\Windows').replace(/[\\/]$/, '')
  const powershell = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  // uv-managed console entry points are native trampoline processes on
  // Windows. The Python process that owns the socket is their child, so an
  // exact-PID netstat comparison rejects every legitimate managed install.
  // Query both the listener owner and the process tree in one fail-closed
  // snapshot, then accept only a transitive descendant of our spawned PID.
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$listeningPids = @(Get-NetTCPConnection -State Listen -LocalPort ${port} | ForEach-Object { [int]$_.OwningProcess })`,
    '$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)',
    '[pscustomobject]@{ listeningPids = $listeningPids; processes = $processes } | ConvertTo-Json -Compress -Depth 4',
  ].join('; ')
  const raw = await captureCommandOutput(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], {
    // Keep this below the relay's connection deadline. A slow/ambiguous OS
    // probe rejects the connection without ever releasing its queued headers.
    timeoutMs: 2_500,
    windowsHide: true,
    env,
    maxBuffer: 2 * 1024 * 1024,
  })
  if (raw === null) return false
  const snapshot = parseWindowsOwnershipSnapshot(raw)
  return !!snapshot && windowsSnapshotHasOwnedListener(snapshot, pid)
}

/**
 * A successful HTTP probe is not proof that the process we spawned owns the
 * endpoint: another local process can bind between the preflight probe and the
 * child calling bind(2). Verify the listening socket belongs to the owned PID
 * before provider credentials are routed to it.
 */
async function processOwnsListeningPort(pid: number, port: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false

  if (process.platform === 'linux') {
    try {
      const listeningInodes = new Set<string>()
      const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(async (table) => {
        try { return await fs.promises.readFile(table, 'utf8') } catch { return '' }
      }))
      for (const raw of tables) {
        for (const line of raw.split(/\r?\n/).slice(1)) {
          const columns = line.trim().split(/\s+/)
          if (columns.length < 10 || columns[3] !== '0A') continue
          const portHex = columns[1]?.split(':').pop()
          if (!portHex || Number.parseInt(portHex, 16) !== port) continue
          if (columns[9]) listeningInodes.add(columns[9])
        }
      }
      if (listeningInodes.size === 0) return false
      const ownedPids = await readLinuxDescendantPids(pid)
      for (const ownedPid of ownedPids) {
        let fds: string[]
        try { fds = await fs.promises.readdir(`/proc/${ownedPid}/fd`) } catch { continue }
        for (const fd of fds) {
          let target: string
          try { target = await fs.promises.readlink(`/proc/${ownedPid}/fd/${fd}`) } catch { continue }
          const match = target.match(/^socket:\[(\d+)\]$/)
          if (match?.[1] && listeningInodes.has(match[1])) return true
        }
      }
      return false
    } catch {
      return false
    }
  }

  if (process.platform === 'win32') {
    return await windowsProcessOwnsListeningPort(pid, port)
  }

  const args = [
    '-nP',
    `-iTCP:${port}`,
    '-sTCP:LISTEN',
    '-Fp',
  ]
  const output = await captureCommandOutput('/usr/sbin/lsof', args, { timeoutMs: 2_000 })
    ?? await captureCommandOutput('lsof', args, { timeoutMs: 2_000 })
  if (output === null) return false
  const ownedPids = descendantPids(pid, await readPosixParentMap())
  return output.split(/\r?\n/).some((line) => {
    const listenerPid = positiveInteger(line.match(/^p(\d+)$/)?.[1])
    return !!listenerPid && ownedPids.has(listenerPid)
  })
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

/** Parse only the documented pass/fail signal; human prose is never authority. */
export function parseHeadroomDoctorRoutes(raw: string): Record<HeadroomProvider, boolean> {
  const routes = { codex: false, claude: false }
  try {
    const parsed = JSON.parse(raw) as { checks?: unknown }
    if (!Array.isArray(parsed.checks)) return routes
    for (const value of parsed.checks) {
      if (!value || typeof value !== 'object') continue
      const check = value as { name?: unknown; status?: unknown; summary?: unknown }
      const provider = normalizeProviderKey(check.name)
      if (!provider || check.status !== 'pass') continue
      const summary = typeof check.summary === 'string' ? check.summary.trim().toLowerCase() : ''
      // Some Headroom versions have emitted a successful diagnostic check with
      // text such as "not routed". A contradictory result must fail closed.
      if (/\bnot(?:\s+\w+){0,3}\s+routed\b|\bunrouted\b|\brouting\s+(?:is\s+)?(?:disabled|inactive|off)\b/.test(summary)) continue
      routes[provider] = true
    }
  } catch {
    // Malformed/unknown doctor schemas are not evidence of a configured route.
  }
  return routes
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
  private proxyTrustedPort: number | null = null
  private proxyStart: {
    generation: number
    port: number
    promise: Promise<HeadroomActionResult>
  } | null = null
  private proxyStop: Promise<void> | null = null
  private proxyGeneration = 0
  private shuttingDown = false
  private shutdownPromise: Promise<void> | null = null
  private shutdownState: HeadroomState | null = null
  private lifecycleTail: Promise<void> = Promise.resolve()
  private lifecycleCommands = new Map<ChildProcess, LifecycleCommandControl>()
  private proxyTail = ''
  private readonly relayToken = randomBytes(32).toString('base64url')
  private readonly relayAgent: http.Agent
  private readonly relayUpgradeTeardowns = new Set<() => void>()
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
    this.relayAgent = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 })
    // Agent#createConnection supports an asynchronous callback. Returning no
    // socket prevents ClientRequest from writing queued headers/body on TCP
    // connect; the socket is handed over only after the post-connect PID check.
    this.relayAgent.createConnection = ((options, callback) => {
      const expectedPort = Number(options.port)
      void this.connectVerifiedBackend(expectedPort).then(
        ({ socket }) => callback?.(null, socket),
        (err) => callback?.(err as Error, undefined as unknown as net.Socket),
      )
      return undefined
    }) as typeof this.relayAgent.createConnection
    this.syncRouting()
  }

  getState(): HeadroomState {
    return this.buildState(true)
  }

  private buildState(refreshMetrics: boolean): HeadroomState {
    const persisted = this.readPersisted()
    const uvPath = this.resolveUvPath()
    const install = this.resolveHeadroomInstall(persisted.executablePath ?? null, !!persisted.ignoreSystemInstall)
    const exe = install?.path ?? null
    const version = exe ? this.readHeadroomVersion(exe) : null
    const installed = !!exe && !!version
    const availableProviders = this.availableProviderRecord()
    const detectedRoutes = installed && exe ? this.detectProviderRoutes(exe) : providerRecord(persisted.detectedRoutes)
    const activeProviders = this.explicitActiveProviders(persisted)

    if (installed) {
      const shouldPersistInstall =
        persisted.installed !== true ||
        persisted.executablePath !== exe ||
        persisted.version !== version ||
        persisted.installSource !== install?.source ||
        persisted.ignoreSystemInstall === true
      const shouldPersistRoutes =
        persisted.detectedRoutes?.codex !== detectedRoutes.codex ||
        persisted.detectedRoutes?.claude !== detectedRoutes.claude
      if (shouldPersistInstall || shouldPersistRoutes) {
        this.updatePersisted({
          installed: true,
          version,
          executablePath: exe,
          installSource: install?.source ?? null,
          ignoreSystemInstall: false,
          detectedRoutes,
        })
      }
    }

    if (refreshMetrics) this.refreshMetricsInBackground()

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
    if (this.shuttingDown) return this.shutdownState ?? this.buildState(false)
    await this.refreshMetrics()
    return this.getState()
  }

  /**
   * Stream a provider request through the stable desktop listener. A TCP
   * connection to the backend is established first, then ownership is verified,
   * and only then are headers/body (including provider credentials) written.
   * A process that rebinds the backend port can therefore receive a TCP handshake
   * but never a secret-bearing byte.
   */
  async handleRelayRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const upstreamPath = this.relayUpstreamPath(req.url)
    if (!upstreamPath) {
      this.writeRelayError(res, 404, 'Not Found')
      return
    }

    const backendPort = this.trustedBackendPort()
    if (!backendPort) {
      this.writeRelayError(res, 503, 'Headroom proxy is unavailable')
      return
    }

    const headers = this.filterRelayHttpHeaders(req.headers)
    headers.host = `127.0.0.1:${backendPort}`
    let upstreamResponse: IncomingMessage | null = null
    let relaySettled = false
    const upstream = http.request({
      host: '127.0.0.1',
      port: backendPort,
      method: req.method,
      path: upstreamPath,
      headers,
      agent: this.relayAgent,
    }, (response) => {
      upstreamResponse = response
      if (res.destroyed) {
        abortRelay(false)
        return
      }
      response.once('aborted', () => abortRelay(true))
      response.once('error', () => abortRelay(true))
      response.once('close', () => {
        // IncomingMessage#close is also emitted after a fully-consumed response.
        // Only an incomplete HTTP message is a broken backend stream.
        if (!response.complete) abortRelay(true)
      })
      response.once('end', settleCleanRelay)
      res.writeHead(
        response.statusCode ?? 502,
        this.filterRelayHttpHeaders(response.headers),
      )
      response.pipe(res)
    })

    const abortRelay = (notifyClient: boolean) => {
      if (relaySettled) return
      relaySettled = true
      req.unpipe(upstream)
      upstreamResponse?.unpipe(res)
      upstreamResponse?.destroy()
      upstream.destroy()
      if (!notifyClient || res.destroyed || res.writableFinished) return
      if (!res.headersSent) this.writeRelayError(res, 503, 'Headroom proxy request failed')
      else res.destroy()
    }

    const settleCleanRelay = () => {
      if (
        req.complete &&
        upstreamResponse?.complete &&
        res.writableFinished
      ) relaySettled = true
    }

    upstream.once('error', () => abortRelay(true))
    upstream.once('close', () => {
      if (!upstreamResponse) abortRelay(true)
    })
    req.once('aborted', () => abortRelay(false))
    req.once('error', () => abortRelay(false))
    req.once('close', () => {
      // A normal IncomingMessage closes after the complete request body. Do not
      // confuse that with a client disconnect while a valid response streams.
      if (!req.complete) abortRelay(false)
    })
    req.once('end', settleCleanRelay)
    res.once('error', () => abortRelay(false))
    res.once('close', () => {
      if (!res.writableFinished) abortRelay(false)
    })
    res.once('finish', settleCleanRelay)
    req.pipe(upstream)
  }

  /** WebSocket equivalent of handleRelayRequest (used by Codex streaming). */
  async handleRelayUpgrade(
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const upstreamPath = this.relayUpstreamPath(req.url)
    if (!upstreamPath) {
      this.rejectRelayUpgrade(clientSocket, 404, 'Not Found')
      return
    }

    let backend: { socket: net.Socket; port: number }
    try {
      backend = await this.connectVerifiedBackend()
    } catch {
      this.rejectRelayUpgrade(clientSocket, 503, 'Headroom proxy unavailable')
      return
    }
    if (clientSocket.destroyed) {
      backend.socket.destroy()
      return
    }

    const raw: string[] = [`${req.method ?? 'GET'} ${upstreamPath} HTTP/${req.httpVersion}`]
    const connectionTokens = this.connectionHeaderTokens(req.headers)
    let wroteHost = false
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]
      const value = req.rawHeaders[i + 1]
      if (!name || value === undefined) continue
      const lower = name.toLowerCase()
      if (lower === 'host') {
        if (!wroteHost) raw.push(`Host: 127.0.0.1:${backend.port}`)
        wroteHost = true
        continue
      }
      if (
        lower === 'connection' ||
        lower === 'proxy-connection' ||
        lower === 'keep-alive' ||
        lower === 'transfer-encoding' ||
        lower === 'te' ||
        lower === 'trailer' ||
        lower === 'proxy-authenticate' ||
        lower === 'proxy-authorization' ||
        (connectionTokens.has(lower) && lower !== 'upgrade')
      ) continue
      raw.push(`${name}: ${value}`)
    }
    if (!wroteHost) raw.push(`Host: 127.0.0.1:${backend.port}`)
    raw.push('Connection: Upgrade')
    raw.push('', '')

    const backendSocket = backend.socket
    let clientEnded = false
    let backendEnded = false
    let clientClosed = false
    let backendClosed = false
    let tearingDown = false

    const cleanup = () => {
      this.relayUpgradeTeardowns.delete(destroyBoth)
      clientSocket.unpipe(backendSocket)
      backendSocket.unpipe(clientSocket)
      clientSocket.removeListener('error', destroyBoth)
      backendSocket.removeListener('error', destroyBoth)
      clientSocket.removeListener('end', onClientEnd)
      backendSocket.removeListener('end', onBackendEnd)
      clientSocket.removeListener('close', onClientClose)
      backendSocket.removeListener('close', onBackendClose)
    }
    const destroyBoth = () => {
      if (tearingDown) return
      tearingDown = true
      cleanup()
      if (!clientSocket.destroyed) clientSocket.destroy()
      if (!backendSocket.destroyed) backendSocket.destroy()
    }
    const finishIfClosed = () => {
      if (clientClosed && backendClosed) cleanup()
    }
    const onClientEnd = () => {
      clientEnded = true
      if (!backendSocket.destroyed && !backendSocket.writableEnded) backendSocket.end()
    }
    const onBackendEnd = () => {
      backendEnded = true
      if (!clientSocket.destroyed && !clientSocket.writableEnded) clientSocket.end()
    }
    const onClientClose = () => {
      clientClosed = true
      if (!clientEnded) destroyBoth()
      else finishIfClosed()
    }
    const onBackendClose = () => {
      backendClosed = true
      if (!backendEnded) destroyBoth()
      else finishIfClosed()
    }

    this.relayUpgradeTeardowns.add(destroyBoth)
    clientSocket.once('error', destroyBoth)
    backendSocket.once('error', destroyBoth)
    clientSocket.once('end', onClientEnd)
    backendSocket.once('end', onBackendEnd)
    clientSocket.once('close', onClientClose)
    backendSocket.once('close', onBackendClose)
    if (clientSocket.destroyed || backendSocket.destroyed) {
      destroyBoth()
      return
    }
    try {
      backendSocket.write(raw.join('\r\n'))
      if (head.length > 0) backendSocket.write(head)
      // Preserve a clean half-close so a peer that has finished sending can
      // still receive the other direction's final frames. Premature close or
      // error takes the idempotent destroyBoth path above.
      clientSocket.pipe(backendSocket, { end: false })
      backendSocket.pipe(clientSocket, { end: false })
    } catch {
      destroyBoth()
    }
  }

  private relayUpstreamPath(rawUrl: string | undefined): string | null {
    try {
      const parsed = new URL(rawUrl || '/', 'http://127.0.0.1')
      const fullPrefix = `${HEADROOM_RELAY_PATH}/`
      let relative = parsed.pathname.startsWith(fullPrefix)
        ? parsed.pathname.slice(HEADROOM_RELAY_PATH.length)
        : parsed.pathname
      const separator = relative.indexOf('/', 1)
      const providedToken = separator === -1 ? relative.slice(1) : relative.slice(1, separator)
      if (!providedToken || !safeEqual(providedToken, this.relayToken)) return null
      relative = separator === -1 ? '/' : relative.slice(separator)
      return `${relative}${parsed.search}`
    } catch {
      return null
    }
  }

  private trustedBackendPort(expectedPort?: number): number | null {
    const child = this.proxy
    const port = this.proxyTrustedPort
    if (
      !child || !port || !child.pid ||
      (expectedPort !== undefined && port !== expectedPort) ||
      child.exitCode != null || child.signalCode != null
    ) return null
    return port
  }

  private connectVerifiedBackend(expectedPort?: number): Promise<{ socket: net.Socket; port: number }> {
    const child = this.proxy
    const port = this.trustedBackendPort(expectedPort)
    if (!child || !port || !child.pid) return Promise.reject(new Error('Headroom proxy is not trusted'))

    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      let settled = false
      const timer = setTimeout(() => fail(new Error('Headroom relay connect timed out')), RELAY_CONNECT_TIMEOUT_MS)
      timer.unref?.()
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        reject(err)
      }
      socket.once('error', fail)
      socket.once('connect', () => {
        void (async () => {
          const ownsProxyPort = this.processControl.ownsProxyPort ?? processOwnsListeningPort
          let listenerOwned = false
          try { listenerOwned = await ownsProxyPort(child.pid!, port) } catch { /* fail closed */ }
          if (settled) return
          const owned =
            this.proxy === child &&
            this.proxyTrustedPort === port &&
            child.exitCode == null &&
            child.signalCode == null &&
            !!child.pid &&
            listenerOwned &&
            this.proxy === child &&
            this.proxyTrustedPort === port &&
            child.exitCode == null &&
            child.signalCode == null
          if (!owned) {
            fail(new Error('Headroom backend ownership changed'))
            return
          }
          settled = true
          clearTimeout(timer)
          socket.removeListener('error', fail)
          resolve({ socket, port })
        })().catch((err) => fail(err instanceof Error ? err : new Error(String(err))))
      })
    })
  }

  private writeRelayError(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent || res.destroyed) return
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ error: message }))
  }

  private connectionHeaderTokens(headers: IncomingHttpHeaders): Set<string> {
    const raw = headers.connection
    const values = Array.isArray(raw) ? raw : raw ? [raw] : []
    return new Set(values.flatMap((value) => value.split(',')).map((value) => value.trim().toLowerCase()).filter(Boolean))
  }

  private filterRelayHttpHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
    const connectionTokens = this.connectionHeaderTokens(headers)
    const filtered: OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase()
      if (
        value === undefined ||
        lower === 'connection' ||
        lower === 'proxy-connection' ||
        lower === 'keep-alive' ||
        lower === 'transfer-encoding' ||
        lower === 'upgrade' ||
        lower === 'te' ||
        lower === 'trailer' ||
        lower === 'proxy-authenticate' ||
        lower === 'proxy-authorization' ||
        connectionTokens.has(lower)
      ) continue
      filtered[name] = value
    }
    return filtered
  }

  private rejectRelayUpgrade(socket: Duplex, status: number, message: string): void {
    if (socket.destroyed) return
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    )
  }

  private destroyRelayTransports(): void {
    this.relayAgent.destroy()
    for (const teardown of [...this.relayUpgradeTeardowns]) teardown()
  }

  async install(): Promise<HeadroomActionResult> {
    return this.serializeLifecycle(() => this.installLocked())
  }

  private async installLocked(): Promise<HeadroomActionResult> {
    if (this.shuttingDown) return this.cancelledProxyStart()
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
    if (this.shuttingDown) return this.cancelledProxyStart()
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
    if (this.shuttingDown) return this.cancelledProxyStart()

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
    if (this.shuttingDown) return this.cancelledProxyStart()
    this.emit('installed', `Headroom ${version} installed`)
    await this.refreshMetrics()
    if (this.shuttingDown) return this.cancelledProxyStart()
    return { ok: true, state: this.getState(), logs }
  }

  async activate(provider: HeadroomProvider): Promise<HeadroomActionResult> {
    return this.serializeLifecycle(() => this.activateLocked(provider))
  }

  private async activateLocked(provider: HeadroomProvider): Promise<HeadroomActionResult> {
    if (this.shuttingDown) return this.cancelledProxyStart()
    const state = this.getState()
    if (!state.installed || !state.executablePath) {
      const failure = issue('not_installed')
      this.updatePersisted({ lastIssue: failure })
      return { ok: false, state: this.getState(), issue: failure }
    }

    const proxy = await this.ensureProxy()
    if (!proxy.ok) return proxy
    // The start promise can settle just before shutdown/deactivation invalidates
    // its generation. Re-check the owned runtime synchronously before persisting
    // a provider route so a resolved promise cannot resurrect activation.
    if (this.shuttingDown || !this.isProxyAvailable()) return this.cancelledProxyStart()

    const current = this.readPersisted()
    const activeProviders = { ...this.explicitActiveProviders(current), [provider]: true }
    this.updatePersisted({ ...this.activationPatch(activeProviders), lastIssue: null })
    this.syncRouting()

    if (!this.verifyProviderRoute(provider)) {
      const rolledBack = { ...activeProviders, [provider]: false }
      this.updatePersisted({ ...this.activationPatch(rolledBack), lastIssue: issue('provider_route_failed') })
      this.syncRouting()
      return { ok: false, state: this.getState(), issue: issue('provider_route_failed') }
    }

    this.emit('active', `${provider} routed through Headroom`)
    return { ok: true, state: this.getState() }
  }

  async deactivate(provider: HeadroomProvider): Promise<HeadroomActionResult> {
    return this.serializeLifecycle(() => this.deactivateLocked(provider))
  }

  private async deactivateLocked(provider: HeadroomProvider): Promise<HeadroomActionResult> {
    if (this.shuttingDown) return this.cancelledProxyStart()
    const current = this.readPersisted()
    const activeProviders = { ...this.explicitActiveProviders(current), [provider]: false }
    this.updatePersisted({ ...this.activationPatch(activeProviders), lastIssue: null })
    this.syncRouting()
    if (!activeProviders.codex && !activeProviders.claude) await this.stopProxy()
    this.emit('installed', `${provider} Headroom route disabled`)
    return { ok: true, state: this.getState() }
  }

  async uninstall(): Promise<HeadroomActionResult> {
    return this.serializeLifecycle(() => this.uninstallLocked())
  }

  private async uninstallLocked(): Promise<HeadroomActionResult> {
    if (this.shuttingDown) return this.cancelledProxyStart()
    const before = this.getState()
    this.updatePersisted({
      ...this.activationPatch({ codex: false, claude: false }),
      lastIssue: null,
    })
    await this.stopProxy()
    if (this.shuttingDown) return this.cancelledProxyStart()
    this.syncRouting()

    if (!before.installed && !before.executablePath) {
      this.updatePersisted({
        installed: false,
        version: null,
        executablePath: null,
        installSource: null,
        ...this.activationPatch({ codex: false, claude: false }),
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
        ...this.activationPatch({ codex: false, claude: false }),
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
    if (this.shuttingDown) return this.cancelledProxyStart()

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
      ...this.activationPatch({ codex: false, claude: false }),
      detectedRoutes: { codex: false, claude: false },
      lastIssue: null,
    })
    this.emit('idle', 'Headroom uninstalled')
    return { ok: true, state: this.getState(), logs }
  }

  async setPort(port: number): Promise<HeadroomActionResult> {
    return this.serializeLifecycle(() => this.setPortLocked(port))
  }

  private async setPortLocked(port: number): Promise<HeadroomActionResult> {
    if (this.shuttingDown) return this.cancelledProxyStart()
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      const failure = issue('proxy_port_busy', 'Port must be an integer between 1 and 65535.')
      return { ok: false, state: this.getState(), issue: failure }
    }
    const previous = this.readPersisted()
    const previousPort = this.validPort(previous.port)
    const active = this.getState().activeProviders
    await this.stopProxy()
    if (this.shuttingDown) return this.cancelledProxyStart()

    if (!active.codex && !active.claude) {
      this.updatePersisted({ port, lastIssue: null })
      return { ok: true, state: this.getState() }
    }

    // Keep routing disabled while the replacement is only a candidate. No job
    // may send provider credentials to it until our owned child is healthy.
    this.updatePersisted({
      port,
      ...this.activationPatch({ codex: false, claude: false }),
      lastIssue: null,
    })
    const candidate = await this.ensureProxy()
    if (this.shuttingDown) return this.cancelledProxyStart()
    if (candidate.ok) {
      this.updatePersisted({ ...this.activationPatch(active), lastIssue: null })
      return { ok: true, state: this.getState() }
    }

    // Roll back the entire transition, including the old owned proxy. If even
    // that cannot be restored, remain fail-closed instead of persisting an
    // active route with no healthy service behind it.
    this.updatePersisted({
      port: previousPort,
      ...this.activationPatch({ codex: false, claude: false }),
      lastIssue: candidate.issue ?? issue('proxy_unhealthy'),
    })
    const restored = await this.ensureProxy()
    if (restored.ok) {
      this.updatePersisted({
        ...this.activationPatch(active),
        lastIssue: candidate.issue ?? issue('proxy_unhealthy'),
      })
    } else {
      this.updatePersisted({
        ...this.activationPatch({ codex: false, claude: false }),
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
        codex: state.activeProviders.codex
          ? `OPENAI_BASE_URL=${this.relayDiagnosticBaseUrl() ?? `http://127.0.0.1:${state.port}`}/v1`
          : null,
        claude: state.activeProviders.claude
          ? `ANTHROPIC_BASE_URL=${this.relayDiagnosticBaseUrl() ?? `http://127.0.0.1:${state.port}`}`
          : null,
      },
    }
  }

  async startActiveProxyOnBoot(): Promise<void> {
    return this.serializeLifecycle(() => this.startActiveProxyOnBootLocked())
  }

  private async startActiveProxyOnBootLocked(): Promise<void> {
    if (this.shuttingDown) return
    const active = this.getState().activeProviders
    this.syncRouting()
    if (active.codex || active.claude) {
      const result = await this.ensureProxy()
      if (this.shuttingDown) return
      if (!result.ok) {
        // Never keep provider credentials/prompts routed to a process we did not
        // spawn and therefore cannot authenticate. The user can retry activation
        // after resolving the port conflict.
        this.updatePersisted({
          ...this.activationPatch({ codex: false, claude: false }),
          lastIssue: result.issue ?? issue('proxy_unhealthy'),
        })
        console.warn('[headroom] boot proxy start failed:', result.issue)
      }
    }
  }

  private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.then(operation, operation)
    this.lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async ensureProxy(): Promise<HeadroomActionResult> {
    if (this.proxyStop) await this.proxyStop
    const state = this.getState()
    if (!state.installed || !state.executablePath) {
      const failure = issue('not_installed')
      return { ok: false, state, issue: failure }
    }
    if (this.shuttingDown) {
      const failure = issue('proxy_unhealthy', 'Headroom proxy startup was cancelled during shutdown.')
      return { ok: false, state, issue: failure }
    }
    if (this.proxyStart) {
      if (this.proxyStart.port === state.port) return this.proxyStart.promise
      await this.stopProxy()
      if (this.shuttingDown) return this.cancelledProxyStart()
    }
    if (this.isProxyAvailable(state.port)) return { ok: true, state }
    if (this.isProxyRunning()) await this.stopProxy()

    const generation = ++this.proxyGeneration
    const promise = this.startProxy(state, state.executablePath, generation)
    this.proxyStart = { generation, port: state.port, promise }
    const clear = () => {
      if (this.proxyStart?.promise === promise) this.proxyStart = null
    }
    void promise.then(clear, clear)
    return promise
  }

  private async startProxy(
    state: HeadroomState,
    executablePath: string,
    generation: number,
  ): Promise<HeadroomActionResult> {
    // A healthy endpoint is still not proof that the process belongs to this
    // Specrails instance. Adopting it would route provider auth and prompts to an
    // unauthenticated port occupant. Treat every pre-existing listener as a hard
    // conflict and only trust the child created below.
    if (await this.probeProxyHealthy(state.port)) {
      if (!this.isProxyGenerationCurrent(generation)) return this.cancelledProxyStart()
      const failure = issue('proxy_port_busy')
      this.updatePersisted({ lastIssue: failure })
      this.emit('failed', failure.title)
      return { ok: false, state: this.getState(), issue: failure }
    }
    if (!this.isProxyGenerationCurrent(generation)) return this.cancelledProxyStart()

    const args = ['proxy', '--host', '127.0.0.1', '--port', String(state.port)]
    const command = `${executablePath} ${args.join(' ')}`
    this.emit('starting-proxy', `Starting proxy on ${state.port}`)
    this.proxyTail = ''
    let child: ChildProcess
    try {
      child = (this.processControl.spawnProxy ?? spawn)(executablePath, args, {
        env: {
          ...process.env,
          HEADROOM_PORT: String(state.port),
          HEADROOM_OUTPUT_SHAPER: '1',
          HEADROOM_LEARN: state.learning.enabled ? '1' : '0',
          HEADROOM_SAVINGS_PROFILE: process.env.HEADROOM_SAVINGS_PROFILE ?? 'agent-90',
          HEADROOM_MODE: process.env.HEADROOM_MODE ?? 'token',
          // stdout is a pipe here, so Python block-buffers it: without this the
          // banner (and any traceback) never reaches `proxyTail` before a kill.
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const failure = classifyProxyFailure(err instanceof Error ? err.message : String(err), command)
      this.updatePersisted({ lastIssue: failure })
      this.emit('failed', failure.title)
      return { ok: false, state: this.getState(), issue: failure }
    }
    this.proxy = child
    this.proxyTrustedPort = null
    this.syncRouting()
    child.stdout?.on('data', (chunk) => { this.proxyTail += chunk.toString(); this.trimProxyTail() })
    child.stderr?.on('data', (chunk) => { this.proxyTail += chunk.toString(); this.trimProxyTail() })
    const invalidateOwnedProxy = () => {
      if (this.proxy !== child) return
      this.destroyRelayTransports()
      this.proxy = null
      this.proxyTrustedPort = null
      this.syncRouting()
    }
    // `spawn()` reports ENOENT/EACCES asynchronously. Without this listener the
    // EventEmitter contract turns a recoverable activation failure into an
    // uncaught exception that terminates the desktop sidecar.
    child.on('error', (err) => {
      this.proxyTail += `${err.message}\n`
      this.trimProxyTail()
      invalidateOwnedProxy()
    })
    // `exit` invalidates routing immediately; `close` is retained as the final
    // fallback for unusual ChildProcess implementations and stdio teardown.
    child.on('exit', invalidateOwnedProxy)
    child.on('close', invalidateOwnedProxy)

    const startTimeoutMs = getProxyStartTimeoutMs()
    const childAlive = () => child.exitCode == null && child.signalCode == null
    const healthy = await this.waitForProxyHealthy(
      state.port,
      startTimeoutMs,
      // A dead child can never become healthy — stop waiting the moment it
      // exits so a crash surfaces at once instead of after the whole budget.
      () => this.isProxyGenerationCurrent(generation) && childAlive(),
    )
    if (!this.isProxyGenerationCurrent(generation)) {
      await this.discardProxyChild(child)
      return this.cancelledProxyStart()
    }
    if (!healthy) {
      // Prefer the process's own words; otherwise say precisely which of the two
      // things happened so "did not become healthy" is never an empty box.
      const tail = this.proxyTail.trim()
      const detail = tail || (childAlive()
        ? `The Headroom proxy did not answer /livez within ${Math.round(startTimeoutMs / 1000)} s.`
        : `The Headroom proxy exited during startup (${child.signalCode ?? `exit code ${child.exitCode}`}).`)
      const failure = classifyProxyFailure(detail, command)
      await this.discardProxyChild(child)
      this.updatePersisted({ lastIssue: failure })
      this.emit('failed', failure.title)
      return { ok: false, state: this.getState(), issue: failure }
    }

    const ownsProxyPort = this.processControl.ownsProxyPort ?? processOwnsListeningPort
    const ownedEndpointIsCurrent = async () => {
      if (!this.isOwnedProxyCurrent(child, generation) || !child.pid) return false
      let listenerOwned = false
      try { listenerOwned = await ownsProxyPort(child.pid, state.port) } catch { /* fail closed */ }
      if (!listenerOwned) return false
      return this.isOwnedProxyCurrent(child, generation)
    }
    if (!(await ownedEndpointIsCurrent())) {
      const failure = issue(
        'proxy_port_busy',
        'A healthy endpoint answered, but the Specrails-owned Headroom process does not own the listening socket.',
        command,
      )
      await this.discardProxyChild(child)
      this.updatePersisted({ lastIssue: failure })
      this.emit('failed', failure.title)
      return { ok: false, state: this.getState(), issue: failure }
    }

    await this.refreshMetrics()
    if (!this.isProxyGenerationCurrent(generation)) {
      await this.discardProxyChild(child)
      return this.cancelledProxyStart()
    }
    if (!(await ownedEndpointIsCurrent())) {
      const failure = issue('proxy_unhealthy', 'The owned Headroom proxy exited during startup.', command)
      await this.discardProxyChild(child)
      this.updatePersisted({ lastIssue: failure })
      this.emit('failed', failure.title)
      return { ok: false, state: this.getState(), issue: failure }
    }
    this.proxyTrustedPort = state.port
    this.updatePersisted({ lastIssue: null })
    return { ok: true, state: this.getState() }
  }

  private cancelledProxyStart(): HeadroomActionResult {
    const failure = issue('proxy_unhealthy', 'Headroom proxy startup was superseded by a newer lifecycle operation.')
    const state = this.shuttingDown && this.shutdownState
      ? this.shutdownState
      : this.getState()
    return { ok: false, state, issue: failure }
  }

  private isProxyGenerationCurrent(generation: number): boolean {
    return !this.shuttingDown && this.proxyGeneration === generation
  }

  private isOwnedProxyCurrent(child: ChildProcess, generation: number): boolean {
    return this.isProxyGenerationCurrent(generation) &&
      this.proxy === child &&
      child.exitCode == null &&
      child.signalCode == null
  }

  private async discardProxyChild(child: ChildProcess): Promise<void> {
    if (this.proxy === child) {
      this.destroyRelayTransports()
      this.proxy = null
      this.proxyTrustedPort = null
      this.syncRouting()
    }
    await this.terminateProxyChild(child)
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

    let routes = { codex: false, claude: false }
    try {
      const state = this.readPersisted()
      const probe = spawnSync(exe, ['doctor', '--json', '--port', String(this.validPort(state.port))], {
        encoding: 'utf8',
        timeout: 5000,
        env: process.env,
      })
      const raw = `${probe.stdout ?? ''}`.trim()
      routes = probe.status === 0 && raw ? parseHeadroomDoctorRoutes(raw) : routes
      this.routeDetectionCache = { executablePath: exe, expiresAt: now + 10_000, routes, raw }
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
    if (this.shuttingDown) return
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
    if (this.shuttingDown) return
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
      activeProviders: this.explicitActiveProviders(persisted),
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
    if (!this.isProxyAvailable(port)) return null
    return await new Promise<Record<string, any> | null>((resolve, reject) => {
        let settled = false
        const finish = (value: Record<string, any> | null, err?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (err) reject(err)
          else resolve(value)
        }
        const request = http.request({
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: '/stats?cached=1',
          headers: { host: `127.0.0.1:${port}` },
          agent: this.relayAgent,
        }, (response) => {
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            response.resume()
            finish(null)
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer | string) => {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            size += value.length
            if (size > 2 * 1024 * 1024) {
              request.destroy(new Error('Headroom stats response exceeded 2 MB'))
              return
            }
            chunks.push(value)
          })
          response.on('end', () => {
            try {
              finish(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>)
            } catch (err) {
              finish(null, err instanceof Error ? err : new Error(String(err)))
            }
          })
        })
        const timer = setTimeout(() => {
          request.destroy(new Error('Headroom stats request timed out'))
        }, 2_500)
        timer.unref?.()
        request.once('error', (err) => finish(null, err))
        request.end()
      })
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
    if (this.shuttingDown) return { code: null }
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(command, args, {
          env: { ...process.env, ...extraEnv },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (err) {
        logs.push(err instanceof Error ? err.message : String(err))
        resolve({ code: null })
        return
      }
      let settled = false
      const settle = (code: number | null) => {
        if (settled) return
        settled = true
        resolve({ code })
      }
      this.trackLifecycleCommand(child, () => settle(null))
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
        settle(null)
      })
      child.on('close', (code) => settle(code))
      if (this.shuttingDown) {
        settle(null)
        void this.terminateProxyChild(child)
      }
    })
  }

  private async runCommandCapture(
    command: string,
    args: string[],
    extraEnv: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ code: number | null; output: string }> {
    if (this.shuttingDown) return { code: null, output: '' }
    return new Promise((resolve) => {
      let output = ''
      let settled = false
      let child: ChildProcess
      try {
        child = spawn(command, args, {
          env: { ...process.env, ...extraEnv },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (err) {
        resolve({ code: null, output: err instanceof Error ? err.message : String(err) })
        return
      }
      let timer: NodeJS.Timeout | null = null
      const settle = (code: number | null) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve({ code, output })
      }
      this.trackLifecycleCommand(child, () => settle(null))
      timer = setTimeout(() => {
        settle(null)
        void this.terminateProxyChild(child)
      }, timeoutMs)
      child.stdout?.on('data', (chunk) => { output += chunk.toString() })
      child.stderr?.on('data', (chunk) => { output += chunk.toString() })
      child.on('error', (err) => {
        output += err.message
        settle(null)
      })
      child.on('close', (code) => settle(code))
      if (this.shuttingDown) {
        settle(null)
        void this.terminateProxyChild(child)
      }
    })
  }

  private trackLifecycleCommand(child: ChildProcess, cancel: () => void): void {
    this.lifecycleCommands.set(child, { cancel })
    child.once('close', () => {
      this.lifecycleCommands.delete(child)
    })
  }

  /** Cancel/terminate every command, including children added while draining. */
  private async drainLifecycleCommands(): Promise<void> {
    const attempted = new Set<ChildProcess>()
    while (true) {
      const pending = [...this.lifecycleCommands.entries()]
        .filter(([child]) => !attempted.has(child))
      if (pending.length === 0) return
      for (const [child, control] of pending) {
        attempted.add(child)
        control.cancel()
      }
      await Promise.all(pending.map(([child]) => this.terminateProxyChild(child)))
    }
  }

  private async waitForProxyHealthy(
    port: number,
    timeoutMs: number,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!isCurrent()) return false
      const requestTimeoutMs = Math.max(
        1,
        Math.min(PROXY_HEALTH_REQUEST_TIMEOUT_MS, deadline - Date.now()),
      )
      const healthy = await this.fetchProxyHealth(port, requestTimeoutMs)
      if (!isCurrent()) return false
      if (healthy) return true
      if (!isCurrent()) return false
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  private async probeProxyHealthy(port: number): Promise<boolean> {
    return this.fetchProxyHealth(port, PROXY_HEALTH_REQUEST_TIMEOUT_MS)
  }

  private async fetchProxyHealth(port: number, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    timeout.unref?.()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/livez`, { signal: controller.signal })
      return res.ok
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
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

  private isProxyAvailable(port = this.validPort(this.readPersisted().port)): boolean {
    return this.proxyTrustedPort === port && this.isProxyRunning()
  }

  private async stopProxy(): Promise<void> {
    this.proxyGeneration += 1
    this.proxyStart = null
    this.destroyRelayTransports()
    const child = this.proxy
    this.proxy = null
    this.proxyTrustedPort = null
    this.syncRouting()
    const previousStop = this.proxyStop
    const stop = (async () => {
      if (previousStop) await previousStop
      if (child) await this.terminateProxyChild(child)
    })()
    this.proxyStop = stop
    try {
      await stop
    } finally {
      if (this.proxyStop === stop) this.proxyStop = null
    }
  }

  /**
   * Synchronously close lifecycle admission while other process owners drain.
   * The proxy remains alive until shutdown() so already-routed children can be
   * terminated before their transport disappears.
   */
  beginShutdown(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.syncRouting()
    const state = this.buildState(false)
    this.shutdownState = { ...state, proxyRunning: false, proxyPid: null }
  }

  /** Stop the owned proxy before the app tears down its DB and HTTP server. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.beginShutdown()
    const shutdown = this.finishShutdown()
    this.shutdownPromise = shutdown
    return shutdown
  }

  private async finishShutdown(): Promise<void> {
    // Runtime-only fail closed; persisted activation remains so a clean restart
    // can start a fresh owned proxy.
    const persistedPort = this.validPort(this.readPersisted().port)
    setHeadroomRoutingState({
      port: this.routingClientPort(persistedPort),
      relayBaseUrl: this.relayBaseUrl(),
      activeProviders: { codex: false, claude: false },
    })
    // Routed provider children inherited the stable desktop endpoint. Stop and
    // await them before the app can release that listener; until then the relay
    // remains bound and rejects any untrusted backend instead of exposing a
    // reusable Headroom port.
    const stoppingProxy = this.stopProxy()
    await Promise.all([
      terminateHeadroomRoutedChildren(),
      stoppingProxy,
      this.drainLifecycleCommands(),
    ])
    // A lifecycle action may still be unwinding an aborted health/metrics
    // request. Keep the desktop DB alive until it has observed `shuttingDown`
    // and completed; queued actions fail at their locked-method guard.
    await this.lifecycleTail
    // Defense in depth for future lifecycle operations: no child may survive a
    // completed shutdown even if a new await is added after an initial guard.
    await this.drainLifecycleCommands()
    await this.stopProxy()
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

  private relayBaseUrl(): string | undefined {
    const origin = this.processControl.relayOrigin
    if (!origin) return undefined
    try {
      const parsed = new URL(origin)
      if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
        return undefined
      }
      return `${parsed.origin}${HEADROOM_RELAY_PATH}/${this.relayToken}`
    } catch {
      return undefined
    }
  }

  private relayDiagnosticBaseUrl(): string | undefined {
    const relay = this.relayBaseUrl()
    if (!relay) return undefined
    return `${new URL(relay).origin}${HEADROOM_RELAY_PATH}/<redacted>`
  }

  private routingClientPort(backendPort: number): number {
    const relay = this.relayBaseUrl()
    if (!relay) return backendPort
    try {
      const parsed = new URL(relay)
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
      return this.validPort(port)
    } catch {
      return backendPort
    }
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

  private explicitActiveProviders(
    persisted: PersistedHeadroomState,
  ): Record<HeadroomProvider, boolean> {
    const activation = persisted.activation
    if (
      activation?.version !== HEADROOM_ACTIVATION_SCHEMA_VERSION ||
      activation.source !== HEADROOM_ACTIVATION_SOURCE
    ) return { codex: false, claude: false }
    return {
      codex: activation.activeProviders?.codex === true,
      claude: activation.activeProviders?.claude === true,
    }
  }

  private activationPatch(
    activeProviders: Partial<Record<HeadroomProvider, boolean>>,
  ): Pick<PersistedHeadroomState, 'activeProviders' | 'activation'> {
    const normalized = providerRecord(activeProviders)
    return {
      // Retain the old field for diagnostics/downgrades, but the versioned
      // envelope below is the sole routing authority.
      activeProviders: normalized,
      activation: {
        version: HEADROOM_ACTIVATION_SCHEMA_VERSION,
        source: HEADROOM_ACTIVATION_SOURCE,
        activeProviders: normalized,
      },
    }
  }

  private syncRouting(): void {
    const persisted = this.readPersisted()
    const port = this.validPort(persisted.port)
    const trustedRuntimeAvailable = this.proxyTrustedPort === port && this.isProxyRunning()
    const explicitActiveProviders = this.explicitActiveProviders(persisted)
    setHeadroomRoutingState({
      port: this.routingClientPort(port),
      relayBaseUrl: this.relayBaseUrl(),
      activeProviders: this.shuttingDown || !trustedRuntimeAvailable ? { codex: false, claude: false } : {
        codex: explicitActiveProviders.codex,
        claude: explicitActiveProviders.claude,
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
