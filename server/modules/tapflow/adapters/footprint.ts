/**
 * Physical footprint of simulator/emulator processes on macOS, for the Resources view. `ps` RSS counts the
 * memory a simulator's ~190 processes share once per process (12.9 GB reported for a 2.9 GB device);
 * `top`'s MEM column is the footprint. One `top` sample costs ~0.6 s of CPU, so it runs only while a device
 * is booted and the view is polled, at most every 15 s, in the background (the view never waits for it).
 */
import { execFile } from 'node:child_process'
import { parseTopMemory } from '../domain'

export type RunTop = () => Promise<string>

const defaultRunTop: RunTop = () => new Promise((resolve, reject) => {
  execFile('top', ['-l', '1', '-stats', 'pid,mem', '-n', '5000'], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
})

export interface FootprintReader {
  /** Footprints known for these pids now (possibly up to `ttlMs` old); starts a refresh when stale. */
  current(pids: readonly number[]): Map<number, number>
}

export function createFootprintReader(deps: { runTop?: RunTop; ttlMs?: number; now?: () => number; platform?: NodeJS.Platform } = {}): FootprintReader {
  const runTop = deps.runTop ?? defaultRunTop
  const ttlMs = deps.ttlMs ?? 15_000
  const now = deps.now ?? Date.now
  let sample = new Map<number, number>()
  let sampledAt = -Infinity
  let refreshing = false
  return {
    current: (pids) => {
      if ((deps.platform ?? process.platform) !== 'darwin' || pids.length === 0) return new Map()
      if (!refreshing && now() - sampledAt >= ttlMs) {
        refreshing = true
        runTop().then((output) => { sample = parseTopMemory(output); sampledAt = now() }, () => { sampledAt = now() }).finally(() => { refreshing = false })
      }
      const out = new Map<number, number>()
      for (const pid of pids) {
        const bytes = sample.get(pid)
        if (bytes !== undefined) out.set(pid, bytes)
      }
      return out
    },
  }
}
