import treeKill from 'tree-kill'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import readline from 'readline'
import { assertProcessAdmission } from './process-admission'

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

export interface BackgroundProcessLogLine {
  at: number
  source: 'stdout' | 'stderr'
  line: string
}

export interface BackgroundProcessLogSnapshot {
  process: BackgroundProcess
  lines: BackgroundProcessLogLine[]
  truncated: boolean
  droppedLines: number
  maxLines: number
  maxLineChars: number
  retentionMs: number
}

interface BackgroundRecord {
  child: ChildProcess
  process: BackgroundProcess
  hooks: BackgroundProcessHooks
  killTimer?: ReturnType<typeof setTimeout>
  terminalNotified?: boolean
  retained?: boolean
  outputLines: BackgroundProcessLogLine[]
  droppedOutputLines: number
}

interface FinishedBackgroundRecord {
  process: BackgroundProcess
  outputLines: BackgroundProcessLogLine[]
  droppedOutputLines: number
  cleanupTimer: ReturnType<typeof setTimeout>
}

export interface BackgroundProcessHooks {
  onStarted?: (process: BackgroundProcess) => void
  onOutput?: (event: BackgroundProcessOutputEvent) => void
  onExited?: (process: BackgroundProcess) => void
}

const backgroundByPid = new Map<number, BackgroundRecord>()
const finishedBackgroundByPid = new Map<number, FinishedBackgroundRecord>()
const backgroundTerminal = new Set<BackgroundProcessStatus>(['exited', 'killed', 'failed'])
const BACKGROUND_KILL_GRACE_MS = 2500
const BACKGROUND_OUTPUT_MAX_LINE_CHARS = 1000
const BACKGROUND_OUTPUT_MAX_LINES_PER_SECOND = 20
const BACKGROUND_LOG_MAX_LINES = 500
export const BACKGROUND_LOG_RETENTION_MS = 10 * 60 * 1000

function treeKillSafe(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try { treeKill(pid, signal, () => undefined) } catch { /* best-effort */ }
}

function treeKillWithEscalation(pid: number, isStillAlive: () => boolean = () => backgroundByPid.has(pid)): ReturnType<typeof setTimeout> {
  treeKillSafe(pid, 'SIGTERM')
  const timer = setTimeout(() => {
    if (isStillAlive()) treeKillSafe(pid, 'SIGKILL')
  }, BACKGROUND_KILL_GRACE_MS)
  timer.unref?.()
  return timer
}

function cloneProcess(process: BackgroundProcess): BackgroundProcess {
  return { ...process }
}

function cloneLogLine(line: BackgroundProcessLogLine): BackgroundProcessLogLine {
  return { ...line }
}

