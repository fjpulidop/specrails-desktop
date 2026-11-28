/**
 * Tapflow plugin: pure rules. Which machines can run it, what state the card shows, how the supervised
 * service is configured, and which processes are Tapflow's in the Resources view. No I/O here.
 *
 * Facts this rests on (Tapflow 0.33.0, measured in the 2026-11-28 spike, see the module README):
 * its agents run only on macOS on Apple Silicon; `tapflow start` is one foreground Node process with no
 * daemon, PID file or health route; its relay binds every interface; a booted simulator's processes
 * descend from launchd, not from Tapflow.
 */

/** Pinned: Tapflow drives SimulatorKit private APIs that break on Xcode majors; an upgrade is a reviewed change. */
export const TAPFLOW_VERSION = '0.33.0'

/** Not Tapflow's 4000, so a Tapflow the person runs themselves keeps its port. */
export const TAPFLOW_DEFAULT_PORT = 4310
export const TAPFLOW_MIN_NODE_MAJOR = 22

export type TapflowPhase =
  | 'unsupported'
  | 'not-installed'
  | 'installing'
  | 'installed'
  | 'starting'
  | 'running'
  | 'running-external'
  | 'failed'

export interface TapflowIssue {
  code: 'unsupported-platform' | 'install-failed' | 'setup-incomplete' | 'service-exited' | 'start-timeout' | 'bootstrap-failed' | 'node-missing'
  detail: string
}

/** Persisted (desktop settings). Liveness is never persisted: it is probed. */
export interface TapflowStoredState {
  installedVersion: string | null
  /** The Node that installed Tapflow is the one that runs it (`better-sqlite3` ABI). */
  nodePath: string | null
  active: boolean
  port: number
}

export const EMPTY_TAPFLOW_STATE: TapflowStoredState = { installedVersion: null, nodePath: null, active: false, port: TAPFLOW_DEFAULT_PORT }

export interface TapflowStatus {
  phase: TapflowPhase
  /** True when Specrails manages this install (it may also detect one the person made). */
  managed: boolean
  version: string | null
  port: number
  /** Set when the card should explain something: why it is unsupported, why the last start or install failed. */
  issue: TapflowIssue | null
  /** Shown before install: what each platform needs. */
  requirements: { ios: string; android: string }
  /** Terminal session of a running install, so a reopened window can attach to it again. */
  installerSessionId: string | null
}

export const TAPFLOW_REQUIREMENTS = {
  ios: 'iOS Simulator needs macOS on Apple Silicon with Xcode 26 or 27.',
  android: 'Android emulators also need Apple Silicon in this Tapflow version (Windows is not supported yet).',
} as const

export interface HostFacts {
  platform: NodeJS.Platform
  arch: string
}

/** Tapflow's agents ship arm64-only macOS helpers; nothing else can run them. */
export function platformIssue(host: HostFacts): TapflowIssue | null {
  if (host.platform !== 'darwin') return { code: 'unsupported-platform', detail: 'Tapflow runs its simulators on macOS on Apple Silicon only.' }
  if (host.arch !== 'arm64') return { code: 'unsupported-platform', detail: 'Tapflow needs an Apple Silicon Mac; Intel Macs are not supported.' }
  return null
}

export interface TapflowObservation {
  host: HostFacts
  stored: TapflowStoredState
  /** The managed packages are present on disk at the stored version. */
  managedInstallPresent: boolean
  /** A `tapflow` the person installed (on PATH or with a config in ~/.tapflow). */
  externalInstall: boolean
  installing: { sessionId: string } | null
  /** The supervised child: alive, being started, or none. */
  supervised: 'none' | 'starting' | 'alive'
  /** Something answers Tapflow's liveness route on the stored port, or a `tapflow start` process runs. */
  relayAnswering: boolean
  externalProcessRunning: boolean
  lastIssue: TapflowIssue | null
}

/** The one status the card shows, from what was observed. */
export function deriveStatus(o: TapflowObservation): TapflowStatus {
  const base = { port: o.stored.port, requirements: TAPFLOW_REQUIREMENTS, installerSessionId: o.installing?.sessionId ?? null }
  const unsupported = platformIssue(o.host)
  if (unsupported) return { ...base, phase: 'unsupported', managed: false, version: null, issue: unsupported }
  const managed = o.managedInstallPresent
  const version = managed ? o.stored.installedVersion : null
  if (o.installing) return { ...base, phase: 'installing', managed, version, issue: null }
  if (o.supervised === 'starting') return { ...base, phase: 'starting', managed, version, issue: null }
  if (o.supervised === 'alive' && o.relayAnswering) return { ...base, phase: 'running', managed, version, issue: null }
  if (o.supervised === 'alive') return { ...base, phase: 'starting', managed, version, issue: null }
  // Not ours: used as is, never stopped by Specrails.
  if (o.relayAnswering || o.externalProcessRunning) return { ...base, phase: 'running-external', managed, version, issue: null }
  if (!managed && !o.externalInstall) return { ...base, phase: 'not-installed', managed, version, issue: o.lastIssue }
  return { ...base, phase: 'installed', managed, version, issue: o.lastIssue }
}

