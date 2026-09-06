import { treeKillSafe as treeKill } from './util/win-spawn'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { StringDecoder } from 'string_decoder'
import { assertProcessAdmission } from './process-admission'
import { createBackgroundProcessControl, type BackgroundProcessControl } from './background-process-control'
import { windowsSpawnEnv } from './util/win-spawn'
import { BackgroundProcessStore, BACKGROUND_HISTORY_MAX_LINES, BACKGROUND_HISTORY_RETENTION_MS } from './background-process-store'
import { spawnWindowsBackgroundBootstrap, type WindowsBackgroundBootstrap } from './background-windows-bootstrap'

/** Fire-and-forget children not already owned by a long-lived provider manager. */
const byProject = new Map<string, Set<ChildProcess>>()

export type BackgroundProcessStatus = 'starting' | 'running' | 'stopping' | 'exited' | 'killed' | 'failed' | 'interrupted'
export interface BackgroundProcess {
  processId: string
  pid: number
  command: string
  cwd: string
  startedAt: number
  status: BackgroundProcessStatus
  chatId: string
  projectId: string
  repositoryId?: string
  repositoryName?: string
  stopRequestedAt?: number
  endedAt?: number
  error?: string
  persistenceError?: string
  recoveredAt?: number
  exitCode?: number | null
  signal?: string | null
}
export interface BackgroundProcessLogLine {
  sequence: number
  at: number
  source: 'stdout' | 'stderr'
  line: string
  partial?: boolean
}
export interface BackgroundProcessOutputEvent extends BackgroundProcessLogLine {
  processId: string
  pid: number
  chatId: string
  projectId: string
}
export interface BackgroundProcessLogSnapshot {
  process: BackgroundProcess
  lines: BackgroundProcessLogLine[]
  /** Latest allocated line identity; partial updates retain the same identity. */
  nextSequence: number
  truncated: boolean
  droppedLines: number
  maxLines: number
  maxLineChars: number
  retentionMs: number
}
export interface BackgroundProcessHooks {
  onStarted?: (process: BackgroundProcess) => void
  onUpdated?: (process: BackgroundProcess) => void
  onOutput?: (event: BackgroundProcessOutputEvent) => void
  onExited?: (process: BackgroundProcess) => void
}
interface BackgroundRecord {
  child: ChildProcess
  control: BackgroundProcessControl
  process: BackgroundProcess
  hooks: BackgroundProcessHooks
  killTimer?: ReturnType<typeof setTimeout>
  probeTimer?: ReturnType<typeof setTimeout>
  probing?: Promise<void>
  stoppingAttempt: number
  stopAttemptActive: boolean
  forceKillAt?: number
  rootClosed: boolean
  rootExited: boolean
  userStopRequested: boolean
  groupGone: boolean
  exitCode: number | null
  exitSignal: string | null
  outputLines: BackgroundProcessLogLine[]
  outputBySequence: Map<number, BackgroundProcessLogLine>
  nextSequence: number
  droppedOutputLines: number
  clippedOutput: boolean
  flushOutput: Array<() => void>
  outputWindowStart: number
  outputEventsInWindow: number
  skipPersistence?: boolean
  windowsBootstrap?: WindowsBackgroundBootstrap
}
interface FinishedBackgroundRecord {
  process: BackgroundProcess
  outputLines: BackgroundProcessLogLine[]
  nextSequence: number
  droppedOutputLines: number
  clippedOutput: boolean
  cleanupTimer: ReturnType<typeof setTimeout>
}

