import { describe, expect, it } from 'vitest'
import { createCrashNotices, createProblemReports } from './application'
import type { CrashMarker } from './domain'
import type { CrashMarkerStore } from './ports'

const sources = {
  versions: { app: '1', core: null, api: null, contractSchema: null },
  system: { platform: 'linux', release: '6', arch: 'x64', node: 'v22', uptimeSec: 1, rssBytes: 1, cpuCount: 1, totalMemoryBytes: 1 },
  desktopHost: false, projectCount: 0, settings: [], serverLog: 'log', sidecarLog: null, desktopLog: null, crashes: [],
  stalls: { thresholdMs: 200, sampling: false, sinceMs: 0, total: 0, longestMs: 0, recent: [] },
}

describe('problem reports', () => {
  it('keeps the previewed files unchanged until they expire', async () => {
    let now = 1_000
    let serverLog = 'first'
    let ids = 0
    const reports = createProblemReports({ collect: async () => ({ ...sources, serverLog }), redact: t => t, newId: () => `r${++ids}`, now: () => now, ttlMs: 100 })
    const preview = await reports.preview()
    serverLog = 'second'
    expect(reports.get(preview.id)?.files.find(f => f.name === 'server.log')?.content).toBe('first')
    now += 101
    expect(reports.get(preview.id)).toBeUndefined()
  })

  it('keeps at most three previews', async () => {
    let ids = 0
    const reports = createProblemReports({ collect: async () => sources, redact: t => t, newId: () => `r${++ids}` })
    for (let i = 0; i < 4; i++) await reports.preview()
    expect(reports.get('r1')).toBeUndefined()
    expect(reports.get('r4')).toBeDefined()
  })
})

describe('crash notices', () => {
  const marker = (atMs: number): CrashMarker => ({ version: 1, id: `${atMs}-1`, atMs, at: '', pid: 1, exitCode: null, signal: 9, uptimeMs: 0, wasReady: false, outcome: 'stopped', recentRestarts: 3, maxRestarts: 3, windowSecs: 60, stderrTail: [] })
  function store(markers: CrashMarker[], available = true): CrashMarkerStore & { through: number } {
    return { available, through: 0, list: () => markers, acknowledgedThrough() { return this.through }, acknowledge(ms) { this.through = ms } }
  }

  it('lists unexplained crashes and acknowledges them', () => {
    const s = store([marker(10), marker(20)])
    const notices = createCrashNotices(s)
    expect(notices.list().notices.map(n => n.atMs)).toEqual([10, 20])
    expect(notices.acknowledge(20)).toEqual({ acknowledgedThroughMs: 20 })
    expect(notices.list()).toEqual({ available: true, acknowledgedThroughMs: 20, notices: [] })
  })

  it('is empty and never writes outside the desktop app', () => {
    const s = store([marker(10)], false)
    const notices = createCrashNotices(s)
    expect(notices.list()).toEqual({ available: false, acknowledgedThroughMs: 0, notices: [] })
    notices.acknowledge(10)
    expect(s.through).toBe(0)
  })
})
