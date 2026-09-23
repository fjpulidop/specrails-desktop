import type { DbInstance } from '../../../db/types'
import type { ProviderAdapter, AdapterEvent } from '../../../providers'
import { parseStreamEvents } from '../../../providers/runtime'
import { finaliseInvocationResult } from '../../accounting/runtime/result-event'
import type { DurableUsageRow, UsageRecoveryPorts } from '../ports'

/** Project-bound SQLite/provider adapter; never starts a transaction or buffers all events. */
export function createDurableUsageReader(db: DbInstance, jobId: string, adapter: ProviderAdapter): UsageRecoveryPorts<AdapterEvent> {
  return {
    events(mode, afterSeq) {
      if (mode === 'results') return db.prepare(`
        SELECT seq, event_type, payload FROM events
         WHERE job_id = ? AND source = 'stdout' AND event_type = 'result'
         ORDER BY seq, id
      `).iterate(jobId) as Iterable<DurableUsageRow>
      if (mode === 'tail') return db.prepare(`
        SELECT seq, event_type, payload FROM events
         WHERE job_id = ? AND source = 'stdout' AND event_type != 'log' AND seq > ?
         ORDER BY seq, id
      `).iterate(jobId, afterSeq) as Iterable<DurableUsageRow>
      return db.prepare(`
        SELECT seq, event_type, payload FROM events
         WHERE job_id = ? AND source = 'stdout' AND event_type != 'log'
         ORDER BY seq, id
      `).iterate(jobId) as Iterable<DurableUsageRow>
    },
    parse: payload => parseStreamEvents(adapter, payload),
    normalize: (event, fallbackModel) => finaliseInvocationResult(adapter, [event], { fallbackModel }),
    messageId(event) {
      const raw = event.kind === 'other' ? event.raw : null
      const message = raw && typeof raw.message === 'object' && raw.message
        ? raw.message as Record<string, unknown> : null
      return (event as AdapterEvent & { messageId?: string }).messageId ?? (
        message && typeof message.id === 'string' ? message.id : undefined
      )
    },
    malformedEvent: error => console.warn(`[queue-manager] ignored malformed durable event for ${jobId}:`, error),
  }
}