const backgroundByPid = new Map<number, BackgroundRecord>()
const finishedBackgroundById = new Map<string, FinishedBackgroundRecord>()
const backgroundTerminal = new Set<BackgroundProcessStatus>(['exited', 'killed', 'failed', 'interrupted'])
const BACKGROUND_KILL_GRACE_MS = 2500
const BACKGROUND_STOP_CONFIRM_MS = 2500
const BACKGROUND_OUTPUT_MAX_LINE_CHARS = 4000
const BACKGROUND_OUTPUT_MAX_LINES_PER_SECOND = 20
const BACKGROUND_LOG_MAX_LINES = 2000
const BACKGROUND_FINISHED_MAX = 32
export const BACKGROUND_LOG_RETENTION_MS = 10 * 60 * 1000
export const BACKGROUND_PERSISTENCE_FLUSH_MS = 250
const pendingPersistence = new Map<string, { record: BackgroundRecord; lines: Map<number, BackgroundProcessLogLine> }>()
let backgroundStore: BackgroundProcessStore | undefined
let persistenceAttempted = false
let persistenceError: string | undefined
let persistenceTimer: ReturnType<typeof setTimeout> | undefined
let lastPersistenceAttempt = 0
let persistenceRetryDelay = BACKGROUND_PERSISTENCE_FLUSH_MS
let persistenceFile: string | undefined
let persistenceClosed = false
let lastHistoryOpenAttempt = 0

function ensureBackgroundProcessStore(): BackgroundProcessStore | undefined {
  if (backgroundStore || !persistenceAttempted) return backgroundStore
  if (!persistenceClosed && persistenceFile && Date.now() - lastHistoryOpenAttempt >= 1000) {
    try { initializeBackgroundProcessPersistence(persistenceFile) } catch { /* report the retained open failure below */ }
  }
  if (!backgroundStore) throw new Error(`Background process history is unavailable: ${persistenceClosed ? 'the store is closed' : persistenceError ?? 'the store could not be opened'}. Retry after the storage problem is resolved.`)
  return backgroundStore
}

function schedulePersistenceFlush(delay: number): void {
  if (persistenceTimer || !pendingPersistence.size || !backgroundStore) return
  persistenceTimer = setTimeout(() => {
    persistenceTimer = undefined
    try { flushBackgroundProcessPersistence() } catch { /* failure schedules a bounded retry even for a quiet process */ }
  }, delay)
  persistenceTimer.unref?.()
}

export function initializeBackgroundProcessPersistence(file: string): void {
  if (backgroundStore) { flushBackgroundProcessPersistence(); return }
  persistenceFile = file
  persistenceClosed = false
  lastHistoryOpenAttempt = Date.now()
  persistenceAttempted = true
  try {
    backgroundStore = new BackgroundProcessStore(file)
    persistenceError = undefined
    for (const record of backgroundByPid.values()) {
      for (const line of record.outputLines) queuePersistence(record, line)
      queuePersistence(record)
    }
    flushBackgroundProcessPersistence()
  } catch (error) {
    persistenceError = error instanceof Error ? error.message : String(error)
    throw error
  }
}

function queuePersistence(record: BackgroundRecord, line?: BackgroundProcessLogLine): void {
  if (!backgroundStore || record.skipPersistence) return
  let pending = pendingPersistence.get(record.process.processId)
  if (!pending) { pending = { record, lines: new Map() }; pendingPersistence.set(record.process.processId, pending) }
  if (line) pending.lines.set(line.sequence, cloneLogLine(line))
  if (pending.lines.size >= BACKGROUND_LOG_MAX_LINES) {
    if (!persistenceError || Date.now() - lastPersistenceAttempt >= BACKGROUND_PERSISTENCE_FLUSH_MS) {
      try { flushBackgroundProcessPersistence() } catch { /* failure stays visible and the buffer remains bounded */ }
    }
    while (pending.lines.size > BACKGROUND_LOG_MAX_LINES) pending.lines.delete(pending.lines.keys().next().value!)
  }
  schedulePersistenceFlush(persistenceError ? persistenceRetryDelay : BACKGROUND_PERSISTENCE_FLUSH_MS)
}

/** One transaction and one bulk line statement per batch, including upserts
 * for partial lines. A crash can lose at most the last 250ms of normal output. */