export function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim())
  return match ? Number(match[1]) : null
}

/** `tapflow.config.json` Specrails writes instead of running `tapflow init` (no prompts). */
export function tapflowConfig(port: number): Record<string, unknown> {
  return { local: { port }, agent: { lean: true } }
}

/**
 * Environment of the supervised service: the lightest profile that still streams well on a laptop.
 * Lean mode (~0.5 GB less per iOS simulator), no audio, the display may sleep, a smaller stream and
 * two automated devices (one per platform: "Both" boots an iPhone and an Android emulator; with one, the
 * second boot was refused as host-at-capacity). The loopback preload keeps the relay off the network.
 */
export function serviceEnvironment(opts: { home: string; port: number; preloadPath: string; nodeBinDir: string; basePath: string; androidSdk?: string | null }): Record<string, string> {
  // Tapflow registers its Android agent only when `which adb` finds adb (android-agent/src/index.ts): the
  // SDK's tools join the PATH, or a Mac set up for Android would show iOS devices only.
  const android = opts.androidSdk ? [`${opts.androidSdk}/platform-tools`, `${opts.androidSdk}/emulator`] : []
  return {
    TAPFLOW_HOME: opts.home,
    TAPFLOW_PORT: String(opts.port),
    TAPFLOW_LEAN: 'on',
    TAPFLOW_AUDIO: 'off',
    TAPFLOW_ALLOW_DISPLAY_SLEEP: '1',
    TAPFLOW_MAX_SIZE: '1000',
    TAPFLOW_MAX_AUTOMATED_DEVICES: '2',
    NODE_OPTIONS: `--require ${JSON.stringify(opts.preloadPath)}`,
    PATH: [opts.nodeBinDir, ...android, opts.basePath].filter(Boolean).join(':'),
    ...(opts.androidSdk ? { ANDROID_HOME: opts.androidSdk } : {}),
  }
}

/** The Android SDK Tapflow's setup installs (or the person's): ANDROID_HOME, ANDROID_SDK_ROOT, else the macOS default. */
export function androidSdkCandidates(env: Record<string, string | undefined>, home: string): string[] {
  return [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, `${home}/Library/Android/sdk`].filter((value): value is string => Boolean(value && value.trim()))
}

/** Android Studio's bundled JDK on macOS, the only JDK on many Macs set up for Android. */
export const ANDROID_STUDIO_JDK = '/Applications/Android Studio.app/Contents/jbr/Contents/Home'

/**
 * What a Gradle build in a worktree needs beyond the server's environment. A worktree has no
 * `local.properties` (Android Studio writes it and it is ignored), so the SDK comes from ANDROID_HOME; a
 * Mac whose only JDK is Android Studio's has no `java` for Gradle unless JAVA_HOME points at it. The
 * person's own variables always win.
 */
export function androidBuildEnvironment(env: Record<string, string | undefined>, found: { sdk: string | null; jdk: string | null }): Record<string, string> {
  return {
    ...(!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT && found.sdk ? { ANDROID_HOME: found.sdk } : {}),
    ...(!env.JAVA_HOME && found.jdk ? { JAVA_HOME: found.jdk } : {}),
  }
}

/**
 * Shell script the installer terminal runs (macOS only, so zsh is always there): the pinned tree with
 * Specrails' Node and npm (`npm ci` on the pinned lockfile), then Tapflow's own interactive setup, whose prompts the person answers.
 */
export function installerScript(opts: { nodePath: string; npmCli: string; toolsDir: string; tapflowCli: string; home: string }): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  return [
    'set -e',
    `echo ${q(`Installing Tapflow ${TAPFLOW_VERSION} with Specrails' Node…`)}`,
    `mkdir -p ${q(opts.toolsDir)} ${q(opts.home)}`,
    `cd ${q(opts.toolsDir)}`,
    // package.json and package-lock.json were written by Specrails (adapters/pinned.ts): `npm ci` installs
    // exactly that tree, verifying each package's integrity, and fails rather than resolve anything newer.
    `${q(opts.nodePath)} ${q(opts.npmCli)} ci --prefix ${q(opts.toolsDir)} --no-audit --no-fund`,
    'echo',
    `echo ${q('Tapflow is installed. Its setup checks Xcode and the Android SDK and asks before each step:')}`,
    `TAPFLOW_HOME=${q(opts.home)} ${q(opts.nodePath)} ${q(opts.tapflowCli)} setup`,
  ].join('\n')
}

