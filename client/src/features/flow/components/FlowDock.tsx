// ─── Flow dock (missions ConversationDock slot) ───────────────────────────────
// The Flow's runs live in the mission's run strip (FlowLiveRuns). What stays
// in the dock is a polite live region announcing the Flow's state changes
// (active, paused, needs review, handed off, back in Flow, delivered,
// discarded) for assistive technology.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MissionConversationSlotProps } from '../../missions/context/MissionExtensionsContext'
import { useConversationFlow, useFlowContext } from '../context/FlowContext'
import type { Flow } from '../lib/flow-api'

/** The announcement for a Flow state change (null when nothing worth saying changed). */
export function flowStateAnnouncement(previous: Flow['state'] | null, next: Flow['state']): string | null {
  if (previous === next) return null
  if (previous === 'handed_off' && (next === 'active' || next === 'paused')) return 'returned'
  if (previous === null) return null
  if (next === 'active' || next === 'paused' || next === 'needs-review' || next === 'handed_off' || next === 'delivered' || next === 'discarded') return next
  return null
}

/** Polite, visually hidden announcement of the Flow's state changes. */
function FlowStateAnnouncer({ flow }: { flow: Flow | null }) {
  const { t } = useTranslation('agent')
  const previous = useRef<{ id: string; state: Flow['state'] } | null>(null)
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (!flow) return
    const before = previous.current && previous.current.id === flow.id ? previous.current.state : null
    previous.current = { id: flow.id, state: flow.state }
    const key = flowStateAnnouncement(before, flow.state)
    if (key) setMessage(t(`flow.announce.${key}`))
  }, [flow, t])
  return <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="flow-state-announcer">{message}</div>
}

/** The missions ConversationDock slot: the Flow's polite state announcer (runs live in the strip). */
export function FlowDock({ conversationId, projectId }: MissionConversationSlotProps) {
  const ctx = useFlowContext()
  const { flow } = useConversationFlow(conversationId, projectId)
  return <FlowStateAnnouncer flow={ctx && projectId ? flow : null} />
}