export function flushBackgroundProcessPersistence(): void {
  if (persistenceTimer) { clearTimeout(persistenceTimer); persistenceTimer = undefined }
  if (!backgroundStore) {
    if (persistenceError) throw new Error(persistenceError)
    return
  }
  lastPersistenceAttempt = Date.now()
  let failure: unknown
  for (const [processId, pending] of pendingPersistence) {
    if (pending.record.skipPersistence) { pendingPersistence.delete(processId); continue }
    const record = pending.record
    try {
      const { persistenceError: previousError, ...process } = record.process
      backgroundStore.write({ process, lines: [...pending.lines.values()], nextSequence: record.nextSequence, clipped: record.clippedOutput })
      pendingPersistence.delete(processId)
      delete record.process.persistenceError
      const retained = finishedBackgroundById.get(processId)
      if (retained) delete retained.process.persistenceError
      if (previousError) safelyNotify(() => record.hooks.onUpdated?.(cloneProcess(record.process)))
    } catch (error) {
      failure = error
      const message = `Background history could not be saved: ${error instanceof Error ? error.message : String(error)}`
      if (record.process.persistenceError !== message) {
        record.process.persistenceError = message
        const retained = finishedBackgroundById.get(processId)
        if (retained) retained.process.persistenceError = message
        safelyNotify(() => record.hooks.onUpdated?.(cloneProcess(record.process)))
      }
    }
  }
  persistenceError = failure ? (failure instanceof Error ? failure.message : String(failure)) : undefined
  if (failure) {
    schedulePersistenceFlush(persistenceRetryDelay)
    persistenceRetryDelay = Math.min(5000, persistenceRetryDelay * 2)
    throw failure
  }
  persistenceRetryDelay = BACKGROUND_PERSISTENCE_FLUSH_MS
}

export function closeBackgroundProcessPersistence(): void {
  persistenceClosed = true
  try { flushBackgroundProcessPersistence() } finally {
    if (persistenceTimer) { clearTimeout(persistenceTimer); persistenceTimer = undefined }
    const store = backgroundStore
    backgroundStore = undefined
    store?.close()
  }
}

export function purgeBackgroundProcessHistory(filter: { chatId?: string; projectId?: string }): void {
  if (!filter.chatId && !filter.projectId) throw new Error('A conversation or project is required to purge background history.')
  // Do not discard pending data or acknowledge deletion while its durable
  // store is inaccessible. A subsequent explicit retry can reopen it.
  ensureBackgroundProcessStore()?.purge(filter)
  const matches = (process: BackgroundProcess) => (!filter.chatId || process.chatId === filter.chatId) && (!filter.projectId || process.projectId === filter.projectId)
  for (const record of backgroundByPid.values()) if (matches(record.process)) {
    record.skipPersistence = true; pendingPersistence.delete(record.process.processId)
  }
  for (const [id, record] of finishedBackgroundById) if (matches(record.process)) {
    clearTimeout(record.cleanupTimer); finishedBackgroundById.delete(id); pendingPersistence.delete(id)
  }
}

function treeKillSafe(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try { treeKill(pid, signal, () => undefined) } catch { /* generic provider owners handle their own terminal state */ }
}
function isCurrent(record: BackgroundRecord): boolean { return backgroundByPid.get(record.process.pid) === record }
function cloneProcess(value: BackgroundProcess): BackgroundProcess { return { ...value } }
function cloneLogLine(value: BackgroundProcessLogLine): BackgroundProcessLogLine { return { ...value } }
function safelyNotify(callback: (() => void) | undefined): void {
  try { callback?.() } catch (error) { console.warn('[background-process] notification failed:', error instanceof Error ? error.message : String(error)) }
}
function notifyUpdated(record: BackgroundRecord): void {
  queuePersistence(record)
  try { flushBackgroundProcessPersistence() } catch { /* process control must continue when history persistence fails */ }
  safelyNotify(() => record.hooks.onUpdated?.(cloneProcess(record.process)))
}
function reportError(record: BackgroundRecord, error: unknown): void {
  if (!isCurrent(record)) return
  const message = error instanceof Error ? error.message : String(error)
  if (record.process.error === message) return
  record.process.error = message
  notifyUpdated(record)
}

