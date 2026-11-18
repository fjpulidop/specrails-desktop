import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSample } from '../domain/mission-resources'
import {
  createWorktreeProcessReaper, installWorktreeProcessReaper, reapWorktreeLeftovers, type ReapSignal,
} from './worktree-process-reaper'

const WT = '/home/me/.specrails/projects/p/worktrees/run/ticket-1'
const row = (pid: number, ppid: number, command: string): ProcessSample => ({ pid, ppid, cpuPercent: 0, rssBytes: 0, command })
const SERVER = 10

function harness(tables: Array<ProcessSample[] | null>, options: { platform?: NodeJS.Platform; protectedRoots?: number[]; forbidden?: string[] } = {}) {
  const signals: Array<[number, ReapSignal]> = []
  const timers: Array<() => void> = []
  const lines: string[] = []
  const onReaped = vi.fn()
  let read = 0
  const reaper = createWorktreeProcessReaper({
    readProcessTable: async () => tables[Math.min(read++, tables.length - 1)],
    listProtectedRootPids: () => options.protectedRoots ?? [],
    listForbiddenPaths: () => options.forbidden ?? [],
    serverPid: SERVER,
    platform: options.platform ?? 'darwin',
    kill: (pid, signal) => { signals.push([pid, signal]) },
    graceMs: 50,
    log: (line) => lines.push(line),
    onReaped,
    setTimer: (fn) => { timers.push(fn) },
  })
  const flushTimers = async () => { for (const fn of timers.splice(0)) fn(); await new Promise((r) => setTimeout(r, 0)) }
  return { reaper, signals, lines, onReaped, flushTimers, reads: () => read }
}

afterEach(() => installWorktreeProcessReaper(null))

describe('createWorktreeProcessReaper', () => {
  const leftovers = [row(SERVER, 1, 'server'), row(20, 1, `node ${WT}/node_modules/.bin/vite preview`), row(21, 20, 'esbuild --service'), row(30, 1, 'node unrelated.js')]

  it('SIGTERMs the leftovers, logs each one and SIGKILLs only same-command survivors', async () => {
    const after = [row(SERVER, 1, 'server'), row(20, 1, `node ${WT}/node_modules/.bin/vite preview`), row(21, 1, 'reused pid, other program')]
    const h = harness([leftovers, after])
    const result = await h.reaper({ worktreePaths: [WT], reason: 'rail-run-settled', runId: 'r1', projectId: 'p' })
    expect(result.reaped.map((p) => p.pid)).toEqual([20, 21])
    expect(h.signals).toEqual([[20, 'SIGTERM'], [21, 'SIGTERM']])
    expect(h.lines.filter((l) => l.includes('SIGTERM'))).toHaveLength(2)
    expect(h.lines[0]).toContain(`worktree=${WT}`)
    expect(h.lines[0]).toContain('run=r1')
    expect(h.onReaped).toHaveBeenCalledOnce()
    await h.flushTimers()
    expect(h.signals).toEqual([[20, 'SIGTERM'], [21, 'SIGTERM'], [20, 'SIGKILL']])
  })

  it('keeps protected roots and does nothing when no leftover matches', async () => {
    const h = harness([leftovers], { protectedRoots: [20] })
    const result = await h.reaper({ worktreePaths: [WT], reason: 'test' })
    expect(result.reaped).toEqual([])
    expect(h.signals).toEqual([])
    expect(h.onReaped).not.toHaveBeenCalled()
  })

  it('skips unsafe paths without reading the process table', async () => {
    const h = harness([leftovers], { forbidden: [`${WT}/nested-project`] })
    const result = await h.reaper({ worktreePaths: [WT, 'relative/path', ''], reason: 'test' })
    expect(result.worktreePaths).toEqual([])
    expect(h.reads()).toBe(0)
    expect(h.lines.some((l) => l.includes('skipped unsafe path'))).toBe(true)
  })

  it('reports an unreadable process table without signalling', async () => {
    const h = harness([null])
    expect(await h.reaper({ worktreePaths: [WT], reason: 'test' })).toMatchObject({ unavailable: true, reaped: [] })
    expect(h.signals).toEqual([])
  })

  it('on Windows signals only the top-most selected process (taskkill /T covers the subtree)', async () => {
    const winWt = 'C:\\Users\\me\\.specrails\\projects\\p\\worktrees\\run\\ticket-1'
    const table = [row(SERVER, 4, 'server.exe'), row(40, 4, `node.exe ${winWt}\\node_modules\\vite\\bin\\vite.js`), row(41, 40, 'esbuild.exe')]
    const h = harness([table, table], { platform: 'win32' })
    await h.reaper({ worktreePaths: [winWt], reason: 'test' })
    expect(h.signals).toEqual([[40, 'SIGTERM']])
    await h.flushTimers()
    expect(h.signals).toEqual([[40, 'SIGTERM'], [40, 'SIGKILL']])
  })
})

describe('reapWorktreeLeftovers', () => {
  it('is a no-op until a reaper is installed', async () => {
    expect(await reapWorktreeLeftovers({ worktreePaths: [WT], reason: 'test' })).toBeNull()
  })

  it('delegates to the installed reaper and never throws', async () => {
    const reaper = vi.fn(async () => ({ worktreePaths: [WT], reaped: [], unavailable: false }))
    installWorktreeProcessReaper(reaper)
    expect(await reapWorktreeLeftovers({ worktreePaths: [WT], reason: 'test' })).toMatchObject({ unavailable: false })
    installWorktreeProcessReaper(async () => { throw new Error('boom') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await reapWorktreeLeftovers({ worktreePaths: [WT], reason: 'test' })).toBeNull()
    warn.mockRestore()
  })
})
