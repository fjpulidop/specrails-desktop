import type { ResourceSample } from './mission-resources-api'

export type { ResourceSample }

export interface ResourceHistorySummary {
  /** Last sample taken while the mission still had live processes. */
  lastActive: ResourceSample | null
  peakCpuPercent: number
  peakMemoryBytes: number
}

export function summarizeHistory(samples: ResourceSample[]): ResourceHistorySummary {
  let lastActive: ResourceSample | null = null
  let peakCpuPercent = 0
  let peakMemoryBytes = 0
  for (const s of samples) {
    if (s.processCount > 0) lastActive = s
    if (s.cpuPercent > peakCpuPercent) peakCpuPercent = s.cpuPercent
    if (s.memoryBytes > peakMemoryBytes) peakMemoryBytes = s.memoryBytes
  }
  return { lastActive, peakCpuPercent, peakMemoryBytes }
}