/** Track a provider child under a projectId; its own manager retains lifecycle ownership. */
export function trackTransientChild(projectId: string, child: ChildProcess): void {
  try { assertProcessAdmission(projectId) } catch (error) {
    if (child.pid) treeKillSafe(child.pid, 'SIGTERM')
    throw error
  }
  let set = byProject.get(projectId)
  if (!set) { set = new Set(); byProject.set(projectId, set) }
  set.add(child)
  const drop = () => {
    const current = byProject.get(projectId)
    current?.delete(child)
    if (current?.size === 0) byProject.delete(projectId)
  }
  child.once('close', drop)
  child.once('error', drop)
}

/** Background apps retain their group owner until exit is confirmed. */
export function killTransientChildren(projectId: string): void {
  const children = byProject.get(projectId)
  if (children) for (const child of children) {
    if (!child.pid || backgroundByPid.get(child.pid)?.child === child) continue
    let alive = true
    treeKillSafe(child.pid, 'SIGTERM')
    const timer = setTimeout(() => { if (alive) treeKillSafe(child.pid!, 'SIGKILL') }, BACKGROUND_KILL_GRACE_MS)
    timer.unref?.()
    const clear = () => { alive = false; clearTimeout(timer) }
    child.once('close', clear)
    child.once('error', clear)
  }
  byProject.delete(projectId)
  for (const record of backgroundByPid.values()) {
    if (record.process.projectId === projectId) terminateBackgroundRecord(record)
  }
}

export function startBackgroundProcess(
  command: string,
  cwd: string,
  chatId: string,
  projectId: string,
  hooks: BackgroundProcessHooks = {},
  metadata: { repositoryId?: string; repositoryName?: string } = {},
): BackgroundProcess {
  assertProcessAdmission(projectId)
  ensureBackgroundProcessStore()
  if (persistenceError) flushBackgroundProcessPersistence()
  const startedAt = Date.now()
  const windowsBootstrap = process.platform === 'win32' ? spawnWindowsBackgroundBootstrap(command, cwd) : undefined
  const child = windowsBootstrap?.child ?? spawn(command, {
    cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    ...(process.platform === 'win32' ? { env: windowsSpawnEnv(), windowsHide: true } : {}),
  })
  if (!child.pid) {
    // spawn emits error asynchronously even when it returns no pid.
    child.once('error', () => {})
    child.stdout?.destroy(); child.stderr?.destroy()
    throw new Error('Background process failed to start; check its command and working directory.')
  }
  const previous = backgroundByPid.get(child.pid)
  if (previous) {
    // Defensive against a reused pid in stale registry state: never let old
    // timers, child events or UI requests operate on the replacement.
    finishRecord(previous, 'failed', 'The operating system reused this process ID.')
  }
  const record: BackgroundRecord = {
    child, control: windowsBootstrap?.control ?? createBackgroundProcessControl(child, startedAt), hooks, windowsBootstrap,
    process: { processId: randomUUID(), pid: child.pid, command, cwd, startedAt, status: windowsBootstrap ? 'starting' : 'running', chatId, projectId, ...metadata },
    stoppingAttempt: 0, stopAttemptActive: false, rootClosed: false, rootExited: false, userStopRequested: false, groupGone: false, exitCode: null, exitSignal: null,
    outputLines: [], outputBySequence: new Map(), nextSequence: 0, droppedOutputLines: 0, clippedOutput: false,
    flushOutput: [], outputWindowStart: Date.now(), outputEventsInWindow: 0,
  }
  backgroundByPid.set(child.pid, record)
  attachOutput(child.stdout, 'stdout', record)
  attachOutput(child.stderr, 'stderr', record)
  child.once('error', error => { reportError(record, error); void probeRecord(record) })
  child.once('exit', (code: number | null, signal: string | null) => {
    record.rootExited = true
    record.exitCode = code; record.exitSignal = signal
    void probeRecord(record)
  })
  child.once('close', (code: number | null, signal: string | null) => {
    record.rootExited = true; record.rootClosed = true; record.exitCode = code; record.exitSignal = signal
    record.flushOutput.forEach(flush => flush())
    void probeRecord(record)
  })
  queuePersistence(record)
  try { flushBackgroundProcessPersistence() } catch (error) {
    terminateBackgroundRecord(record)
    throw error
  }
  safelyNotify(() => hooks.onStarted?.(cloneProcess(record.process)))
  if (windowsBootstrap) {
    void record.control.ready?.then(() => {
      if (!isCurrent(record) || record.process.status !== 'starting' || record.rootExited) { windowsBootstrap.cancel(); return }
      windowsBootstrap.start()
      record.process.status = 'running'
      queuePersistence(record)
      safelyNotify(() => hooks.onUpdated?.(cloneProcess(record.process)))
    }).catch(error => {
      if (!isCurrent(record)) return
      reportError(record, error)
      if (windowsBootstrap.hasLaunched()) terminateBackgroundRecord(record, true)
      else windowsBootstrap.cancel()
    })
  }
  scheduleProbe(record)
  return cloneProcess(record.process)
}

