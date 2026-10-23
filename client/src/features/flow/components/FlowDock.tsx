// ─── Flow dock (missions ConversationDock slot) ───────────────────────────────
// The Flow's runs live in the mission's run strip (FlowLiveRuns). What stays
// in the dock are the Flow's state announcements (active, paused, needs
// review, handed off, back in Flow, delivered, discarded), said through the
// strip's ONE polite live region (`announce`) so nothing is announced twice.

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { MissionConversationDockProps } from '../../missions/context/MissionExtensionsContext'
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

/** Says the Flow's state changes through the run strip's one polite live region. */
function FlowStateAnnouncer({ flow, announce }: { flow: Flow | null; announce: (message: string) => void }) {
  const { t } = useTranslation('agent')
  const previous = useRef<{ id: string; state: Flow['state'] } | null>(null)
  useEffect(() => {
    if (!flow) return
    const before = previous.current && previous.current.id === flow.id ? previous.current.state : null
    previous.current = { id: flow.id, state: flow.state }
    const key = flowStateAnnouncement(before, flow.state)
    if (key) announce(t(`flow.announce.${key}`))
  }, [flow, t, announce])
  return null
}

/** The missions ConversationDock slot: the Flow's state announcements (runs live in the strip). */
export function FlowDock({ conversationId, projectId, announce }: MissionConversationDockProps) {
  const ctx = useFlowContext()
  const { flow } = useConversationFlow(conversationId, projectId)
  return <FlowStateAnnouncer flow={ctx && projectId ? flow : null} announce={announce} />
}
