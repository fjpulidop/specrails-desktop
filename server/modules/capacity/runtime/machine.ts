/**
 * Machine samples for run admission: the busy fraction of every core over the
 * last few seconds (from `os.cpus()` tick deltas, no process spawned) and the
 * available memory where the platform reports it honestly. macOS `os.freemem()`
 * leaves out inactive pages the OS hands out on demand, so it reads "almost
 * full" on a healthy machine: memory is not checked there (null).
 */
import fs from 'node:fs'
import os from 'node:os'
import type { MachineSample } from '../domain'

interface Ticks { idle: number; total: number }

function ticks(): Ticks {
  let idle = 0, total = 0
  for (const cpu of os.cpus()) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/** Busy fraction between two tick readings (0..1), null when no time passed. Pure. */
export function busyBetween(before: Ticks, after: Ticks): number | null {
  const total = after.total - before.total
  if (!(total > 0)) return null
  return Math.min(1, Math.max(0, 1 - (after.idle - before.idle) / total))
}

/** `MemAvailable` from Linux `/proc/meminfo`, in MB. Pure. */
export function memAvailableMb(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo)
  return match ? Math.round(Number(match[1]) / 1024) : null
}

function availableMemoryMb(): number | null {
  if (process.platform === 'darwin') return null
  if (process.platform === 'linux') {
    try { return memAvailableMb(fs.readFileSync('/proc/meminfo', 'utf8')) } catch { return null }
  }
  return Math.round(os.freemem() / 1024 / 1024)
}

/** A sampler refreshed every `intervalMs` (unref'd timer); `read()` is the latest sample. */
export function createMachineSampler(intervalMs = 3_000): { read(): MachineSample; dispose(): void } {
  let last = ticks()
  let sample: MachineSample = { cpuBusy: null, availableMemoryMb: availableMemoryMb() }
  let previousBusy: number | null = null
  const timer = setInterval(() => {
    const next = ticks()
    const busy = busyBetween(last, next)
    // The lower of the last two windows: one busy burst (a test suite starting) never holds a start.
    sample = { cpuBusy: busy === null ? null : previousBusy === null ? busy : Math.min(busy, previousBusy), availableMemoryMb: availableMemoryMb() }
    previousBusy = busy
    last = next
  }, intervalMs)
  timer.unref?.()
  return { read: () => sample, dispose: () => clearInterval(timer) }
}