function scheduleProbe(record: BackgroundRecord): void {
  if (!isCurrent(record) || record.probeTimer) return
  const delay = record.process.status === 'stopping' && process.platform !== 'win32' ? 100 : 1000
  record.probeTimer = setTimeout(() => { record.probeTimer = undefined; void probeRecord(record) }, delay)
  record.probeTimer.unref?.()
}
function probeRecord(record: BackgroundRecord): Promise<void> {
  if (!isCurrent(record)) return Promise.resolve()
  if (record.probing) return record.probing
  const pending = Promise.resolve().then(async () => {
    try {
      // Before admission the bootstrap has no descendants. Its own child handle
      // can confirm exit even if Windows identity discovery failed or was cancelled.
      if (record.windowsBootstrap && !record.windowsBootstrap.hasLaunched() && record.rootClosed) record.groupGone = true
      if (!record.groupGone) record.groupGone = !(await record.control.isAlive())
      if (!isCurrent(record)) return
      if (record.groupGone && record.rootClosed) {
        const containmentFailure = record.control.terminalFailure?.()
        finishRecord(record, containmentFailure ? 'failed' : record.userStopRequested ? 'killed' : record.exitCode === 0 ? 'exited' : 'failed', containmentFailure)
      } else if (record.rootExited && !record.groupGone && record.process.status !== 'stopping') {
        // A wrapper that exits must not leave an unowned app behind. Clean up
        // its group, retaining the wrapper's original success/failure outcome.
        terminateBackgroundRecord(record, true)
      } else if (record.forceKillAt !== undefined && Date.now() - record.forceKillAt >= BACKGROUND_STOP_CONFIRM_MS && !record.groupGone) {
        record.stopAttemptActive = false
        reportError(record, new Error('The process group has not stopped after the force-stop request. Retry stopping it.'))
      }
    } catch (error) { record.stopAttemptActive = false; reportError(record, error) }
  }).finally(() => { if (record.probing === pending) record.probing = undefined; scheduleProbe(record) })
  record.probing = pending
  return pending
}

/** Stop is idempotent while an attempt is progressing. Failed attempts remain
 * visible and may be retried; terminal state requires both OS and child close. */
