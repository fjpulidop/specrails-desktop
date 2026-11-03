// ─── Intent dock (missions ConversationDock slot) ───────────────────────────────
// The Intent's runs live in the mission's run strip (IntentLiveRuns). What stays
// in the dock are the Intent's state announcements (active, paused, needs
// review, handed off, back in Intent, delivered, discarded, closed), said through the
// strip's ONE polite live region (`announce`) so nothing is announced twice.
// Intent cards in the conversation (the offer card's decision stub) speak
// through the same region via `announceFlow`: no second live region anywhere.

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { MissionConversationDockProps } from '../../missions/context/MissionExtensionsContext'
import { useConversationFlow, useFlowContext } from '../context/IntentContext'
import type { IntentSession } from '../lib/intent-api'

/** The announcement for an Intent session state change (null when nothing worth saying changed). */
export function flowStateAnnouncement(previous: IntentSession['state'] | null, next: IntentSession['state']): string | null {
  if (previous === next) return null
  if (previous === 'handed_off' && (next === 'active' || next === 'paused')) return 'returned'
  if (previous === null) return null
  if (next === 'active' || next === 'paused' || next === 'needs-review' || next === 'handed_off' || next === 'delivered' || next === 'discarded' || next === 'closed') return next
  return null
}

// ─── Announcement bus ───────────────────────────────────────────────────────────
// Cards outside the strip have no live region of their own; the mounted dock(s)
// forward their messages to the strip's announcer. Without a dock nothing is
// said (the card then relies on moving focus to the element that changed).
const docks = new Map<string, (message: string) => void>()

/** Say `message` through the run strip's polite live region of `conversationId` (false when no strip is mounted for it). */
export function announceFlow(conversationId: string | null | undefined, message: string): boolean {
  const announce = conversationId ? docks.get(conversationId) : undefined
  if (!announce || !message) return false
  announce(message)
  return true
}

/** Says the Intent's state changes through the run strip's one polite live region. */
function IntentStateAnnouncer({ flow, announce }: { flow: IntentSession | null; announce: (message: string) => void }) {
  const { t } = useTranslation('agent')
  const previous = useRef<{ id: string; state: IntentSession['state'] } | null>(null)
  useEffect(() => {
    if (!flow) return
    const before = previous.current && previous.current.id === flow.id ? previous.current.state : null
    previous.current = { id: flow.id, state: flow.state }
    const key = flowStateAnnouncement(before, flow.state)
    if (key) announce(t(`flow.announce.${key}`))
  }, [flow, t, announce])
  return null
}

/** The missions ConversationDock slot: the Intent's state announcements (runs live in the strip). */
export function IntentDock({ conversationId, projectId, announce }: MissionConversationDockProps) {
  const ctx = useFlowContext()
  const { flow } = useConversationFlow(conversationId, projectId)
  useEffect(() => {
    if (!conversationId) return
    docks.set(conversationId, announce)
    return () => { if (docks.get(conversationId) === announce) docks.delete(conversationId) }
  }, [conversationId, announce])
  return <IntentStateAnnouncer flow={ctx && projectId ? flow : null} announce={announce} />
}
