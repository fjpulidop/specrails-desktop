import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { applyCpuDeltas, parsePsOutput, parseWindowsProcessJson, type ProcessSample } from '../domain/mission-resources'

const execFileAsync = promisify(execFile)

export type ProcessTableReader = () => Promise<ProcessSample[] | null>
export type DiskUsageReader = (dir: string) => Promise<number>

const WINDOWS_SCRIPT = [
  '$ProgressPreference = "SilentlyContinue"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress',
].join('; ')

/** One `ps` call for the whole table; null if `ps` is unavailable. */
export const readPosixProcessTable: ProcessTableReader = async () => {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 })
    return parsePsOutput(stdout)
  } catch {
    return null
  }
}

/**
 * Windows process table through one PowerShell/CIM query. Windows reports cumulative CPU time, so the reader keeps
 * the previous sample to derive a percent of one core; the first reading therefore shows 0% CPU. Scans are
 * shared: concurrent callers join the in-flight query and a result younger than `ttlMs` is reused, because a CIM
 * scan costs a few hundred milliseconds. State is per reader, so each project registration owns its own.
 */
export function createWindowsProcessTableReader(
  run: () => Promise<string> = async () => {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
      { timeout: 15_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    return stdout
  },
  now: () => number = Date.now,
  ttlMs = 500,
): ProcessTableReader {
  let previous = new Map<number, number>()
  let previousAt = 0
  let cached: { at: number; samples: ProcessSample[] } | null = null
  let inFlight: Promise<ProcessSample[] | null> | null = null

  return () => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.samples)
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const rows = parseWindowsProcessJson(await run())
        if (rows.length === 0) return null
        const at = now()
        const { samples, next } = applyCpuDeltas(previous, rows, previousAt ? at - previousAt : 0)
        previous = next
        previousAt = at
        cached = { at, samples }
        return samples
      } catch {
        return null
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }
}

/** Platform-appropriate process table reader; each caller gets its own so Windows CPU deltas stay isolated. */
export function createProcessTableReader(platform: NodeJS.Platform = process.platform): ProcessTableReader {
  return platform === 'win32' ? createWindowsProcessTableReader() : readPosixProcessTable
}

/** Shares one table between callers: a result younger than `ttlMs` is reused and concurrent calls join the
 * in-flight read. Used where one request reads the table (the app-wide Resources view). */
export function cacheProcessTableReader(read: ProcessTableReader, now: () => number = Date.now, ttlMs = 500): ProcessTableReader {
  let cached: { at: number; samples: ProcessSample[] | null } | null = null
  let inFlight: Promise<ProcessSample[] | null> | null = null
  return () => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.samples)
    if (inFlight) return inFlight
    inFlight = read().then((samples) => { cached = { at: now(), samples }; return samples }).finally(() => { inFlight = null })
    return inFlight
  }
}

/** Total size of regular files under `dir`, without following symlinks. Portable, used where `du` is absent. */
export async function walkDiskUsage(dir: string): Promise<number> {
  let total = 0
  const pending = [dir]
  while (pending.length) {
    const current = pending.pop()!
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch (err) {
      if (current === dir) throw err
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { pending.push(full); continue }
      if (!entry.isFile()) continue
      try { total += (await lstat(full)).size } catch { /* file vanished mid-scan */ }
    }
  }
  return total
}

/** Disk bytes under `dir`: `du -sk` where available (fast), an async Node walk on Windows. */
export const readDiskUsage: DiskUsageReader = async (dir) => {
  if (process.platform === 'win32') return walkDiskUsage(dir)
  const { stdout } = await execFileAsync('du', ['-sk', dir], { timeout: 60_000, maxBuffer: 1024 * 1024 })
  const kib = Number(stdout.split(/\s+/)[0])
  if (!Number.isFinite(kib)) throw new Error('unreadable du output')
  return kib * 1024
}

export type DiskScanState =
  | { status: 'not-scanned' }
  | { status: 'scanning'; startedAt: number }
  | { status: 'done'; bytes: number; scannedAt: number }
  | { status: 'failed'; error: string; scannedAt: number }

/** Per-project, in-memory cache of worktree scans; keyed by chat, never shared across projects. */
export function createDiskScanner(read: DiskUsageReader = readDiskUsage, now: () => number = Date.now) {
  const states = new Map<string, DiskScanState>()
  return {
    get: (key: string): DiskScanState => states.get(key) ?? { status: 'not-scanned' },
    /** Starts a scan unless one is running; returns immediately with the current state. */
    start(key: string, dir: string): DiskScanState {
      const current = states.get(key)
      if (current?.status === 'scanning') return current
      const scanning: DiskScanState = { status: 'scanning', startedAt: now() }
      states.set(key, scanning)
      void read(dir).then(
        (bytes) => { states.set(key, { status: 'done', bytes, scannedAt: now() }) },
        (err) => { states.set(key, { status: 'failed', error: err instanceof Error ? err.message : 'scan failed', scannedAt: now() }) },
      )
      return scanning
    },
  }
}
