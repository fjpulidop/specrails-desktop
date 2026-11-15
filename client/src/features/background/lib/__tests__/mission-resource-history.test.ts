import { describe, expect, it } from 'vitest'
import { summarizeHistory, type ResourceSample } from '../mission-resource-history'

describe('mission resource history', () => {
  it('[spec:mission-resources/resource-history-remains-readable-after-activity-ends] summarizes the last active sample and the peaks', () => {
    const s: ResourceSample[] = [
      { at: 1, cpuPercent: 10, memoryBytes: 5, processCount: 1 },
      { at: 2, cpuPercent: 30, memoryBytes: 9, processCount: 2 },
      { at: 3, cpuPercent: 0, memoryBytes: 0, processCount: 0 },
    ]
    const sum = summarizeHistory(s)
    expect(sum.lastActive?.at).toBe(2)
    expect(sum.peakCpuPercent).toBe(30)
    expect(sum.peakMemoryBytes).toBe(9)
  })

  it('[spec:mission-resources/resource-history-remains-readable-after-activity-ends] has no last active sample for an empty history', () => {
    expect(summarizeHistory([])).toEqual({ lastActive: null, peakCpuPercent: 0, peakMemoryBytes: 0 })
  })
})