/** Minimal process row (the shared sampler's `ProcessSample`). */
export interface ProcessRow { pid: number; ppid: number; command: string }

/** A root of the `tapflow` category: a device (with Tapflow's id: simulator UDID or `avd:<name>`) or the service. */
export interface TapflowResourceRoot { label: string; pid: number; kind: 'device' | 'service'; deviceId?: string }

const IOS_DEVICE = /CoreSimulator\/Devices\/([0-9A-F-]{36})\//i
const ANDROID_AVD = /(?:^|\s)-avd\s+(\S+)/

/** A `tapflow start` the person runs themselves, by its command line. */
export function isTapflowServiceCommand(command: string): boolean {
  return /(?:^|[\s/])tapflow(?:\.js)?\s+start(?:\s|$)/.test(command)
}

/**
 * The processes the `tapflow` resource category claims: the service tree, then one root per booted iOS
 * simulator (its `launchd_sim`, which every simulator process descends from) and per Android emulator.
 * Only while a Tapflow service runs: a simulator Xcode booted on its own is not Tapflow's.
 */
export function tapflowResourceRoots(table: readonly ProcessRow[], servicePid: number | null, simulatorNames: ReadonlyMap<string, string> = new Map()): TapflowResourceRoot[] {
  const service = servicePid ?? table.find((row) => isTapflowServiceCommand(row.command))?.pid ?? null
  if (service === null || !table.some((row) => row.pid === service)) return []
  // Devices first: an emulator Tapflow starts is the service's child, and the first root that reaches a
  // process claims it; listed after the service, it was counted as "Tapflow service".
  const roots: TapflowResourceRoot[] = []
  for (const row of table) {
    const ios = /launchd_sim/.test(row.command) ? IOS_DEVICE.exec(row.command) : null
    if (ios) {
      const udid = ios[1]!.toUpperCase()
      const name = simulatorNames.get(udid)
      roots.push({ label: name ? `${name} (iOS Simulator)` : `iOS Simulator ${udid.slice(0, 8)}`, pid: row.pid, kind: 'device', deviceId: udid })
      continue
    }
    if (/(?:^|\/)(qemu-system-[\w-]+|emulator)(?:\s|$)/.test(row.command)) {
      const avd = ANDROID_AVD.exec(row.command)
      if (avd) roots.push({ label: `${avd[1]} (Android Emulator)`, pid: row.pid, kind: 'device', deviceId: `avd:${avd[1]}` })
    }
  }
  roots.push({ label: 'Tapflow service', pid: service, kind: 'service' })
  return roots
}

/**
 * Pids of every simulator/emulator tree among the roots (not the service). Their memory is reported as the
 * physical footprint, not RSS: a booted iPhone simulator is ~190 processes sharing the dyld cache and
 * framebuffers, so summing RSS reported 12.9 GB for a device whose footprint was 2.9 GB (spike, 2026-11-28).
 */
export function deviceTreePids(table: readonly ProcessRow[], roots: readonly TapflowResourceRoot[]): number[] {
  const deviceRoots = roots.filter((root) => root.kind === 'device').map((root) => root.pid)
  if (!deviceRoots.length) return []
  const children = new Map<number, number[]>()
  for (const row of table) {
    if (row.ppid === row.pid) continue
    const list = children.get(row.ppid)
    if (list) list.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }
  const out = new Set<number>()
  const stack = [...deviceRoots]
  while (stack.length) {
    const pid = stack.pop()!
    if (out.has(pid)) continue
    out.add(pid)
    stack.push(...(children.get(pid) ?? []))
  }
  return [...out]
}

const MEMORY_UNITS: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }

/** macOS `top -l 1 -stats pid,mem` rows (`MEM` is the physical footprint, e.g. `30M`, `2230M+`, `1.2G`, `512K`). */
export function parseTopMemory(output: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+([\d.]+)([BKMGT])[+-]?\s*$/.exec(line)
    if (!match) continue
    out.set(Number(match[1]), Math.round(Number(match[2]) * MEMORY_UNITS[match[3]!]!))
  }
  return out
}

/**
 * Tapflow's MCP server as mission agents receive it (stdio, the Node that runs Tapflow). Name `tapflow`:
 * a person's own server of that name wins. The token is the `view,builds:write` one Specrails created.
 */
export function tapflowMcpServer(opts: { nodePath: string; toolsDir: string; port: number; token: string }): { id: string; name: string; config: Record<string, unknown> } {
  return {
    id: 'managed:tapflow',
    name: 'tapflow',
    config: {
      command: opts.nodePath,
      args: [`${opts.toolsDir}/node_modules/@tapflowio/mcp-server/dist/index.js`],
      env: { TAPFLOW_RELAY_URL: `ws://127.0.0.1:${opts.port}`, TAPFLOW_TOKEN: opts.token },
    },
  }
}
