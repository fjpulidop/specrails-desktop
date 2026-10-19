import os from 'node:os'
import { getBackgroundProcessLogs, type BackgroundProcess, type BackgroundProcessLogSnapshot } from '../../../transient-children'
import { appUrlsFromLines, isPrivateIPv4, type AppUrls } from '../domain/app-urls'

/** Statuses whose announced URLs are still served. */
const LIVE_STATUSES = new Set<BackgroundProcess['status']>(['starting', 'running'])
/** Dev servers announce their URL early but may re-announce after a restart. */
const SCAN_LIMIT = 2000
const MAX_MEMO_ENTRIES = 256

export interface AppUrlDeps {
  logs(process: BackgroundProcess): BackgroundProcessLogSnapshot | null
  lanAddresses(): string[]
}

/** This machine's private IPv4 addresses (Wi-Fi/Ethernet and VPNs such as Tailscale). */
export function lanIPv4Addresses(): string[] {
  const addresses: string[] = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)) addresses.push(entry.address)
    }
  }
  return addresses
}

const defaultDeps: AppUrlDeps = {
  logs: (process) => getBackgroundProcessLogs(process.pid, { projectId: process.projectId, processId: process.processId, limit: SCAN_LIMIT }),
  lanAddresses: lanIPv4Addresses,
}

/**
 * Attaches `appUrls` to a running process: the addresses its own output
 * announced, so Desktop and the Companion can offer them as links that open in
 * the device's browser. Derived on read and never persisted; finished or
 * recovered processes get none. A memo keyed on the log tail keeps repeated
 * reads cheap.
 */
export function createAppUrlResolver(deps: AppUrlDeps = defaultDeps): (process: BackgroundProcess) => BackgroundProcess {
  const memo = new Map<string, { key: string; urls: AppUrls }>()
  return (process) => {
    if (!LIVE_STATUSES.has(process.status)) {
      memo.delete(process.processId)
      return process
    }
    let snapshot: BackgroundProcessLogSnapshot | null = null
    try { snapshot = deps.logs(process) } catch { snapshot = null }
    if (!snapshot) return process
    let lan: string[] = []
    try { lan = deps.lanAddresses() } catch { lan = [] }
    const last = snapshot.lines[snapshot.lines.length - 1]
    const key = `${snapshot.nextSequence}:${last?.sequence ?? 0}:${last?.line.length ?? 0}:${lan.join(',')}`
    let entry = memo.get(process.processId)
    if (entry?.key !== key) {
      // Keyed by unique execution id; bound it for processes never read again after exiting.
      if (!entry && memo.size >= MAX_MEMO_ENTRIES) memo.clear()
      entry = { key, urls: appUrlsFromLines(snapshot.lines.map((line) => line.line), lan) }
      memo.set(process.processId, entry)
    }
    const { local, network } = entry.urls
    return local.length || network.length ? { ...process, appUrls: { local: [...local], network: [...network] } } : process
  }
}

/** Shared resolver for routes, events and the mission MCP tools. */
export const withAppUrls = createAppUrlResolver()
