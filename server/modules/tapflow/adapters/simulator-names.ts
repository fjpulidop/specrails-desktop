/**
 * iOS simulator names by UDID (`xcrun simctl list devices -j`), so Resources says "iPhone 17 Pro" instead
 * of a UDID. Read in the background at most every 30 s; callers get what is known now (never block a
 * sample on simctl).
 */
import { execFile } from 'node:child_process'

const TTL_MS = 30_000

export function parseSimctlDevices(json: string): Map<string, string> {
  const names = new Map<string, string>()
  try {
    const parsed = JSON.parse(json) as { devices?: Record<string, Array<{ udid?: unknown; name?: unknown }>> }
    for (const list of Object.values(parsed.devices ?? {})) {
      for (const device of list ?? []) if (typeof device.udid === 'string' && typeof device.name === 'string') names.set(device.udid.toUpperCase(), device.name)
    }
  } catch { /* unreadable: no names */ }
  return names
}

export function createSimulatorNames(read: () => Promise<string> = () => new Promise((resolve) => {
  execFile('xcrun', ['simctl', 'list', 'devices', '-j'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout))
}), now: () => number = Date.now) {
  let names = new Map<string, string>()
  let readAt = -Infinity
  let reading: Promise<void> | null = null
  return {
    /** The names known now; refreshes in the background when stale. */
    current(): ReadonlyMap<string, string> {
      if (process.platform === 'darwin' && !reading && now() - readAt > TTL_MS) {
        readAt = now()
        reading = read().then((json) => { if (json) names = parseSimctlDevices(json) }).finally(() => { reading = null })
      }
      return names
    },
  }
}
