// ─── "In Flow" on the mission list (missions useConversationMarks slot) ───────
// The missions that are in Flow (open, paused or needing review) carry the
// same mark as their header: the Flow icon with "In Flow" (the board's
// wording) as text for assistive technology and the tooltip. Kept current per
// project by GET /flow/open plus the `flow.state` events.

import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Waves } from 'lucide-react'
import type { MissionConversationRef, MissionModeBadge } from '../../missions/context/MissionExtensionsContext'
import { useFlowContext } from '../context/FlowContext'
import { FLOW_ACCENT } from '../lib/flow-accent'

export function useFlowConversationMarks(conversations: readonly MissionConversationRef[]): ReadonlyMap<string, MissionModeBadge> {
  const { t } = useTranslation(['agent', 'specs'])
  const ctx = useFlowContext()
  const watchOpen = ctx?.watchOpen
  const projectKey = [...new Set(conversations.map((conversation) => conversation.pinned_project_id).filter((id): id is string => !!id))].sort().join('\u0000')
  useEffect(() => {
    if (!watchOpen || !projectKey) return
    const releases = projectKey.split('\u0000').map((projectId) => watchOpen(projectId))
    return () => { for (const release of releases) release() }
  }, [watchOpen, projectKey])
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