/** Track a child under a projectId; auto-removes itself on close. */
export function trackTransientChild(projectId: string, child: ChildProcess): void {
  try {
    assertProcessAdmission(projectId)
  } catch (err) {
    // A continuation may have spawned immediately before observing the closed
    // project epoch. Never leave that child unowned simply because registration
    // lost the teardown race.
    if (child.pid) treeKillSafe(child.pid, 'SIGTERM')
    throw err
  }
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

/** SIGTERM the whole subtree of every tracked child for a project, then escalate. */
export function killTransientChildren(projectId: string): void {
  const set = byProject.get(projectId)
  if (set) for (const child of set) {
    if (child.pid) {
      if (backgroundByPid.has(child.pid)) continue
      let alive = true
      const timer = treeKillWithEscalation(child.pid, () => alive)
      const clear = (): void => { alive = false; clearTimeout(timer) }
      child.once('close', clear)
      child.once('error', clear)
    }
  }
  byProject.delete(projectId)

  for (const [pid, record] of [...backgroundByPid]) {
    if (record.process.projectId !== projectId) continue
    markTerminal(record, 'killed', null, 'SIGTERM')
    terminateBackgroundRecord(record)
  }
}

export function startBackgroundProcess(
  command: string,
  cwd: string,
  chatId: string,
  projectId: string,
  hooks?: BackgroundProcessHooks,
): BackgroundProcess {
  assertProcessAdmission(projectId)
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
  const staleFinished = finishedBackgroundByPid.get(child.pid)
  if (staleFinished) {
    clearTimeout(staleFinished.cleanupTimer)
    finishedBackgroundByPid.delete(child.pid)
  }

  const record: BackgroundRecord = {
    child,
    process,
    hooks: hooks ?? {},
    outputLines: [],
    droppedOutputLines: 0,
  }
  backgroundByPid.set(child.pid, record)
  trackTransientChild(projectId, child)

  attachOutput(child, 'stdout', record)
  attachOutput(child, 'stderr', record)

  child.once('error', () => {
    markTerminal(record, process.status === 'killed' ? 'killed' : 'failed', null, null)
    backgroundByPid.delete(process.pid)
    retainFinishedRecord(record)
  })
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    const status: BackgroundProcessStatus = process.status === 'killed' ? 'killed' : code === 0 ? 'exited' : 'failed'
    markTerminal(record, status, code, signal)
    backgroundByPid.delete(process.pid)
    retainFinishedRecord(record)
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
  let windowStart = Date.now()
  let emittedInWindow = 0
  rl.on('line', (line) => {
    const clipped = line.length > BACKGROUND_OUTPUT_MAX_LINE_CHARS ? `${line.slice(0, BACKGROUND_OUTPUT_MAX_LINE_CHARS)}...` : line
    appendOutputLine(record, source, clipped)
    if (!record.hooks.onOutput) return
    const now = Date.now()
    if (now - windowStart >= 1000) {
      windowStart = now
      emittedInWindow = 0
    }
    if (emittedInWindow >= BACKGROUND_OUTPUT_MAX_LINES_PER_SECOND) return
    emittedInWindow += 1
    record.hooks.onOutput?.({
      pid: record.process.pid,
      chatId: record.process.chatId,
      projectId: record.process.projectId,
      source,
      line: clipped,
    })
  })
}

function appendOutputLine(record: BackgroundRecord, source: 'stdout' | 'stderr', line: string): void {
  record.outputLines.push({ at: Date.now(), source, line })
  if (record.outputLines.length > BACKGROUND_LOG_MAX_LINES) {
    const overflow = record.outputLines.length - BACKGROUND_LOG_MAX_LINES
    record.outputLines.splice(0, overflow)
    record.droppedOutputLines += overflow
  }
}

function retainFinishedRecord(record: BackgroundRecord): void {
  if (record.retained) {
    const existing = finishedBackgroundByPid.get(record.process.pid)
    if (existing) {
      existing.process = cloneProcess(record.process)
      existing.outputLines = record.outputLines.map(cloneLogLine)
      existing.droppedOutputLines = record.droppedOutputLines
    }
    return
  }
  record.retained = true
  const previous = finishedBackgroundByPid.get(record.process.pid)
  if (previous) clearTimeout(previous.cleanupTimer)
  const cleanupTimer = setTimeout(() => {
    finishedBackgroundByPid.delete(record.process.pid)
  }, BACKGROUND_LOG_RETENTION_MS)
  cleanupTimer.unref?.()
  finishedBackgroundByPid.set(record.process.pid, {
    process: cloneProcess(record.process),
    outputLines: record.outputLines.map(cloneLogLine),
    droppedOutputLines: record.droppedOutputLines,
    cleanupTimer,
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
  if (record.terminalNotified) return
  record.terminalNotified = true
  record.hooks.onExited?.(cloneProcess(record.process))
}

export function getBackgroundProcess(pid: number): BackgroundProcess | null {
  const record = backgroundByPid.get(pid)
  if (record) return cloneProcess(record.process)
  const finished = finishedBackgroundByPid.get(pid)
  return finished ? cloneProcess(finished.process) : null
}

export function getBackgroundProcessLogs(
  pid: number,
  filter: { projectId?: string; chatId?: string; limit?: number } = {},
): BackgroundProcessLogSnapshot | null {
  const live = backgroundByPid.get(pid)
  const record = live
    ? {
        process: live.process,
        outputLines: live.outputLines,
        droppedOutputLines: live.droppedOutputLines,
      }
    : finishedBackgroundByPid.get(pid)
  if (!record) return null
  if (filter.projectId && record.process.projectId !== filter.projectId) return null
  if (filter.chatId && record.process.chatId !== filter.chatId) return null

  const limit = typeof filter.limit === 'number' && Number.isFinite(filter.limit)
    ? Math.max(1, Math.min(BACKGROUND_LOG_MAX_LINES, Math.floor(filter.limit)))
    : BACKGROUND_LOG_MAX_LINES
  const start = Math.max(0, record.outputLines.length - limit)
  const lines = record.outputLines.slice(start).map(cloneLogLine)
  const droppedByLimit = record.outputLines.length - lines.length
  const droppedLines = record.droppedOutputLines + droppedByLimit
  return {
    process: cloneProcess(record.process),
    lines,
    truncated: droppedLines > 0,
    droppedLines,
    maxLines: BACKGROUND_LOG_MAX_LINES,
    maxLineChars: BACKGROUND_OUTPUT_MAX_LINE_CHARS,
    retentionMs: BACKGROUND_LOG_RETENTION_MS,
  }
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
  terminateBackgroundRecord(record)
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

function terminateBackgroundRecord(record: BackgroundRecord): void {
  if (record.killTimer) clearTimeout(record.killTimer)
  record.killTimer = treeKillWithEscalation(record.process.pid)
}

export function killBackgroundProcessesForChat(chatId: string, projectId?: string): number {
  let killed = 0
  for (const record of backgroundByPid.values()) {
    if (record.process.chatId !== chatId) continue
    if (projectId && record.process.projectId !== projectId) continue
    record.process.status = 'killed'
    markTerminal(record, 'killed', null, 'SIGTERM')
    terminateBackgroundRecord(record)
    killed += 1
  }
  return killed
}
