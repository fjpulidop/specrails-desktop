/**
 * Process ownership of Core children (`runtime run|resume` and the session host).
 *
 * They are spawned in their OWN process group (`detached`: POSIX `setsid`, Windows
 * `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS`). A signal aimed at Desktop's group
 * (Ctrl-C on `npm run dev`, a dev-server or tsx-watch restart, a logout) then reaches
 * Desktop only. Core treats SIGINT/SIGTERM as "cancel the run", so before this a
 * signal meant for Desktop cancelled the run for good and Resume ended it "stopped".
 * Desktop stays the only one that stops them, deliberately: Stop/cancel and Desktop's
 * own shutdown still tree-kill the child (ppid walk, `taskkill /T` on Windows), which
 * the group change does not affect.
 *
 * A child that outlives Desktop (a hard crash: nothing ran the shutdown) is recorded in
 * `<data home>/.specrails/core-children/<pid>.json` while it runs. The next Desktop on
 * that data home reaps it at boot, before restart recovery resumes anything: its stdio
 * pipes died with the old Desktop, so it cannot be re-adopted, and a live orphan would
 * keep renewing the run's lease. Once it is gone, the existing restart path resumes the
 * run from the step it cut off. Only one Desktop holds a data home (the data-home lock),
 * so a record owned by another pid is an orphan by construction; the pid must still run
 * the recorded Core command line, so a reused pid is never killed.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'

export type CoreChildKind = 'runtime' | 'session-host'

/** Spawn options every Core runtime/session child gets: its own process group. */
export function coreChildSpawnOptions(): { detached: true } {
  return { detached: true }
}

export interface CoreChildRecord {
  schemaVersion: 1
  pid: number
  /** The Desktop server process that spawned and owns it. */
  ownerPid: number
  kind: CoreChildKind
  /** Text the child's command line must contain to still be this child (the Core CLI and its command). */
  marker: string
  startedAt: string
}

let registryDirectory: string | null = null

/** Where records live; set once at boot (null disables tracking, e.g. in unit tests that do not opt in). */
export function configureCoreChildRegistry(directory: string | null): void {
  registryDirectory = directory
}

export function coreChildRegistryDirectory(): string | null {
  return registryDirectory
}

const recordFile = (directory: string, pid: number): string => path.join(directory, `${pid}.json`)

/** Record a spawned Core child until it exits. Best effort: tracking never fails a run. */
export function trackCoreChild(child: ChildProcess, kind: CoreChildKind, marker: string): void {
  const directory = registryDirectory
  const pid = child.pid
  if (!directory || !pid) return
  const file = recordFile(directory, pid)
  const record: CoreChildRecord = { schemaVersion: 1, pid, ownerPid: process.pid, kind, marker, startedAt: new Date().toISOString() }
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 })
  } catch { return }
  const forget = (): void => { try { fs.rmSync(file, { force: true }) } catch { /* the boot sweep drops it */ } }
  child.once('exit', forget)
  child.once('error', forget)
}

/** The command line of a live pid, or null when it is gone. */
export type CommandLineReader = (pid: number) => string | null
/** Kill a pid and everything it started; synchronous so boot can finish it before recovery. */
export type GroupKiller = (pid: number) => void

export function readCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      return out.trim() || null
    }
    // `-ww`: never truncate; a long Core command line must still show its marker.
    const out = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim() || null
  } catch {
    return null
  }
}

/** Descendants of `root` from one `ps` table read (POSIX), deepest last. */
function posixDescendants(root: number): number[] {
  let table = ''
  try { table = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return [] }
  const children = new Map<number, number[]>()
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const out: number[] = []
  const pending = [root]
  while (pending.length) {
    for (const child of children.get(pending.shift()!) ?? []) { out.push(child); pending.push(child) }
  }
  return out
}

/** SIGKILL the orphan, its process group and its descendants (POSIX); `taskkill /T /F` (Windows). */
export function killCoreChildTree(pid: number): void {
  if (process.platform === 'win32') {
    /* c8 ignore next 5 -- Windows-only branch; coverage runs on Linux/macOS */
    try {
      const systemRoot = (process.env.SystemRoot || process.env.windir || 'C:\\Windows').replace(/[\\/]$/, '')
      execFileSync(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { timeout: 15_000, windowsHide: true, stdio: 'ignore' })
    } catch { /* already gone */ }
    return
  }
  // Read the tree before the first kill: once the root dies its children are re-parented.
  const descendants = posixDescendants(pid)
  try { process.kill(-pid, 'SIGKILL') } catch { /* not a group leader, or already gone */ }
  for (const target of [pid, ...descendants]) { try { process.kill(target, 'SIGKILL') } catch { /* already gone */ } }
}

export interface ReapedCoreChild {
  pid: number
  kind: CoreChildKind
  ownerPid: number
}

/**
 * Boot sweep: kill every recorded Core child whose owner is not this process and that
 * still runs its recorded command line; drop every record that no longer names one.
 * Never throws.
 */
export function reapOrphanedCoreChildren(options: { directory?: string | null; readCommand?: CommandLineReader; kill?: GroupKiller; log?: (line: string) => void } = {}): ReapedCoreChild[] {
  const directory = options.directory === undefined ? registryDirectory : options.directory
  if (!directory) return []
  const readCommand = options.readCommand ?? readCommandLine
  const kill = options.kill ?? killCoreChildTree
  let names: string[]
  try { names = fs.readdirSync(directory).filter((name) => /^\d+\.json$/.test(name)) } catch { return [] }
  const reaped: ReapedCoreChild[] = []
  for (const name of names) {
    const file = path.join(directory, name)
    let record: CoreChildRecord | null = null
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CoreChildRecord>
      if (parsed.schemaVersion === 1 && Number.isSafeInteger(parsed.pid) && parsed.pid! > 0 && Number.isSafeInteger(parsed.ownerPid)
        && typeof parsed.marker === 'string' && parsed.marker && (parsed.kind === 'runtime' || parsed.kind === 'session-host')) record = parsed as CoreChildRecord
    } catch { record = null }
    if (record && record.ownerPid === process.pid) continue
    if (record) {
      const command = readCommand(record.pid)
      if (command && command.includes(record.marker)) {
        try {
          kill(record.pid)
          reaped.push({ pid: record.pid, kind: record.kind, ownerPid: record.ownerPid })
          options.log?.(`[core-children] reaped orphaned Core ${record.kind} pid ${record.pid} (owner ${record.ownerPid} is gone)`)
        } catch { /* leave the record for the next boot */ continue }
      }
    }
    try { fs.rmSync(file, { force: true }) } catch { /* next boot */ }
  }
  return reaped
}
