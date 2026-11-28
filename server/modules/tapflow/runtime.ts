/**
 * Composition of the Tapflow plugin for the server: real adapters bound to the app database, the
 * bundled Node, the terminal manager and the WS broadcast.
 */
import type { DbInstance } from '../../db'
import { resolveBundledNodeExe } from '../../path-resolver'
import { getTerminalManager } from '../terminals/runtime/terminal-manager'
import { createTapflowPlugin, type TapflowPlugin } from './application'
import type { ProcessRow, TapflowResourceRoot, TapflowStatus } from './domain'
import { createInstallation, createInstallerTerminal, createTapflowService, tapflowPaths } from './adapters/process'
import { createTapflowRelay } from './adapters/relay'
import { createTapflowStore } from './adapters/store'
import { createFootprintReader } from './adapters/footprint'
import { createTapflowDelivery, createTapflowDeviceList, type ChoosableDevice } from './adapters/delivery'
import { createMobileBuilder } from './adapters/mobile-build'
import { createMobileTestHandlers } from './adapters/mobile-handlers'
import { refreshMobileTestOffer, type MobileOfferEnv } from './adapters/mobile-offer'
/** Starting a mobile test and reading a run, for the in-app agent's MCP tool. */
export { mobileTestRunView, startMobileTest } from './adapters/mobile-offer'
import { createMobileRunsStore } from './adapters/mobile-runs-store'
import { mobileRunActivePid, mobileRunActivePids, mobileRunLine, mobileRunPid } from './adapters/mobile-run-process'
import { createSimulatorNames } from './adapters/simulator-names'
import { observeDeliveries } from '../delivery/runtime/delivery-observers'
import { createDeviceWindows } from './adapters/device-window'
import { createTapflowSecrets } from './adapters/relay'
import { tapflowMcpServer } from './domain'
import { registerManagedMcpServer } from '../../external-mcp'
import { deviceTreePids, tapflowResourceRoots } from './domain'

/** Tapflow's own default port: a Tapflow the person runs themselves answers there. */
const TAPFLOW_OWN_PORT = 4000

let current: TapflowPlugin | null = null
let currentStore: ReturnType<typeof createTapflowStore> | null = null
let currentRelay: ReturnType<typeof createTapflowRelay> | null = null

const footprints = createFootprintReader()
const simulatorNames = createSimulatorNames()

/** The `tapflow` resource roots now: the service and each device, simulators by name. */
export function tapflowRoots(table: readonly ProcessRow[]): TapflowResourceRoot[] {
  return tapflowResourceRoots(table, tapflowServicePid(), simulatorNames.current())
}

/**
 * What a mission's Resources shows of Tapflow: the devices its mobile tests launched (matched by Tapflow
 * id, while they run), the build of a run in progress, and the Tapflow service while either is there.
 */
export function missionTapflowRoots(db: DbInstance, conversationId: string, table: readonly ProcessRow[]): Array<{ id: string; kind: 'mobile-device' | 'mobile-build' | 'tapflow-service'; label: string; pid: number }> {
  const runs = createMobileRunsStore(db).listForConversation(conversationId)
  if (!runs.length) return []
  const wanted = new Set<string>()
  const roots: Array<{ id: string; kind: 'mobile-device' | 'mobile-build' | 'tapflow-service'; label: string; pid: number }> = []
  for (const run of runs) {
    for (const device of Array.isArray(run.result?.devices) ? run.result.devices as Array<{ id?: unknown }> : []) if (typeof device.id === 'string') wanted.add(device.id.toUpperCase())
    if (run.state !== 'running') continue
    for (const id of Object.values(run.devices)) if (id) wanted.add(id.toUpperCase())
    const pid = mobileRunActivePid(run.runId)
    if (pid) roots.push({ id: `mobile-build:${run.runId}`, kind: 'mobile-build', label: 'Mobile build', pid })
  }
  const live = tapflowRoots(table)
  const devices = live.filter((root) => root.kind === 'device' && root.deviceId && wanted.has(root.deviceId.toUpperCase()))
  for (const device of devices) roots.unshift({ id: `mobile-device:${device.deviceId}`, kind: 'mobile-device', label: device.label, pid: device.pid })
  const service = live.find((root) => root.kind === 'service')
  if (service && roots.length) roots.push({ id: 'tapflow-service', kind: 'tapflow-service', label: service.label, pid: service.pid })
  return roots
}

/** Mobile test builds in progress (the app-wide Resources' Tapflow category). */
export function mobileBuildRoots(): Array<{ runId: string; pid: number }> {
  return mobileRunActivePids()
}

/** Conversations with a mobile test building or installing (the mission resource recorder samples them). */
export function missionsWithRunningMobileTests(db: DbInstance): string[] {
  try { return createMobileRunsStore(db).runningConversations() } catch { return [] }
}

