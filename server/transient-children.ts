import treeKill from 'tree-kill'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import readline from 'readline'

/**
 * Registry of fire-and-forget child processes that are NOT owned by a long-lived
 * manager (QueueManager / ChatManager / SetupManager track their own). The Quick
 * spec-generation spawn in particular keeps only a closure handle + a watchdog,
 * so `ProjectRegistry.removeProject()` / `shutdown()` could not terminate it —
 * it survived project removal (burning AI-CLI spend) until the watchdog fired.
 *
 * Children registered here are tree-killed when their project is removed or the
 * app shuts down. Self-cleaning: each child is auto-unregistered on `close`.
 */
const byProject = new Map<string, Set<ChildProcess>>()

export type BackgroundProcessStatus = 'starting' | 'running' | 'exited' | 'killed' | 'failed'

export interface BackgroundProcess {
  pid: number
  command: string
  cwd: string
  startedAt: number
  status: BackgroundProcessStatus
  chatId: string
  projectId: string
  exitCode?: number | null
  signal?: string | null
}

export interface BackgroundProcessOutputEvent {
  pid: number
  chatId: string
  projectId: string
  source: 'stdout' | 'stderr'
  line: string
}

interface BackgroundRecord {
  child: ChildProcess
  process: BackgroundProcess
  hooks: BackgroundProcessHooks
  killTimer?: ReturnType<typeof setTimeout>
}

export interface BackgroundProcessHooks {
  onStarted?: (process: BackgroundProcess) => void
  onOutput?: (event: BackgroundProcessOutputEvent) => void
  onExited?: (process: BackgroundProcess) => void
}

const backgroundByPid = new Map<number, BackgroundRecord>()
const backgroundTerminal = new Set<BackgroundProcessStatus>(['exited', 'killed', 'failed'])

function treeKillSafe(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try { treeKill(pid, signal, () => undefined) } catch { /* best-effort */ }
}

function cloneProcess(process: BackgroundProcess): BackgroundProcess {
  return { ...process }
}

/** Track a child under a projectId; auto-removes itself on close. */
export function trackTransientChild(projectId: string, child: ChildProcess): void {
  let set = byProject.get(projectId)
  if (!set) {
    set = new Set()
    byProject.set(projectId, set)
  }
  set.add(child)
  const drop = (): void => {
    const s = byProject.get(projectId)
    if (s) {
      s.delete(child)
      if (s.size === 0) byProject.delete(projectId)
    }
  }
  child.once('close', drop)
  child.once('error', drop)
}

/** SIGTERM the whole subtree of every tracked child for a project, then forget. */
export function killTransientChildren(projectId: string): void {
  const set = byProject.get(projectId)
  if (set) for (const child of set) {
    if (child.pid) {
      treeKillSafe(child.pid, 'SIGTERM')
    }
  }
  byProject.delete(projectId)

  for (const [pid, record] of [...backgroundByPid]) {
    if (record.process.projectId !== projectId) continue
    markTerminal(record, 'killed', null, 'SIGTERM')
    treeKillSafe(pid, 'SIGTERM')
    backgroundByPid.delete(pid)
  }
}

export function startBackgroundProcess(
  command: string,
  cwd: string,
  chatId: string,
  projectId: string,
  hooks?: BackgroundProcessHooks,
): BackgroundProcess {
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!child.pid) {
    throw new Error('background process failed to start: missing pid')
  }

  const process: BackgroundProcess = {
    pid: child.pid,
    command,
    cwd,
    startedAt: Date.now(),
    status: 'running',
    chatId,
    projectId,
  }
  const record: BackgroundRecord = { child, process, hooks: hooks ?? {} }
  backgroundByPid.set(child.pid, record)
  trackTransientChild(projectId, child)

  attachOutput(child, 'stdout', record)
  attachOutput(child, 'stderr', record)

  child.once('error', () => {
    markTerminal(record, 'failed', null, null)
    backgroundByPid.delete(process.pid)
  })
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    const status: BackgroundProcessStatus = process.status === 'killed' ? 'killed' : code === 0 ? 'exited' : 'failed'
    markTerminal(record, status, code, signal)
    backgroundByPid.delete(process.pid)
  })

  record.hooks.onStarted?.(cloneProcess(process))
  return cloneProcess(process)
}

function attachOutput(
  child: { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream },
  source: 'stdout' | 'stderr',
  record: BackgroundRecord,
): void {
  const stream = source === 'stdout' ? child.stdout : child.stderr
  const rl = readline.createInterface({ input: stream })
  rl.on('line', (line) => {
    record.hooks.onOutput?.({
      pid: record.process.pid,
      chatId: record.process.chatId,
      projectId: record.process.projectId,
      source,
      line,
    })
  })
}

function markTerminal(
  record: BackgroundRecord,
  status: BackgroundProcessStatus,
  exitCode: number | null,
  signal: NodeJS.Signals | string | null,
): void {
  if (record.killTimer) clearTimeout(record.killTimer)
  record.process.status = status
  record.process.exitCode = exitCode
  record.process.signal = signal
  record.hooks.onExited?.(cloneProcess(record.process))
}

export function getBackgroundProcess(pid: number): BackgroundProcess | null {
  const record = backgroundByPid.get(pid)
  return record ? cloneProcess(record.process) : null
}

export function listBackgroundProcesses(filter: { projectId?: string; chatId?: string } = {}): BackgroundProcess[] {
  const processes: BackgroundProcess[] = []
  for (const record of backgroundByPid.values()) {
    const process = record.process
    if (filter.projectId && process.projectId !== filter.projectId) continue
    if (filter.chatId && process.chatId !== filter.chatId) continue
    if (backgroundTerminal.has(process.status)) continue
    processes.push(cloneProcess(process))
  }
  return processes
}

export function killBackgroundProcess(
  pid: number,
): void {
  const record = backgroundByPid.get(pid)
  if (!record) return
  record.process.status = 'killed'
  treeKillSafe(pid, 'SIGTERM')
  record.killTimer = setTimeout(() => {
    if (backgroundByPid.has(pid)) treeKillSafe(pid, 'SIGKILL')
  }, 2500)
}

export function killOwnedBackgroundProcess(
  pid: number,
  owner: { projectId: string; chatId: string },
): boolean {
  const record = backgroundByPid.get(pid)
  if (!record) return false
  if (record.process.projectId !== owner.projectId) return false
  if (record.process.chatId !== owner.chatId) return false
  killBackgroundProcess(pid)
  return true
}
