// Which WebSocket messages are run-state changes worth saying aloud (BB4), and the
// i18n key + params that say them. Pure: LiveAnnouncer translates and speaks.

export type RunAnnouncementKind = 'started' | 'paused' | 'needsYou' | 'failed' | 'finished' | 'stopped' | 'reviewReady'

export interface RunAnnouncement {
  /** `common:a11y.announce.<kind>` (or `<kind>Rail` when a rail number is known). */
  kind: RunAnnouncementKind
  /** 1-based rail number when the run belongs to a rail. */
  rail: number | null
  /** The spec the run works on, when the message names exactly one. */
  ticketId: number | null
  /** Dedupe key: the same state of the same run is said once. */
  key: string
  /** Extra detail slot (pause reason kind). */
  detail?: 'budget' | 'limit'
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}
function ticketOf(m: Record<string, unknown>): number | null {
  if (typeof m.ticketId === 'number' && Number.isInteger(m.ticketId) && m.ticketId > 0) return m.ticketId
  const ids = Array.isArray(m.ticketIds) ? m.ticketIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0) : []
  return ids.length === 1 ? ids[0]! : null
}
function railOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v + 1 : null
}

/** Null when the message is not a run-state change, or belongs to another project. */
export function runAnnouncementFor(msg: unknown, activeProjectId: string | null): RunAnnouncement | null {
  if (!activeProjectId || !msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>
  if (m.projectId !== activeProjectId) return null
  const type = str(m.type)
  if (!type) return null
  const run = str(m.jobId) ?? str(m.loopRunId) ?? str(m.runId) ?? ''
  const mk = (kind: RunAnnouncementKind, rail: number | null, id: string, detail?: RunAnnouncement['detail']): RunAnnouncement =>
    ({ kind, rail, ticketId: ticketOf(m), key: `${kind}:${id}`, ...(detail ? { detail } : {}) })

  switch (type) {
    case 'rail.job_started': return mk('started', railOf(m.railIndex), run)
    case 'loop.run_started': return mk('started', railOf(m.railIndex), run)
    case 'rail.job_stopped': return mk('stopped', railOf(m.railIndex), run)
    case 'loop.run_stopped': return mk('stopped', railOf(m.railIndex), run)
    case 'rail.job_completed':
      return mk(m.status === 'failed' ? 'failed' : 'finished', railOf(m.railIndex), run)
    case 'loop.run_completed': {
      const status = str(m.status)
      if (status === 'failed') return mk('failed', railOf(m.railIndex), run)
      if (status === 'stopped') return mk('stopped', railOf(m.railIndex), run)
      return mk('finished', railOf(m.railIndex), run)
    }
    case 'loop.run_paused':
      return m.pauseKind === 'budget_paused'
        ? mk('paused', railOf(m.railIndex), run, 'budget')
        : mk('needsYou', railOf(m.railIndex), run)
    case 'loop.provider_limit': return mk('paused', null, run, 'limit')
    case 'job.stuck': return mk('needsYou', null, run)
    case 'rail.pr_state': {
      const id = str(m.prDeliveryId) ?? run
      const rail = railOf(m.railIndex)
      if (m.decision === 'on_review' || m.decision === 'pr_ready') return mk('reviewReady', rail, id)
      if (m.decision === 'implementation_failed' || m.decision === 'pr_failed') return mk('failed', rail, id)
      return null
    }
    default: return null
  }
}
