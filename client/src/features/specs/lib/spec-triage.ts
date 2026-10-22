/**
 * Spec triage (launch-triage) — client mirror of the server record stored in
 * `ticket.metadata.triage` (server/modules/specs/domain/triage.ts) plus the
 * helpers the spec card, the rail header and the mission rail card share.
 */
import { getApiBase } from '../../../lib/api'

export type TriageSize = 'XS' | 'S' | 'M' | 'L' | 'XL'
export type TriageConfidence = 'high' | 'medium' | 'low'

export interface SpecTriageReady {
  status: 'ready'
  size: TriageSize
  filesLikely: string[]
  publicInterfaces: boolean
  dataModel: boolean
  securitySurface: boolean
  recommendedLoop: string
  recommendedLoopName?: string
  recommendedMode: 'implement' | 'flow'
  rationale: string
  confidence: TriageConfidence
  inputsHash: string
  model: string
  costUsd: number | null
  computedAt: string
}

export interface SpecTriageUnavailable {
  status: 'unavailable'
  reason: string
  inputsHash: string
  computedAt: string
}

export interface SpecTriageFailed {
  status: 'failed'
  error: string
  inputsHash: string
  model: string
  costUsd: number | null
  computedAt: string
}

export type SpecTriage = SpecTriageReady | SpecTriageUnavailable | SpecTriageFailed

const SIZES = new Set(['XS', 'S', 'M', 'L', 'XL'])

/** The ready triage of a ticket, tolerating malformed or legacy metadata. */
export function readyTriage(ticket: { metadata?: { triage?: unknown } } | null | undefined): SpecTriageReady | null {
  const triage = ticket?.metadata?.triage as Partial<SpecTriageReady> | undefined
  if (!triage || triage.status !== 'ready' || !SIZES.has(String(triage.size)) || typeof triage.recommendedLoop !== 'string') return null
  return triage as SpecTriageReady
}

/** Any triage record (ready / unavailable / failed), or null. */
export function anyTriage(ticket: { metadata?: { triage?: unknown } } | null | undefined): SpecTriage | null {
  const triage = ticket?.metadata?.triage as { status?: unknown } | undefined
  if (!triage || (triage.status !== 'ready' && triage.status !== 'unavailable' && triage.status !== 'failed')) return null
  return triage.status === 'ready' ? readyTriage(ticket) : (triage as SpecTriage)
}

/** Same rule as the server: the first ready triage in rail order. */
export function recommendedLoopForTickets(tickets: Array<{ metadata?: { triage?: unknown } } | null | undefined>): string | null {
  for (const ticket of tickets) {
    const triage = readyTriage(ticket)
    if (triage) return triage.recommendedLoop
  }
  return null
}

/** POST /tickets/:id/triage — forced recalculation. Resolves the stored record. */
export async function recalculateSpecTriage(ticketId: number, base: string = getApiBase()): Promise<SpecTriage> {
  const res = await fetch(`${base}/tickets/${ticketId}/triage`, { method: 'POST' })
  const body = await res.json().catch(() => ({})) as { triage?: SpecTriage; error?: string }
  if (!res.ok || !body.triage) throw new Error(body.error || `triage_failed_${res.status}`)
  return body.triage
}