function terminateBackgroundRecord(record: BackgroundRecord, automatic = false): void {
  record.windowsBootstrap?.cancel()
  if (!automatic) record.userStopRequested = true
  if (!isCurrent(record) || record.stopAttemptActive) return
  record.stopAttemptActive = true
  const attempt = ++record.stoppingAttempt
  record.process.status = 'stopping'
  record.process.stopRequestedAt ??= Date.now()
  delete record.process.error
  record.forceKillAt = undefined
  if (record.killTimer) clearTimeout(record.killTimer)
  notifyUpdated(record)
  const signal = async (value: 'SIGTERM' | 'SIGKILL') => {
    if (!isCurrent(record) || record.stoppingAttempt !== attempt || record.groupGone) return
    try { await record.control.terminate(value) }
    catch (error) { if (record.stoppingAttempt === attempt) { record.stopAttemptActive = false; reportError(record, error) } }
    await probeRecord(record)
  }
  void signal('SIGTERM')
  record.killTimer = setTimeout(() => {
    record.killTimer = undefined
    if (!isCurrent(record) || record.stoppingAttempt !== attempt || record.groupGone) return
    record.forceKillAt = Date.now()
    void signal('SIGKILL')
  }, BACKGROUND_KILL_GRACE_MS)
  // Keep the escalation armed even after the shell's close event. Shutdown
  // additionally awaits the drain below before exiting the server process.
  record.killTimer.unref?.()
}

/** Incremental bounded terminal-text capture. StringDecoder keeps split UTF-8
 * intact; escape state is finite even for unterminated OSC/CSI sequences. */
