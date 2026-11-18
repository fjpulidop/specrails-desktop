// Pure rules for the ports a run worktree may use and for which run owns a
// listening port. No I/O: the runtime feeds lease tables, process tables and
// listener output in.
//
// Why: rails launched together each start their own dev server or e2e
// webServer. Without a port of their own they all reach for :3000 and the
// loser fails its checks with EADDRINUSE, which read as "tests failed".
// Each run worktree therefore leases a small block of ports, exported to
// every process of the run as PORT (unless already set) and
// SPECRAILS_RUN_PORT / SPECRAILS_RUN_PORT_RANGE_START / _END.

import { commandReferencesPath, type ProcessSample } from './mission-resources'

/** First port of the reserved area. Below every common OS ephemeral range
 *  (Linux 32768+, macOS/Windows 49152+) and clear of the usual dev ports. */
export const DEFAULT_RUN_PORT_BASE = 30100
/** Ports per run: the app, its HMR/websocket, an API, a preview, e2e, … */
export const DEFAULT_RUN_PORT_BLOCK_SIZE = 10
/** Blocks in the reserved area (30100–32099 by default). */
export const DEFAULT_RUN_PORT_BLOCKS = 200

export interface RunPortArea {
  base: number
  blockSize: number
  blocks: number
}

/** The reserved area, overridable for machines where it is taken
 *  (`SPECRAILS_RUN_PORT_BASE`, `SPECRAILS_RUN_PORT_BLOCK_SIZE`, `SPECRAILS_RUN_PORT_BLOCKS`). */
export function runPortArea(env: NodeJS.ProcessEnv = {}): RunPortArea {
  const int = (raw: string | undefined, fallback: number, min: number, max: number) => {
    const value = raw === undefined ? NaN : Number(raw)
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback
  }
  const base = int(env.SPECRAILS_RUN_PORT_BASE, DEFAULT_RUN_PORT_BASE, 1024, 65000)
  const blockSize = int(env.SPECRAILS_RUN_PORT_BLOCK_SIZE, DEFAULT_RUN_PORT_BLOCK_SIZE, 1, 100)
  const maxBlocks = Math.max(1, Math.floor((65535 - base + 1) / blockSize))
  const blocks = Math.min(int(env.SPECRAILS_RUN_PORT_BLOCKS, DEFAULT_RUN_PORT_BLOCKS, 1, 10_000), maxBlocks)
  return { base, blockSize, blocks }
}

export interface RunPortLease {
  /** Canonical run worktree path the block belongs to. */
  worktreePath: string
  block: number
  start: number
  end: number
  leasedAt: number
}

export function blockRange(area: RunPortArea, block: number): { start: number; end: number } {
  const start = area.base + block * area.blockSize
  return { start, end: start + area.blockSize - 1 }
}

/** FNV-1a: the same worktree prefers the same block on every machine start. */
function hash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Candidate blocks for a worktree, best first: its hashed home block, then
 * the next ones (wrapping). Blocks held by another lease are skipped; the
 * caller additionally skips blocks it finds bound by something else.
 */
export function candidateBlocks(area: RunPortArea, worktreePath: string, taken: ReadonlySet<number>): number[] {
  const first = hash(worktreePath) % area.blocks
  const out: number[] = []
  for (let i = 0; i < area.blocks; i++) {
    const block = (first + i) % area.blocks
    if (!taken.has(block)) out.push(block)
  }
  return out
}

/**
 * Env for every process of a run. An existing PORT is kept: a project that
 * pins its own port (project environment or the user's shell) chose it on
 * purpose; such scripts can still opt in through SPECRAILS_RUN_PORT.
 */
export function runPortEnv(lease: RunPortLease | null, env: NodeJS.ProcessEnv): Record<string, string> {
  if (!lease) return {}
  return {
    ...(env.PORT === undefined || env.PORT === '' ? { PORT: String(lease.start) } : {}),
    SPECRAILS_RUN_PORT: String(lease.start),
    SPECRAILS_RUN_PORT_RANGE_START: String(lease.start),
    SPECRAILS_RUN_PORT_RANGE_END: String(lease.end),
  }
}