/**
 * The process table with each Tapflow device's processes measured by physical footprint instead of RSS
 * (RSS counts a simulator's shared memory once per process). Unchanged when no device runs.
 */
export function withDeviceFootprints<Row extends { pid: number; ppid: number; command: string; rssBytes: number }>(table: Row[]): Row[] {
  const pids = deviceTreePids(table, tapflowRoots(table))
  if (!pids.length) return table
  const known = footprints.current(pids)
  if (!known.size) return table
  return table.map((row) => (known.has(row.pid) ? { ...row, rssBytes: known.get(row.pid)! } : row))
}

/** The supervised Tapflow service pid, or null (resource metering and the worktree reaper's protected roots). */
export function tapflowServicePid(): number | null {
  return current?.servicePid() ?? null
}

export function createTapflowRuntime(deps: { db: DbInstance; broadcast: (message: { type: 'plugin.tapflow_status'; status: TapflowStatus }) => void }): TapflowPlugin {
  const paths = tapflowPaths()
  const relay = createTapflowRelay({ secretsDir: paths.secretsDir })
  const store = createTapflowStore(deps.db)
  currentStore = store
  currentRelay = relay
  current = createTapflowPlugin({
    host: { platform: process.platform, arch: process.arch },
    store,
    installation: createInstallation({ paths, bundledNode: resolveBundledNodeExe }),
    installer: createInstallerTerminal({ paths, terminals: getTerminalManager }),
    service: createTapflowService({ paths }),
    relay,
    externalRelayAnswering: () => relay.answering(TAPFLOW_OWN_PORT),
    onChange: (status) => deps.broadcast({ type: 'plugin.tapflow_status', status }),
  })
  // Mission agents get Tapflow's MCP (devices, screenshots, UI tree, taps) while Specrails runs Tapflow.
  registerManagedMcpServer(() => {
    const state = store.read()
    const token = createTapflowSecrets(paths.secretsDir).token()
    if (!current?.servicePid() || !state.nodePath || !token) return null
    return tapflowMcpServer({ nodePath: state.nodePath, toolsDir: paths.toolsDir, port: state.port, token })
  })
  // "Test in Mobile Device" follows every delivery change (an offer card in the mission).
  observeDeliveries((ctx, deliveryId) => { void refreshMobileTestOffer(ctx, deliveryId, mobileOfferEnv) })
  return current
}

/** Tapflow is installed on a supported machine (a mobile test can run, or be started once it is on). */
export async function tapflowReady(): Promise<boolean> {
  const phase = current ? (await current.status()).phase : 'not-installed'
  return phase !== 'unsupported' && phase !== 'not-installed' && phase !== 'installing'
}

export const mobileOfferEnv: MobileOfferEnv = {
  tapflowReady,
  devices: () => tapflowDevices(),
  // Followed in a mission's Processes only while Specrails runs the service (it writes this log).
  serviceLog: () => (currentStore?.read()?.installedVersion ? tapflowPaths().serviceLog : null),
}

let deviceWindowsInstance: ReturnType<typeof createDeviceWindows> | null = null
/** Device windows (tickets, the signed-in redirect, release on close), bound to the managed install. */
export function tapflowDeviceWindows(): ReturnType<typeof createDeviceWindows> {
  deviceWindowsInstance ??= createDeviceWindows({
    secretsDir: tapflowPaths().secretsDir,
    port: () => { const state = currentStore?.read(); return state?.installedVersion ? state.port : null },
  })
  return deviceWindowsInstance
}

/** Where the managed Tapflow answers, for delivery and the device list. */
const managedTarget = () => {
  const state = currentStore?.read()
  return state?.installedVersion && state.nodePath ? { port: state.port, nodePath: state.nodePath } : null
}
const managedAnswering = (port: number) => currentRelay?.answering(port) ?? Promise.resolve(false)

/** Host-task handlers of `factory:mobile-test` for one project database. */
export function createMobileTestHandlersFor(db: DbInstance, onFinished?: (runId: string) => void) {
  return createMobileTestHandlers({
    store: createMobileRunsStore(db),
    build: createMobileBuilder(),
    deliver: createTapflowDelivery({ paths: tapflowPaths(), target: managedTarget, answering: managedAnswering }),
    onFinished,
    watch: { line: mobileRunLine, pid: mobileRunPid },
  })
}

/** The devices a run can be pointed at, while Tapflow is on (null otherwise). */
export function tapflowDevices(): Promise<ChoosableDevice[] | null> {
  return createTapflowDeviceList({ paths: tapflowPaths(), target: managedTarget, answering: managedAnswering })()
}
