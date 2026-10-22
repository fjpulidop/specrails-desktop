// Flow mode on the board: "In Flow" is a LABEL computed from ticket metadata,
// never a status — the ticket stays `in_progress` and everything that reads the
// status is unchanged. `delivered` (or no metadata) ⇒ no label.

import type { LocalTicket } from '../../../types'

export interface SpecFlowLabel {
  state: 'active' | 'paused'
  conversationId: string | null
}

export function specFlowLabel(ticket: Pick<LocalTicket, 'metadata'>): SpecFlowLabel | null {
  const flow = ticket.metadata?.flow
  if (!flow || (flow.state !== 'active' && flow.state !== 'paused')) return null
  return { state: flow.state, conversationId: typeof flow.conversationId === 'string' && flow.conversationId ? flow.conversationId : null }
}
