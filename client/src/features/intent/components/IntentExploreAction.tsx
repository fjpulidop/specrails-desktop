// ─── Explore path of a settled intent card (intent-mode) ───────────────────────
// Plugged into the missions seam as `IntentExplore`: the intent card shows this
// next to Delegate with equal weight. Choosing it opens the usual entry
// confirmation (IntentEntryCard: isolated worktree, repository, availability)
// in place; Start creates the Intent session from the intent, whose placeholder
// spec carries it and whose first turn is seeded with it. Once the mission is
// in Intent the action becomes a quiet status line.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Waves } from 'lucide-react'
import type { MissionIntentExploreProps } from '../../missions/context/MissionExtensionsContext'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import { useConversationFlow } from '../context/IntentContext'
import { isOpenFlow } from '../lib/intent-api'
import { IntentEntryCard } from './IntentEntryCard'

export function IntentExploreAction({ projectId, conversationId, intent, title, disabled }: MissionIntentExploreProps) {
  const { t } = useTranslation('agent')
  const { active } = useAgentChat()
  const { flow } = useConversationFlow(conversationId, projectId)
  const [entry, setEntry] = useState(false)

  if (isOpenFlow(flow)) {
    return (
      <div data-testid="intent-explore-in-intent" className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-surface/40 p-2.5 text-caption text-muted-foreground sm:col-span-2">
        <Waves className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t('intentDraft.inIntent')}
      </div>
    )
  }

  if (entry) {
    return (
      <div className="sm:col-span-2">
        <IntentEntryCard
          idea={intent.problem}
          title={title ?? null}
          intent={intent}
          projectId={projectId}
          conversationId={conversationId}
          provider={active?.id === conversationId ? active?.provider : null}
          onStarted={() => setEntry(false)}
          onCancel={() => setEntry(false)}
        />
      </div>
    )
  }

  return (
    <button
      type="button"
      data-testid="intent-explore-action"
      disabled={disabled}
      onClick={() => setEntry(true)}
      className="group flex flex-col items-start gap-1 rounded-lg border border-border/60 bg-surface/50 p-2.5 text-left transition-colors hover:border-accent-primary/45 hover:bg-accent-primary/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50 disabled:cursor-default disabled:opacity-60"
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <Waves className="h-3.5 w-3.5" aria-hidden="true" />
        {t('intentDraft.explore')}
      </span>
      <span className="text-caption text-muted-foreground">{t('intentDraft.exploreHint')}</span>
    </button>
  )
}
