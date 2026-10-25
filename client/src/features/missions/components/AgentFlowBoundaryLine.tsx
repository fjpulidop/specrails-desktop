// ─── Flow mode boundaries in the history ──────────────────────────────────────
// A server-authored `flow-boundary` row marks where the conversation entered
// Flow (started) or left it (handed off to a rail, discarded, closed keeping
// its branch). Each renders as
// ONE event line in its chronological slot; the agent turns between an
// "entered" and the next "left" carry a discreet Flow mark. The way back from
// a rail ("returned") is told by the Back to Flow line, so its boundary only
// marks the turns.

import { useTranslation } from 'react-i18next'
import { LogIn, LogOut } from 'lucide-react'
import type { AgentMessage } from '../lib/agent-api'
import { AgentRunEventLine } from './AgentRunEventLine'

export interface FlowBoundaryRow {
  kind: 'flow-boundary'
  flowId: string
  event: 'entered' | 'left'
  reason: 'started' | 'returned' | 'handed_off' | 'discarded' | 'closed'
  branch: string | null
}

const EVENTS = new Set(['entered', 'left'])
const REASONS = new Set(['started', 'returned', 'handed_off', 'discarded', 'closed'])

/** Parse a system row; null when it is not a Flow boundary. */
export function parseFlowBoundaryRow(content: string): FlowBoundaryRow | null {
  if (!content.startsWith('{')) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(content) as Record<string, unknown> } catch { return null }
  if (!o || o.kind !== 'flow-boundary' || typeof o.flowId !== 'string' || !o.flowId) return null
  if (typeof o.event !== 'string' || !EVENTS.has(o.event) || typeof o.reason !== 'string' || !REASONS.has(o.reason)) return null
  return {
    kind: 'flow-boundary',
    flowId: o.flowId,
    event: o.event as FlowBoundaryRow['event'],
    reason: o.reason as FlowBoundaryRow['reason'],
    branch: typeof o.branch === 'string' && o.branch.trim() ? o.branch : null,
  }
}

/** Message ids of the agent turns produced while the conversation was in Flow. */
export function flowTurnMessageIds(messages: readonly AgentMessage[]): ReadonlySet<string> {
  const ids = new Set<string>()
  let inFlow = false
  for (const message of messages) {
    if (message.role === 'system') {
      const boundary = parseFlowBoundaryRow(message.content)
      if (boundary) inFlow = boundary.event === 'entered'
      continue
    }
    if (inFlow && message.role === 'assistant') ids.add(message.id)
  }
  return ids
}

export function AgentFlowBoundaryLine({ row }: { row: FlowBoundaryRow }) {
  const { t } = useTranslation('agent')
  if (row.reason === 'returned') return null
  const entered = row.event === 'entered'
  return (
    <AgentRunEventLine
      icon={entered ? LogIn : LogOut}
      tone="flow"
      testId="agent-flow-boundary"
      attributes={{ 'data-event': row.event, 'data-reason': row.reason }}
      detail={entered ? row.branch ?? undefined : t(`flowBoundary.reason.${row.reason}`)}
    >
      {entered ? t('flowBoundary.entered') : t('flowBoundary.left')}
    </AgentRunEventLine>
  )
}
