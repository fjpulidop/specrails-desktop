import { describe, expect, it, vi } from 'vitest'
import { createAppResourcesSampler } from './app-resources'
import { cacheProcessTableReader } from './resource-sampler'
import type { ProcessSample } from '../domain/mission-resources'

const table: ProcessSample[] = [
  { pid: 100, ppid: 1, cpuPercent: 2, rssBytes: 1000, command: 'node server' },
  { pid: 101, ppid: 100, cpuPercent: 3, rssBytes: 500, command: 'git status' },
]

describe('createAppResourcesSampler', () => {
  it('reads one table per snapshot and keeps a bounded history while polled', async () => {
    let now = 1_000
    const read = vi.fn(async () => table)
    const listRoots = vi.fn(() => [])
    const sampler = createAppResourcesSampler({ readProcessTable: read, listRoots, serverPid: 100, now: () => now, historySize: 3 })

    const first = await sampler.snapshot()
    expect(read).toHaveBeenCalledTimes(1)
    expect(listRoots).toHaveBeenCalledWith(table)
    expect(first).toMatchObject({ measuredAt: 1_000, supported: true, totals: { cpuPercent: 5, memoryBytes: 1500, processCount: 2 } })
    expect(first.categories.map((c) => c.id)).toEqual(['git', 'server'])
    expect(first.history).toHaveLength(1)

    now += 500 // closer than the history interval: no new point
    expect((await sampler.snapshot()).history).toHaveLength(1)
    for (let i = 0; i < 5; i++) { now += 3_000; await sampler.snapshot() }
    const bounded = await sampler.snapshot()
    expect(bounded.history).toHaveLength(3)
    expect(bounded.history[2].at).toBeLessThanOrEqual(now)

    now += 60_000 // nobody polled for a while: start over
    expect((await sampler.snapshot()).history).toHaveLength(1)
  })

  it('reports an unsupported platform without history points', async () => {
    const sampler = createAppResourcesSampler({ readProcessTable: async () => null, listRoots: () => [], serverPid: 100 })
    expect(await sampler.snapshot()).toMatchObject({ supported: false, categories: [], history: [], totals: { processCount: 0 } })
  })
})

describe('cacheProcessTableReader', () => {
  it('shares in-flight reads and reuses a fresh result', async () => {
    let now = 0
    const read = vi.fn(async () => table)
    const cached = cacheProcessTableReader(read, () => now, 500)
    await Promise.all([cached(), cached()])
    expect(read).toHaveBeenCalledTimes(1)
    now = 400
    await cached()
    expect(read).toHaveBeenCalledTimes(1)
    now = 600
    await cached()
    expect(read).toHaveBeenCalledTimes(2)
  })
})
