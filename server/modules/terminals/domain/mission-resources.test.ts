import { describe, expect, it } from 'vitest'
import { applyCpuDeltas, findWorktreeRoots, measureRoots, parsePsOutput, parseWindowsProcessJson, shouldRecordSample, totalEntries } from './mission-resources'

const PS = `  1     0  0.0   1000 /sbin/launchd
 10     1  5.5   2048 claude --print
 11    10 20.0   4096 node server.js
 12    11  1.5   1024 node child
 20     1  3.0    512 other
garbage line
`

describe('mission resources model', () => {
  it('[spec:mission-resources/platform-sampling-reports-available-measurements] parses ps output in bytes and skips malformed lines', () => {
    const samples = parsePsOutput(PS)
    expect(samples).toHaveLength(5)
    expect(samples[1]).toEqual({ pid: 10, ppid: 1, cpuPercent: 5.5, rssBytes: 2048 * 1024, command: 'claude --print' })
  })

  it('[spec:mission-resources/resource-snapshots-measure-selected-process-trees] measures a root with all descendants and never other trees', () => {
    const [agent] = measureRoots(parsePsOutput(PS), [{ id: 'a', kind: 'agent-session', label: 'Agent', pid: 10 }])
    expect(agent).toMatchObject({ running: true, processCount: 3, cpuPercent: 27, memoryBytes: (2048 + 4096 + 1024) * 1024 })
  })

  it('[spec:mission-resources/resource-snapshots-measure-selected-process-trees] counts a shared descendant once and flags vanished roots', () => {
    const entries = measureRoots(parsePsOutput(PS), [
      { id: 'a', kind: 'agent-session', label: 'Agent', pid: 10 },
      { id: 'b', kind: 'background-process', label: 'dev', pid: 11 },
      { id: 'c', kind: 'background-process', label: 'gone', pid: 999 },
    ])
    expect(entries[1].processCount).toBe(0)
    expect(entries[2]).toMatchObject({ running: false, processCount: 0, memoryBytes: 0 })
    expect(totalEntries(entries).processCount).toBe(3)
  })
})

describe('findWorktreeRoots', () => {
  const ps = (pid: number, ppid: number, command: string) => ({ pid, ppid, cpuPercent: 1, rssBytes: 1024, command })
  it('[spec:mission-resources/resource-snapshots-measure-selected-process-trees] returns top-most processes referencing the worktree and ignores lookalike paths', () => {
    const samples = [
      ps(1, 0, 'init'),
      ps(10, 1, 'node /w/ticket-1/script.js'),
      ps(11, 10, 'node child /w/ticket-1/x'),
      ps(12, 1, 'node /w/ticket-10/script.js'),
    ]
    expect(findWorktreeRoots(samples, '/w/ticket-1').map((r) => r.pid)).toEqual([10])
  })
})

describe('Windows process table', () => {
  const row = (pid: number, ppid: number, kernel: number, user: number, command: string | null, ws = 1024 * 1024) =>
    ({ ProcessId: pid, ParentProcessId: ppid, WorkingSetSize: ws, KernelModeTime: kernel, UserModeTime: user, CommandLine: command })

  it('[spec:mission-resources/platform-sampling-reports-available-measurements] parses an array, a single object, a BOM and skips malformed rows', () => {
    const json = JSON.stringify([row(10, 1, 10_000, 20_000, 'node a.js'), row(11, 10, 0, 0, null), { ProcessId: 'x' }, null])
    const rows = parseWindowsProcessJson(json)
    expect(rows.map((r) => r.pid)).toEqual([10, 11])
    expect(rows[0]).toMatchObject({ ppid: 1, rssBytes: 1024 * 1024, cpuTimeMs: 3, command: 'node a.js' })
    expect(rows[1].command).toBe('')
    expect(parseWindowsProcessJson('\uFEFF' + JSON.stringify(row(5, 1, 0, 0, 'x')))).toHaveLength(1)
    expect(parseWindowsProcessJson('')).toEqual([])
    expect(parseWindowsProcessJson('not json')).toEqual([])
  })

  it('[spec:mission-resources/platform-sampling-reports-available-measurements] derives cpu percent from cumulative time, 0 for new or reused pids and zero elapsed', () => {
    const rows = parseWindowsProcessJson(JSON.stringify([row(1, 0, 0, 5_000_000, 'a'), row(2, 1, 0, 1_000_000, 'b'), row(3, 1, 0, 0, 'c')]))
    // previous: pid 1 had 100 ms, pid 2 had 900 ms (> now: reused pid), pid 3 unseen is not in map
    const { samples, next } = applyCpuDeltas(new Map([[1, 100], [2, 900]]), rows, 1000)
    expect(samples.find((s) => s.pid === 1)!.cpuPercent).toBe(40)
    expect(samples.find((s) => s.pid === 2)!.cpuPercent).toBe(0)
    expect(samples.find((s) => s.pid === 3)!.cpuPercent).toBe(0)
    expect(next.get(1)).toBe(500)
    expect(applyCpuDeltas(new Map([[1, 0]]), rows, 0).samples[0].cpuPercent).toBe(0)
  })

  it('[spec:mission-resources/resource-snapshots-measure-selected-process-trees] matches worktree paths on Windows with either separator, any case, and respects path boundaries', () => {
    const samples = [
      { pid: 1, ppid: 0, cpuPercent: 0, rssBytes: 0, command: 'C:\\Windows\\explorer.exe' },
      { pid: 2, ppid: 1, cpuPercent: 0, rssBytes: 0, command: 'node.exe "c:/Users/Dev/.specrails/Worktrees/ticket-1/server.js"' },
      { pid: 3, ppid: 2, cpuPercent: 0, rssBytes: 0, command: 'node.exe C:\\Users\\dev\\.specrails\\worktrees\\ticket-1\\child.js' },
      { pid: 4, ppid: 1, cpuPercent: 0, rssBytes: 0, command: 'node.exe C:\\Users\\dev\\.specrails\\worktrees\\ticket-10\\x.js' },
    ]
    const roots = findWorktreeRoots(samples, 'C:\\Users\\Dev\\.specrails\\worktrees\\ticket-1\\', { windows: true })
    expect(roots.map((r) => r.pid)).toEqual([2])
    // Without the windows flag the same command lines do not match a different-case posix path.
    expect(findWorktreeRoots(samples, 'C:\\Users\\Dev\\.specrails\\worktrees\\ticket-1')).toEqual([])
  })
})

describe('shouldRecordSample', () => {
  it('[spec:mission-resources/server-recording-persists-bounded-mission-history] records while processes are live and once more when they drop to zero, never while idle', () => {
    expect(shouldRecordSample(null, { processCount: 0 })).toBe(false)
    expect(shouldRecordSample(null, { processCount: 3 })).toBe(true)
    expect(shouldRecordSample({ processCount: 3 }, { processCount: 0 })).toBe(true)
    expect(shouldRecordSample({ processCount: 0 }, { processCount: 0 })).toBe(false)
  })
})
