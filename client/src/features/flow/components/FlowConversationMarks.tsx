// ─── Flow on the mission list (missions useConversationMarks / useRunAttention) ─
// The missions that are in Flow (open, paused or needing review) carry the
// same mark as their header: the Flow icon with "In Flow" (the board's
// wording) as text for assistive technology and the tooltip. Kept current per
// project by GET /flow/open plus the `flow.state` events.
// The same app-wide watch feeds the list's attention dot for Flow runs that
// wait for the person (flowNeedsPerson, the strip's own rule), so the dot is
// live and clears whether or not the mission is open.

import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Waves } from 'lucide-react'
import type { MissionConversationRef, MissionModeBadge } from '../../missions/context/MissionExtensionsContext'
import { useFlowContext } from '../context/FlowContext'
import { FLOW_ACCENT } from '../lib/flow-accent'
import { flowNeedsPerson } from '../lib/flow-run-tone'

/** Keep the in-Flow conversations of the listed missions' projects current. */
function useWatchOpenFlows(conversations: readonly MissionConversationRef[]): void {
  const watchOpen = useFlowContext()?.watchOpen
  const projectKey = [...new Set(conversations.map((conversation) => conversation.pinned_project_id).filter((id): id is string => !!id))].sort().join('\u0000')
  useEffect(() => {
    if (!watchOpen || !projectKey) return
    const releases = projectKey.split('\u0000').map((projectId) => watchOpen(projectId))
    return () => { for (const release of releases) release() }
  }, [watchOpen, projectKey])
}

export function useFlowConversationMarks(conversations: readonly MissionConversationRef[]): ReadonlyMap<string, MissionModeBadge> {
  const { t } = useTranslation(['agent', 'specs'])
  const ctx = useFlowContext()
  useWatchOpenFlows(conversations)
  const open = ctx?.openConversations
  return useMemo(() => {
    const marks = new Map<string, MissionModeBadge>()
    if (!open) return marks
    const badge: MissionModeBadge = { label: t('specs:badges.inFlow'), description: t('agent:flow.mode.description'), icon: Waves, accent: FLOW_ACCENT }
    for (const conversation of conversations) {
      if (conversation.pinned_project_id && open.get(conversation.pinned_project_id)?.has(conversation.id)) marks.set(conversation.id, badge)
    }
    return marks
  }, [open, conversations, t])
}

const NO_ATTENTION: ReadonlyMap<string, ReadonlySet<string>> = new Map()

/** Flow runs waiting for the person, per listed mission (keyed like the strip entry: `flow`). */
export function useFlowRunAttention(conversations: readonly MissionConversationRef[]): ReadonlyMap<string, ReadonlySet<string>> {
  const ctx = useFlowContext()
  useWatchOpenFlows(conversations)
  const open = ctx?.openConversations
  return useMemo(() => {
    if (!open) return NO_ATTENTION
    const attention = new Map<string, ReadonlySet<string>>()
    for (const conversation of conversations) {
      const state = conversation.pinned_project_id ? open.get(conversation.pinned_project_id)?.get(conversation.id) : undefined
      if (state && flowNeedsPerson(state)) attention.set(conversation.id, FLOW_RUN_KEYS)
    }
    return attention.size ? attention : NO_ATTENTION
  }, [open, conversations])
}
const FLOW_RUN_KEYS: ReadonlySet<string> = new Set(['flow'])
