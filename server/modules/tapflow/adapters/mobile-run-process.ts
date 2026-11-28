/**
 * A mission's Test in Mobile Device run in its Processes list: an observed background process
 * (`registerObservedProcess`) that gets the run's own log (build, upload, boot, install, launch), the lines
 * Tapflow's service writes meanwhile (tailed from its log, marked `[Tapflow]`), the PID of the step at work,
 * and the outcome. The list keeps it with its history like any other process of the mission.
 *
 * Keyed by run id (a fresh UUID per run, so no project's state can reach another's): the host-task
 * handlers write to the run they serve.
 */
import fs from 'node:fs'
import { registerObservedProcess, type BackgroundProcessHooks, type ObservedProcessHandle } from '../../../transient-children'

interface Tracked { handle: ObservedProcessHandle; tail: (() => void) | null; stopTail: () => void; pid: number }
const tracked = new Map<string, Tracked>()

const TAIL_MS = 1_000
/** Bytes read per tick at most: a chatty service cannot flood the mission's history. */
const TAIL_CHUNK = 64 * 1024

/** Follows `file` from its current end, handing each complete new line to `onLine`. */
export function tailFile(file: string, onLine: (line: string) => void, intervalMs = TAIL_MS): { read: () => void; stop: () => void } {
  let offset = (() => { try { return fs.statSync(file).size } catch { return 0 } })()
  let pending = ''
  const read = () => {
    let size: number
    try { size = fs.statSync(file).size } catch { return }
    if (size < offset) { offset = 0; pending = '' } // the service restarted and truncated its log
    if (size === offset) return
    const length = Math.min(size - offset, TAIL_CHUNK)
    const buffer = Buffer.alloc(length)
    let fd: number | null = null
    try { fd = fs.openSync(file, 'r'); fs.readSync(fd, buffer, 0, length, offset) } catch { return } finally { if (fd !== null) fs.closeSync(fd) }
    offset += length
    const lines = (pending + buffer.toString('utf8')).split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) onLine(line)
  }
  const timer = setInterval(read, intervalMs)
  timer.unref?.()
  return { read, stop: () => clearInterval(timer) }
}

/** Tapflow writes for a terminal: colours, and spinner frames redrawn with carriage returns. */
export function plainText(line: string): string {
  // eslint-disable-next-line no-control-regex
  const visible = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  return (visible.split('\r').at(-1) ?? '').trimEnd()
}

export function trackMobileRun(runId: string, input: {
  projectId: string; chatId: string; label: string; cwd: string; hooks: BackgroundProcessHooks
  repositoryId?: string; repositoryName?: string; flowId?: string
  /** Tapflow's service log while Specrails runs it (null: not followed). */
  serviceLog: string | null
}): void {
  const handle = registerObservedProcess(input, input.hooks)
  const tail = input.serviceLog ? tailFile(input.serviceLog, (line) => {
    const text = plainText(line)
    if (text) handle.appendLine(`[Tapflow] ${text}`)
  }) : null
  tracked.set(runId, { handle, tail: tail?.read ?? null, stopTail: () => tail?.stop(), pid: 0 })
}

/** A line of the run's own log (no-op for a run nobody watches in a mission). */
export function mobileRunLine(runId: string, line: string): void {
  tracked.get(runId)?.handle.appendLine(line)
}

/** The process doing the run's work now (the build), or 0 between steps. */
export function mobileRunPid(runId: string, pid: number): void {
  const run = tracked.get(runId)
  if (!run) return
  run.pid = pid
  run.handle.setPid(pid)
}

/** The build process of a watched run now (0 or absent between steps): the mission's Resources root. */
export function mobileRunActivePid(runId: string): number {
  return tracked.get(runId)?.pid ?? 0
}

/** Every watched run's build process now (the app-wide Resources' Tapflow category). */
export function mobileRunActivePids(): Array<{ runId: string; pid: number }> {
  return [...tracked.entries()].filter(([, run]) => run.pid > 0).map(([runId, run]) => ({ runId, pid: run.pid }))
}

export function finishMobileRun(runId: string, status: 'exited' | 'failed', detail?: string): void {
  const run = tracked.get(runId)
  if (!run) return
  tracked.delete(runId)
  run.tail?.() // Tapflow's last lines of this run
  run.stopTail()
  run.handle.setPid(0)
  if (detail) run.handle.appendLine(detail, status === 'failed' ? 'stderr' : 'stdout')
  run.handle.finish(status, status === 'failed' ? detail : undefined)
}
