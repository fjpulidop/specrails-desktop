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
import { deviceTreePids, tapflowResourceRoots } from './domain'

/** Tapflow's own default port: a Tapflow the person runs themselves answers there. */
const TAPFLOW_OWN_PORT = 4000

let current: TapflowPlugin | null = null

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
  current = createTapflowPlugin({
    host: { platform: process.platform, arch: process.arch },
    store: createTapflowStore(deps.db),
    installation: createInstallation({ paths, bundledNode: resolveBundledNodeExe }),
    installer: createInstallerTerminal({ paths, terminals: getTerminalManager }),
    service: createTapflowService({ paths }),
    relay,
    externalRelayAnswering: () => relay.answering(TAPFLOW_OWN_PORT),
    onChange: (status) => deps.broadcast({ type: 'plugin.tapflow_status', status }),
  })
  return current
}
