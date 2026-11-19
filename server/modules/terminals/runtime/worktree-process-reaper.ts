/**
 * Terminates the processes a settled run left behind in its worktree (see
 * `domain/worktree-leftovers.ts` for what is selected and what is protected).
 *
 * One reaper is installed by the server composition root
 * (`server/worktree-process-reaper.ts`), which knows every live owner across
 * projects. Settlement and worktree-removal call sites use
 * `reapWorktreeLeftovers`, a no-op until a reaper is installed (unit tests,
 * the CLI) and never throws.
 *
 * Termination: SIGTERM to every selected pid (Windows: `taskkill /T`), then,
 * after a grace period, SIGKILL (`taskkill /T /F`) to the ones still present
 * with the same command line, so a reused pid is never signalled. The returned
 * promise settles once the first signal is sent; escalation runs on an
 * unreferenced timer.
 */
import { execFile } from 'node:child_process'
import {
  commandHead, isReapableWorktreePath, selectWorktreeLeftovers, type LeftoverProcess,
} from '../domain/worktree-leftovers'
import type { ProcessSample } from '../domain/mission-resources'
import type { ProcessTableReader } from './resource-sampler'

export interface ReapRequest {
  worktreePaths: readonly string[]
  /** Why the reaper runs (`rail-run-settled`, `worktree-removed`, `startup-recovery`, …). */
  reason: string
  projectId?: string
  runId?: string
}

export interface ReapResult {
  /** Paths actually examined (unsafe paths are skipped). */
  worktreePaths: string[]
  reaped: LeftoverProcess[]
  /** True when the process table could not be read; nothing was signalled. */
  unavailable: boolean
}

export type ReapSignal = 'SIGTERM' | 'SIGKILL'

export interface WorktreeProcessReaperDeps {
  readProcessTable: ProcessTableReader
  /** Live owned roots (agent sessions, runs, jobs, background processes, terminals) for this table. */
  listProtectedRootPids: (table: ProcessSample[]) => number[]
  /** Paths the reaper must never act on, nor on any of their ancestors. */
  listForbiddenPaths?: () => string[]
  serverPid?: number
  platform?: NodeJS.Platform
  kill?: (pid: number, signal: ReapSignal) => void
  graceMs?: number
  log?: (line: string) => void
  /** Called once per reap that terminated something (activity/telemetry hook). */
  onReaped?: (request: ReapRequest, reaped: LeftoverProcess[]) => void
  setTimer?: (fn: () => void, ms: number) => void
  /** Removes the compose containers started from these worktrees (absent: none are touched). */
  reapContainers?: (worktreePaths: string[], context: string) => Promise<unknown>
}

export type WorktreeProcessReaper = (request: ReapRequest) => Promise<ReapResult>

export const DEFAULT_REAP_GRACE_MS = 3000

function defaultKill(platform: NodeJS.Platform): (pid: number, signal: ReapSignal) => void {
  if (platform === 'win32') {
    return (pid, signal) => {
      const args = ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])]
      execFile('taskkill', args, { windowsHide: true, timeout: 10_000 }, () => { /* gone or refused: escalation decides */ })
    }
  }
  return (pid, signal) => {
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
}

export function createWorktreeProcessReaper(deps: WorktreeProcessReaperDeps): WorktreeProcessReaper {
  const platform = deps.platform ?? process.platform
  const windows = platform === 'win32'
  const serverPid = deps.serverPid ?? process.pid
  const kill = deps.kill ?? defaultKill(platform)
  const graceMs = deps.graceMs ?? DEFAULT_REAP_GRACE_MS
  const log = deps.log ?? ((line: string) => console.log(line))
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms).unref?.() })

  return async (request) => {
    const forbidden = deps.listForbiddenPaths?.() ?? []
    const worktreePaths = [...new Set(request.worktreePaths.filter((p) => typeof p === 'string' && p.trim()))]
      .filter((p) => {
        if (isReapableWorktreePath(p, forbidden, { windows })) return true
        log(`[worktree-reaper] skipped unsafe path ${p} (${request.reason})`)
        return false
      })
    if (worktreePaths.length === 0) return { worktreePaths, reaped: [], unavailable: false }
    // Containers are the Docker daemon's, never in the process table: reaped by their compose directory.
    if (deps.reapContainers) {
      const where = [request.reason, request.projectId ? `project=${request.projectId}` : '', request.runId ? `run=${request.runId}` : ''].filter(Boolean).join(' ')
      try { await deps.reapContainers(worktreePaths, where) } catch { /* containers never block process cleanup */ }
    }
    const table = await deps.readProcessTable()
    if (!table) return { worktreePaths, reaped: [], unavailable: true }
    const reaped = selectWorktreeLeftovers(table, worktreePaths, {
      protectedRootPids: deps.listProtectedRootPids(table),
      serverPid,
      windows,
    })
    if (reaped.length === 0) return { worktreePaths, reaped, unavailable: false }

    const context = [request.reason, request.projectId ? `project=${request.projectId}` : '', request.runId ? `run=${request.runId}` : '']
      .filter(Boolean).join(' ')
    const selectedPids = new Set(reaped.map((p) => p.pid))
    for (const p of reaped) {
      log(`[worktree-reaper] SIGTERM pid=${p.pid} worktree=${p.worktreePath} (${context}) cmd="${commandHead(p.command)}"`)
      // Windows: `taskkill /T` already covers the subtree; signal only the top-most selected processes.
      if (windows && selectedPids.has(p.ppid)) continue
      kill(p.pid, 'SIGTERM')
    }
    try { deps.onReaped?.(request, reaped) } catch { /* reporting never blocks cleanup */ }

    setTimer(() => {
      void (async () => {
        const after = await deps.readProcessTable()
        if (!after) return
        const live = new Map(after.map((s) => [s.pid, s.command]))
        for (const p of reaped) {
          if (live.get(p.pid) !== p.command) continue
          if (windows && selectedPids.has(p.ppid) && live.get(p.ppid) !== undefined) continue
          log(`[worktree-reaper] SIGKILL pid=${p.pid} worktree=${p.worktreePath} (${context}): still running after ${graceMs} ms`)
          kill(p.pid, 'SIGKILL')
        }
      })().catch(() => { /* best effort */ })
    }, graceMs)
    return { worktreePaths, reaped, unavailable: false }
  }
}

let installed: WorktreeProcessReaper | null = null

/** Installs (or, with null, removes) the app-wide reaper. Called by the server composition root only. */
export function installWorktreeProcessReaper(reaper: WorktreeProcessReaper | null): void {
  installed = reaper
}

/** Reaps leftovers through the installed reaper. No-op without one; never throws. */
export async function reapWorktreeLeftovers(request: ReapRequest): Promise<ReapResult | null> {
  if (!installed) return null
  try {
    return await installed(request)
  } catch (err) {
    console.warn(`[worktree-reaper] ${request.reason} failed:`, err instanceof Error ? err.message : err)
    return null
  }
}