function attachOutput(stream: NodeJS.ReadableStream | null, source: 'stdout' | 'stderr', record: BackgroundRecord): void {
  if (!stream) return
  const decoder = new StringDecoder('utf8')
  let text = '', clipped = false, pendingCR = false, ended = false
  let escape: 'plain' | 'escape' | 'csi' | 'osc' | 'oscEscape' = 'plain'
  let row: BackgroundProcessLogLine | undefined
  const publish = (partial: boolean) => {
    if (!text && !row && partial) return
    if (!row || !record.outputBySequence.has(row.sequence)) {
      row = { sequence: ++record.nextSequence, at: Date.now(), source, line: '', partial }
      record.outputLines.push(row); record.outputBySequence.set(row.sequence, row)
      if (record.outputLines.length > BACKGROUND_LOG_MAX_LINES) {
        const removed = record.outputLines.shift()!
        record.outputBySequence.delete(removed.sequence); record.droppedOutputLines += 1
      }
    }
    row.line = clipped ? `${text.slice(0, BACKGROUND_OUTPUT_MAX_LINE_CHARS - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : text
    row.partial = partial
    if (clipped) record.clippedOutput = true
    queuePersistence(record, row)
    const now = Date.now()
    if (now - record.outputWindowStart >= 1000) { record.outputWindowStart = now; record.outputEventsInWindow = 0 }
    // Live notifications are hints; sequence gaps are recoverable from the
    // bounded authoritative snapshot. Never drop lines from that snapshot.
    if (record.outputEventsInWindow < BACKGROUND_OUTPUT_MAX_LINES_PER_SECOND) {
      record.outputEventsInWindow += 1
      safelyNotify(() => record.hooks.onOutput?.({ ...cloneLogLine(row!), processId: record.process.processId, pid: record.process.pid, chatId: record.process.chatId, projectId: record.process.projectId }))
    }
  }
  const consume = (chunk: string) => {
    for (const character of chunk) {
      if (escape === 'escape') {
        escape = character === '[' ? 'csi' : [']', 'P', '^', '_'].includes(character) ? 'osc' : 'plain'; continue
      }
      if (escape === 'csi') { if (character >= '@' && character <= '~') escape = 'plain'; continue }
      if (escape === 'osc') { if (character === '\u0007') escape = 'plain'; else if (character === '\u001b') escape = 'oscEscape'; continue }
      if (escape === 'oscEscape') { escape = character === '\\' ? 'plain' : 'osc'; continue }
      if (character === '\u001b') { escape = 'escape'; continue }
      if (character === '\u009b') { escape = 'csi'; continue }
      if (pendingCR) {
        pendingCR = false
        if (character !== '\n') { text = ''; clipped = false }
      }
      if (character === '\r') { pendingCR = true; continue }
      if (character === '\n') { publish(false); text = ''; clipped = false; row = undefined; continue }
      if (character === '\b') { text = Array.from(text).slice(0, -1).join(''); continue }
      if ((character < ' ' && character !== '\t') || character === '\u007f' || (character >= '\u0080' && character <= '\u009f')) continue
      if (text.length + character.length <= BACKGROUND_OUTPUT_MAX_LINE_CHARS) text += character
      else clipped = true
    }
    publish(true)
  }
  stream.on('data', (chunk: Buffer | string) => { if (!ended) consume(typeof chunk === 'string' ? chunk : decoder.write(chunk)) })
  const finish = () => {
    if (ended) return
    consume(decoder.end())
    ended = true
    if (row || text) publish(false)
  }
  stream.once('end', finish)
  stream.once('close', finish)
  stream.once('error', error => { reportError(record, error); finish() })
  record.flushOutput.push(finish)
}

function finishRecord(record: BackgroundRecord, status: 'exited' | 'killed' | 'failed', error?: string): void {
  if (!isCurrent(record)) return
  if (record.killTimer) clearTimeout(record.killTimer)
  if (record.probeTimer) clearTimeout(record.probeTimer)
  record.process.status = status
  record.process.endedAt = Date.now()
  record.process.exitCode = record.exitCode
  record.process.signal = record.exitSignal
  if (error) record.process.error = error
  record.flushOutput.forEach(flush => flush())
  queuePersistence(record)
  try { flushBackgroundProcessPersistence() } catch { /* retain the pending batch and visible persistenceError for a later retry */ }
  backgroundByPid.delete(record.process.pid)
  if (record.skipPersistence) {
    safelyNotify(() => record.hooks.onExited?.(cloneProcess(record.process)))
    return
  }
  const processId = record.process.processId
  const cleanupTimer = setTimeout(() => { finishedBackgroundById.delete(processId) }, BACKGROUND_LOG_RETENTION_MS)
  cleanupTimer.unref?.()
  finishedBackgroundById.set(processId, {
    process: cloneProcess(record.process), outputLines: record.outputLines.map(cloneLogLine),
    nextSequence: record.nextSequence, droppedOutputLines: record.droppedOutputLines, clippedOutput: record.clippedOutput, cleanupTimer,
  })
  while (finishedBackgroundById.size > BACKGROUND_FINISHED_MAX) {
    const oldest = finishedBackgroundById.entries().next().value!
    clearTimeout(oldest[1].cleanupTimer); finishedBackgroundById.delete(oldest[0])
  }
  safelyNotify(() => record.hooks.onExited?.(cloneProcess(record.process)))
}

function findRecord(pid: number, processId?: string): BackgroundRecord | FinishedBackgroundRecord | undefined {
  const live = backgroundByPid.get(pid)
  if (live && (!processId || live.process.processId === processId)) return live
  if (processId) {
    const finished = finishedBackgroundById.get(processId)
    return finished?.process.pid === pid ? finished : undefined
  }
  return [...finishedBackgroundById.values()].reverse().find(record => record.process.pid === pid)
}
export function getBackgroundProcess(pid: number, processId?: string): BackgroundProcess | null {
  const record = findRecord(pid, processId)
  return record ? cloneProcess(record.process) : ensureBackgroundProcessStore()?.get(pid, processId) ?? null
}
export function getBackgroundProcessLogs(
  pid: number,
  filter: { projectId?: string; chatId?: string; processId?: string; limit?: number } = {},
): BackgroundProcessLogSnapshot | null {
  const record = findRecord(pid, filter.processId)
  if (!record) return ensureBackgroundProcessStore()?.logs(pid, filter) ?? null
  if ((filter.projectId && record.process.projectId !== filter.projectId) || (filter.chatId && record.process.chatId !== filter.chatId)) return null
  const maxLines = backgroundStore ? BACKGROUND_HISTORY_MAX_LINES : BACKGROUND_LOG_MAX_LINES
  const limit = typeof filter.limit === 'number' && Number.isFinite(filter.limit) ? Math.max(1, Math.min(maxLines, Math.floor(filter.limit))) : BACKGROUND_LOG_MAX_LINES
  let durable: BackgroundProcessLogSnapshot | null = null
  try { durable = ensureBackgroundProcessStore()?.logs(pid, { ...filter, processId: record.process.processId, limit }) ?? null }
  catch (error) { record.process.persistenceError = `Background history could not be read: ${error instanceof Error ? error.message : String(error)}` }
  const combined = new Map((durable?.lines ?? []).map(line => [line.sequence, line]))
  for (const line of record.outputLines) combined.set(line.sequence, line)
  for (const line of pendingPersistence.get(record.process.processId)?.lines.values() ?? []) combined.set(line.sequence, line)
  const lines = [...combined.values()].sort((a, b) => a.sequence - b.sequence).slice(-limit).map(cloneLogLine)
  const nextSequence = Math.max(record.nextSequence, durable?.nextSequence ?? 0)
  const droppedLines = Math.max(0, nextSequence - lines.length)
  return {
    process: cloneProcess(record.process), lines, nextSequence,
    truncated: droppedLines > 0 || record.clippedOutput || (durable?.truncated ?? false), droppedLines,
    maxLines, maxLineChars: BACKGROUND_OUTPUT_MAX_LINE_CHARS, retentionMs: backgroundStore ? BACKGROUND_HISTORY_RETENTION_MS : BACKGROUND_LOG_RETENTION_MS,
  }
}
export function listBackgroundProcesses(filter: { projectId?: string; chatId?: string; includeFinished?: boolean } = {}): BackgroundProcess[] {
  const records = [...backgroundByPid.values(), ...(filter.includeFinished ? finishedBackgroundById.values() : [])]
  const combined = new Map((ensureBackgroundProcessStore()?.list(filter) ?? []).map(process => [process.processId, process]))
  for (const record of records) if ((!filter.projectId || record.process.projectId === filter.projectId) && (!filter.chatId || record.process.chatId === filter.chatId)) combined.set(record.process.processId, cloneProcess(record.process))
  return [...combined.values()].sort((a, b) => a.startedAt - b.startedAt)
}
export function killBackgroundProcess(pid: number, processId?: string): void {
  const record = backgroundByPid.get(pid)
  if (record && (!processId || processId === record.process.processId)) terminateBackgroundRecord(record)
}
export function killOwnedBackgroundProcess(pid: number, owner: { projectId: string; chatId: string; processId?: string }): boolean {
  const record = findRecord(pid, owner.processId)
  if (!record) return false // historical rows never regain operating-system control
  if (!record || record.process.projectId !== owner.projectId || record.process.chatId !== owner.chatId) return false
  if (!backgroundTerminal.has(record.process.status)) killBackgroundProcess(pid, record.process.processId)
  return true
}
export function killBackgroundProcessesForChat(chatId: string, projectId?: string): number {
  let count = 0
  for (const record of backgroundByPid.values()) {
    if (record.process.chatId !== chatId || (projectId && record.process.projectId !== projectId)) continue
    terminateBackgroundRecord(record); count += 1
  }
  return count
}

/** Shutdown requests stop for all owned apps and keeps the event loop alive
 * through escalation. Returns unresolved processes rather than claiming exit. */
export async function awaitBackgroundProcessesStopped(timeoutMs = 6000): Promise<BackgroundProcess[]> {
  for (const record of backgroundByPid.values()) terminateBackgroundRecord(record)
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (backgroundByPid.size > 0 && Date.now() < deadline) {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all([...backgroundByPid.values()].map(probeRecord)),
        new Promise(resolve => { deadlineTimer = setTimeout(resolve, Math.max(0, deadline - Date.now())) }),
      ])
    } finally { if (deadlineTimer) clearTimeout(deadlineTimer) }
    if (backgroundByPid.size === 0 || Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))))
  }
  try { flushBackgroundProcessPersistence() } catch { /* storage failure must not prevent control/shutdown; close reports it to the app */ }
  return [...backgroundByPid.values()].map(record => cloneProcess(record.process))
}
