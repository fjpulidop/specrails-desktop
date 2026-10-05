import type { EventRow } from '../../../types'

const OUTPUT_LIMIT = 8_000
const LIFECYCLE_TYPES = new Set([
  'loop_graph', 'runtime-graph', 'loop_step', 'loop_step_end', 'loop_completion',
  'workflow-event', 'runtime-result', 'runtime-efficiency-event', 'result',
])

export interface JobEventBuffer {
  events: EventRow[]
  omitted: boolean
}

/** Raw verification frames have a separate readable log projection and durable
 * evidence. Keeping them here only crowds out events the job views consume. */
export function isJobDisplayEvent(event: EventRow): boolean {
  return event.event_type !== 'verification-output'
}

/** Bound ordinary output, never workflow structure. Preserve arrival order:
 * live log frames can have synthetic ids/seqs and must not be re-sorted. */
export function retainJobEvents(events: readonly EventRow[], omitted = false): JobEventBuffer {
  const retained: EventRow[] = []
  let remaining = OUTPUT_LIMIT
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!isJobDisplayEvent(event)) continue
    if (LIFECYCLE_TYPES.has(event.event_type)) retained.push(event)
    else if (remaining > 0) { retained.push(event); remaining-- }
    else omitted = true
  }
  return { events: retained.reverse(), omitted }
}

/** Presentation only: this notice is copied with the retained view, never
 * persisted or counted against its output budget. */
export function jobEventsWithNotice(buffer: JobEventBuffer, notice: string): EventRow[] {
  if (!buffer.omitted || !buffer.events.length) return buffer.events
  return [{ ...buffer.events[0], id: -1, seq: -1, event_type: 'log', source: 'stdout', payload: JSON.stringify({ line: notice }) }, ...buffer.events]
}
