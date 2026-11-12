import { useEffect, useState } from 'react'
import { API_ORIGIN } from '../../../lib/origin'
import type { EventRow } from '../../../types'
import { groupByLoopStep, segmentStatus, stepDisplayTitle, type LoopStepSegment } from '../components/loop-log/loop-log-model'

/** The last failed step of a run that can be repeated from its exact attempt (a Core fork cut). */
export interface FailedStep { segment: LoopStepSegment; title: string }

export function lastFailedStep(events: EventRow[]): FailedStep | null {
  const model = groupByLoopStep(events)
  const { segments } = model
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index]!
    if (segmentStatus(segment, { isLast: index === segments.length - 1, jobSettled: true }) !== 'failed') continue
    const { nodePath, scopeId, iteration } = segment.meta
    if (!segment.end || !nodePath || !scopeId || iteration == null) return null
    // The graph's own label ("Developer"), else the step title of the log.
    const label = model.graphMeta?.runtimeTopology?.nodes.find(node => node.id === nodePath)?.label
    return { segment, title: label || stepDisplayTitle(segment.meta) }
  }
  return null
}

/** Reads a settled run's events once and finds the step to repeat from. Never throws; null when none. */
export function useLastFailedStep(projectId: string | null | undefined, runId: string | null | undefined, enabled: boolean): FailedStep | null {
  const [step, setStep] = useState<FailedStep | null>(null)
  useEffect(() => {
    setStep(null)
    if (!enabled || !projectId || !runId) return
    let live = true
    void fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(runId)}`)
      .then(response => response.ok ? response.json() as Promise<{ events?: EventRow[] }> : null)
      .then(data => { if (live && data?.events) setStep(lastFailedStep(data.events)) })
      .catch(() => { /* the card keeps "Run again" */ })
    return () => { live = false }
  }, [projectId, runId, enabled])
  return step
}
