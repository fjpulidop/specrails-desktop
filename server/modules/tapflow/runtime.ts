/**
 * Composition of the Tapflow plugin for the server: real adapters bound to the app database, the
 * bundled Node, the terminal manager and the WS broadcast.
 */
import type { DbInstance } from '../../db'
import { resolveBundledNodeExe } from '../../path-resolver'
import { getTerminalManager } from '../terminals/runtime/terminal-manager'
import { createTapflowPlugin, type TapflowPlugin } from './application'
import type { TapflowStatus } from './domain'
import { createInstallation, createInstallerTerminal, createTapflowService, tapflowPaths } from './adapters/process'
import { createTapflowRelay } from './adapters/relay'
import { createTapflowStore } from './adapters/store'
import { createFootprintReader } from './adapters/footprint'
import { createTapflowDelivery } from './adapters/delivery'
import { createMobileBuilder } from './adapters/mobile-build'
import { createMobileTestHandlers } from './adapters/mobile-handlers'
import { refreshMobileTestOffer, type MobileOfferEnv } from './adapters/mobile-offer'
import { createMobileRunsStore } from './adapters/mobile-runs-store'
import { observeDeliveries } from '../delivery/runtime/delivery-observers'
import { createDeviceWindows } from './adapters/device-window'
import { deviceTreePids, tapflowResourceRoots } from './domain'

/** Tapflow's own default port: a Tapflow the person runs themselves answers there. */
const TAPFLOW_OWN_PORT = 4000

let current: TapflowPlugin | null = null
let currentStore: ReturnType<typeof createTapflowStore> | null = null
let currentRelay: ReturnType<typeof createTapflowRelay> | null = null

const footprints = createFootprintReader()

/**
 * The process table with each Tapflow device's processes measured by physical footprint instead of RSS
 * (RSS counts a simulator's shared memory once per process). Unchanged when no device runs.
 */
export function withDeviceFootprints<Row extends { pid: number; ppid: number; command: string; rssBytes: number }>(table: Row[]): Row[] {
  const pids = deviceTreePids(table, tapflowResourceRoots(table, tapflowServicePid()))
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
  // "Test in Mobile Device" follows every delivery change (an offer card in the mission).
  observeDeliveries((ctx, deliveryId) => { void refreshMobileTestOffer(ctx, deliveryId, mobileOfferEnv) })
  return current
}

/** Tapflow is installed on a supported machine (a mobile test can run, or be started once it is on). */
export async function tapflowReady(): Promise<boolean> {
  const phase = current ? (await current.status()).phase : 'not-installed'
  return phase !== 'unsupported' && phase !== 'not-installed' && phase !== 'installing'
}

export const mobileOfferEnv: MobileOfferEnv = { tapflowReady }

let deviceWindowsInstance: ReturnType<typeof createDeviceWindows> | null = null
/** Device windows (tickets, the signed-in redirect, release on close), bound to the managed install. */
export function tapflowDeviceWindows(): ReturnType<typeof createDeviceWindows> {
  deviceWindowsInstance ??= createDeviceWindows({
    secretsDir: tapflowPaths().secretsDir,
    port: () => { const state = currentStore?.read(); return state?.installedVersion ? state.port : null },
  })
  return deviceWindowsInstance
}

/** Host-task handlers of `factory:mobile-test` for one project database. */
export function createMobileTestHandlersFor(db: DbInstance, onFinished?: (runId: string) => void) {
  const paths = tapflowPaths()
  return createMobileTestHandlers({
    store: createMobileRunsStore(db),
    build: createMobileBuilder(),
    deliver: createTapflowDelivery({
      paths,
      target: () => {
        const state = currentStore?.read()
        return state?.installedVersion && state.nodePath ? { port: state.port, nodePath: state.nodePath } : null
      },
      answering: (port) => currentRelay?.answering(port) ?? Promise.resolve(false),
    }),
    onFinished,
  })
}