/** Env keys this feature owns (frozen-host replay and tests). */
export const RUN_PORT_ENV_KEYS = ['SPECRAILS_RUN_PORT', 'SPECRAILS_RUN_PORT_RANGE_START', 'SPECRAILS_RUN_PORT_RANGE_END'] as const

/**
 * Whether `candidate` is a run worktree: `<specrailsHome>/.specrails/projects/<slug>/worktrees/<…>/<…>`,
 * the root every isolated rail, loop and Intent worktree is mounted under. Anything else (the
 * project checkout, a mission cwd) gets no lease.
 */
export function isRunWorktreePath(candidate: string, projectsRoot: string, windows = false): boolean {
  const norm = (value: string) => {
    const slashed = windows ? value.replace(/\\/g, '/') : value
    return (windows ? slashed.toLowerCase() : slashed).replace(/\/+$/, '')
  }
  const root = norm(projectsRoot)
  const value = norm(candidate)
  if (!root || !value.startsWith(`${root}/`)) return false
  const parts = value.slice(root.length + 1).split('/').filter(Boolean)
  return parts.length >= 4 && parts[1] === 'worktrees' && !parts.includes('..')
}

// ─── Listening ports ────────────────────────────────────────────────────────

export interface Listener {
  port: number
  /** Bound address as reported (`*`, `127.0.0.1`, `::1`, `[::]`, …). */
  host: string
  pid: number | null
  /** Short process name from the listener table. */
  command: string | null
  /** Process working directory, when the platform exposes it. */
  cwd: string | null
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -F pcn` (one field per line: p<pid>, c<command>,
 * f<fd>, n<address>). Unknown lines are ignored; one listener per (pid, host, port).
 */
export function parseLsofListeners(stdout: string): Listener[] {
  const out = new Map<string, Listener>()
  let pid: number | null = null
  let command: string | null = null
  for (const line of stdout.split('\n')) {
    const tag = line[0]
    const value = line.slice(1).trim()
    if (tag === 'p') { pid = Number.isInteger(Number(value)) ? Number(value) : null; command = null }
    else if (tag === 'c') command = value || null
    else if (tag === 'n') {
      const endpoint = parseEndpoint(value)
      if (!endpoint) continue
      const key = `${pid}:${endpoint.host}:${endpoint.port}`
      if (!out.has(key)) out.set(key, { ...endpoint, pid, command, cwd: null })
    }
  }
  return [...out.values()]
}

/** `host:port` as lsof prints it (`*:3000`, `127.0.0.1:5173`, `[::1]:8080`). */
function parseEndpoint(text: string): { host: string; port: number } | null {
  const colon = text.lastIndexOf(':')
  if (colon < 1) return null
  const port = Number(text.slice(colon + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: text.slice(0, colon), port }
}

/** `lsof -a -d cwd -p <pids> -F pn`: pid → working directory. */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const out = new Map<number, string>()
  let pid: number | null = null
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n' && pid !== null && Number.isInteger(pid)) out.set(pid, line.slice(1))
  }
  return out
}

/** LISTEN rows of `/proc/net/tcp` or `/proc/net/tcp6`: local port + socket inode. */
export function parseProcNetTcp(text: string, family: 4 | 6): Array<{ port: number; host: string; inode: string }> {
  const rows: Array<{ port: number; host: string; inode: string }> = []
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10 || fields[3] !== '0A') continue
    const [hexHost, hexPort] = fields[1].split(':')
    const port = parseInt(hexPort, 16)
    if (!Number.isInteger(port) || port < 1) continue
    rows.push({ port, host: procHost(hexHost, family), inode: fields[9] })
  }
  return rows
}

function procHost(hex: string, family: 4 | 6): string {
  if (family === 4) {
    if (hex === '00000000') return '*'
    const bytes = hex.match(/../g)?.map((b) => parseInt(b, 16)).reverse() ?? []
    return bytes.join('.')
  }
  if (/^0+$/.test(hex)) return '*'
  if (hex === '00000000000000000000000001000000') return '::1'
  return 'ipv6'
}

// ─── Attribution ────────────────────────────────────────────────────────────

/** How the owner was established: the process's own cwd, a command line that names the worktree, or neither. */
export type PortAttributionConfidence = 'cwd' | 'command' | 'none'

export interface RunPortOwner {
  worktreePath: string
  /** Assigned block of that worktree, when it holds one. */
  lease: RunPortLease | null
}

export interface AttributedListener extends Listener {
  owner: RunPortOwner | null
  confidence: PortAttributionConfidence
  /** The port lies in some run's leased block but its process belongs to another worktree or none. */
  squatting: boolean
}

function isAtOrBelow(candidate: string, root: string): boolean {
  const base = root.replace(/\/+$/, '')
  return candidate === base || candidate.startsWith(`${base}/`)
}

/**
 * Attribute each listener to a run worktree. A process whose cwd lies in the worktree is
 * `cwd`-certain; otherwise the process or one of its ancestors (up to 32 hops) naming the
 * worktree in its command line is `command`; anything else is `none`. The longest matching
 * worktree wins, so nested mounts resolve to the inner one. Only listeners owned by a run or
 * sitting inside a leased block are returned: other machine-wide listeners are not ours to show.
 */
export function attributeListeners(
  listeners: readonly Listener[],
  table: readonly ProcessSample[] | null,
  worktrees: readonly RunPortOwner[],
): AttributedListener[] {
  const ordered = [...worktrees].sort((a, b) => b.worktreePath.length - a.worktreePath.length)
  const byPid = new Map((table ?? []).map((sample) => [sample.pid, sample]))
  const byCwd = (cwd: string | null) => (cwd ? ordered.find((w) => isAtOrBelow(cwd, w.worktreePath)) ?? null : null)
  const byCommand = (pid: number | null) => {
    let current = pid !== null ? byPid.get(pid) : undefined
    for (let hops = 0; current && hops < 32; hops++) {
      const owner = ordered.find((w) => commandReferencesPath(current!.command, w.worktreePath))
      if (owner) return owner
      if (current.ppid === current.pid) break
      current = byPid.get(current.ppid)
    }
    return null
  }
  const inLease = (port: number) => ordered.find((w) => w.lease && port >= w.lease.start && port <= w.lease.end) ?? null
  const out: AttributedListener[] = []
  for (const listener of listeners) {
    const cwdOwner = byCwd(listener.cwd)
    const owner = cwdOwner ?? byCommand(listener.pid)
    const confidence: PortAttributionConfidence = cwdOwner ? 'cwd' : owner ? 'command' : 'none'
    const leaseHolder = inLease(listener.port)
    const squatting = Boolean(leaseHolder && leaseHolder !== owner)
    if (!owner && !squatting) continue
    out.push({ ...listener, owner: owner ?? leaseHolder, confidence, squatting })
  }
  return out.sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0))
}

// ─── Port conflicts in run output ───────────────────────────────────────────

const CONFLICT_HINT = /EADDRINUSE|address already in use|port \d{2,5} is (?:already )?in use|already in use.*port/i
const PORT_PATTERNS = [
  /EADDRINUSE[^\n]*?(?::|port\s+)(\d{2,5})\b/i,
  /address already in use[^\n]*?(?::|port\s+)(\d{2,5})\b/i,
  /port\s+(\d{2,5})\s+is\s+(?:already\s+)?in\s+use/i,
  /(?::|port\s+)(\d{2,5})\b[^\n]*?address already in use/i,
]

export interface PortConflict {
  /** The contested port when the message names one. */
  port: number | null
  /** The output line, bounded. */
  line: string
}

/**
 * A port-collision signature in one output line: Node's `EADDRINUSE`, the
 * POSIX "Address already in use" (Python, Go, Ruby, Java), and dev servers'
 * "Port 3000 is in use". A cheap substring gate runs before any regex.
 */
export function detectPortConflict(line: string): PortConflict | null {
  if (!line || line.length > 64 * 1024) return null
  const lower = line.toLowerCase()
  if (!lower.includes('eaddrinuse') && !lower.includes('in use')) return null
  if (!CONFLICT_HINT.test(line)) return null
  let port: number | null = null
  for (const pattern of PORT_PATTERNS) {
    const match = pattern.exec(line)
    const value = match ? Number(match[1]) : NaN
    if (Number.isInteger(value) && value >= 1 && value <= 65535) { port = value; break }
  }
  const flat = line.replace(/\s+/g, ' ').trim()
  return { port, line: flat.length > 280 ? `${flat.slice(0, 279)}…` : flat }
}
