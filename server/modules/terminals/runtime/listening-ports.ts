/**
 * TCP listeners of this machine with the pid and working directory of their
 * process, read off the event loop and only on demand (the Resources panel
 * asks while it is open). Attribution to run worktrees is pure
 * (domain/run-ports.ts `attributeListeners`).
 *
 * - macOS: one `lsof -iTCP -sTCP:LISTEN` call for pid/command/address, then one
 *   `lsof -d cwd` call for the working directories of those pids only.
 * - Linux: `/proc/net/tcp{,6}` LISTEN rows, socket inode → pid through
 *   `/proc/<pid>/fd`, `/proc/<pid>/cwd` and `/proc/<pid>/comm`.
 * - Windows: not supported yet (`supported: false`).
 *
 * Scans are shared: concurrent callers join the in-flight scan and a result
 * younger than the TTL is reused. A dev server announcing its URL invalidates
 * the cache (`noteAdvertisedUrl`) so the next read sees its port at once.
 */
import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { promisify } from 'node:util'
import { parseLsofCwds, parseLsofListeners, parseProcNetTcp, type Listener } from '../domain/run-ports'

const execFileAsync = promisify(execFile)
const LSOF = '/usr/sbin/lsof'
const COMMAND_TIMEOUT_MS = 5_000
// -b: never block on stat() of an unreachable network mount; -w: hide the resulting warnings.
const LSOF_NONBLOCKING = ['-b', '-w']

export interface ListenerScan {
  supported: boolean
  listeners: Listener[]
  scannedAt: number
}

export type ListenerReader = () => Promise<ListenerScan>

async function lsof(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(LSOF, [...LSOF_NONBLOCKING, ...args], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
    return stdout
  } catch (err) {
    // lsof exits 1 when one of the pids vanished or nothing matched: its stdout is still valid.
    const stdout = (err as { stdout?: unknown }).stdout
    if (typeof stdout === 'string') return stdout
    throw err
  }
}

export async function readDarwinListeners(): Promise<Listener[]> {
  const listeners = parseLsofListeners(await lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']))
  const pids = [...new Set(listeners.map((l) => l.pid).filter((pid): pid is number => pid !== null))]
  if (pids.length === 0) return listeners
  let cwds = new Map<number, string>()
  try { cwds = parseLsofCwds(await lsof(['-a', '-d', 'cwd', '-p', pids.join(','), '-F', 'pn'])) } catch { /* attribution falls back to command lines */ }
  return listeners.map((l) => ({ ...l, cwd: l.pid !== null ? cwds.get(l.pid) ?? null : null }))
}

export async function readLinuxListeners(procRoot = '/proc'): Promise<Listener[]> {
  const rows = [
    ...parseProcNetTcp(await readFile(`${procRoot}/net/tcp`, 'utf8').catch(() => ''), 4),
    ...parseProcNetTcp(await readFile(`${procRoot}/net/tcp6`, 'utf8').catch(() => ''), 6),
  ]
  if (rows.length === 0) return []
  const wanted = new Set(rows.map((r) => r.inode).filter((inode) => inode !== '0'))
  const owners = new Map<string, number>()
  const pids = (await readdir(procRoot).catch(() => [] as string[])).filter((name) => /^\d+$/.test(name))
  // Bounded fan-out: each pid is one readdir plus a readlink per fd.
  for (let i = 0; i < pids.length && owners.size < wanted.size; i += 64) {
    await Promise.all(pids.slice(i, i + 64).map(async (pid) => {
      const fds = await readdir(`${procRoot}/${pid}/fd`).catch(() => [] as string[])
      for (const fd of fds) {
        const target = await readlink(`${procRoot}/${pid}/fd/${fd}`).catch(() => '')
        const match = /^socket:\[(\d+)\]$/.exec(target)
        if (match && wanted.has(match[1]) && !owners.has(match[1])) owners.set(match[1], Number(pid))
      }
    }))
  }
  const meta = new Map<number, { command: string | null; cwd: string | null }>()
  await Promise.all([...new Set(owners.values())].map(async (pid) => {
    const [comm, cwd] = await Promise.all([
      readFile(`${procRoot}/${pid}/comm`, 'utf8').then((v) => v.trim() || null).catch(() => null),
      readlink(`${procRoot}/${pid}/cwd`).catch(() => null),
    ])
    meta.set(pid, { command: comm, cwd })
  }))
  const seen = new Set<string>()
  const out: Listener[] = []
  for (const row of rows) {
    const pid = owners.get(row.inode) ?? null
    const key = `${pid}:${row.host}:${row.port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ port: row.port, host: row.host, pid, command: pid !== null ? meta.get(pid)?.command ?? null : null, cwd: pid !== null ? meta.get(pid)?.cwd ?? null : null })
  }
  return out
}

/** Platform reader: never throws; an unreadable table is an empty, unsupported scan. */
export function createListenerReader(options: {
  platform?: NodeJS.Platform
  readDarwin?: () => Promise<Listener[]>
  readLinux?: () => Promise<Listener[]>
  now?: () => number
  ttlMs?: number
} = {}) {
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 3_000
  let cached: ListenerScan | null = null
  let inFlight: Promise<ListenerScan> | null = null
  let generation = 0

  const scan = async (): Promise<ListenerScan> => {
    const read = platform === 'darwin' ? options.readDarwin ?? readDarwinListeners
      : platform === 'linux' ? options.readLinux ?? (() => readLinuxListeners())
        : null
    if (!read) return { supported: false, listeners: [], scannedAt: now() }
    try {
      return { supported: true, listeners: await read(), scannedAt: now() }
    } catch {
      return { supported: false, listeners: [], scannedAt: now() }
    }
  }

  return {
    read(): Promise<ListenerScan> {
      if (cached && now() - cached.scannedAt < ttlMs) return Promise.resolve(cached)
      if (inFlight) return inFlight
      const started = generation
      inFlight = scan().then((result) => {
        // A scan that raced an invalidation is returned but not cached.
        if (started === generation) cached = result
        return result
      }).finally(() => { inFlight = null })
      return inFlight
    },
    /** Forget the cached scan: the next read rescans. */
    invalidate(): void {
      generation++
      cached = null
    },
  }
}

/** The app-wide reader behind `GET /api/resources/ports`. */
export const listeningPorts = createListenerReader()

/** A process announced a URL: its port may be new, so the next read rescans. */
export function noteAdvertisedUrl(): void {
  listeningPorts.invalidate()
}
