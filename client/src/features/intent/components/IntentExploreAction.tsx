// ─── Explore path of a settled intent card (intent-mode) ───────────────────────
// Plugged into the missions seam as `IntentExplore`: the intent card shows this
// next to Delegate with equal weight. Choosing it opens the usual entry
// confirmation (IntentEntryCard: isolated worktree, repository, availability)
// in place; Start creates the Intent session from the intent, whose placeholder
// spec carries it and whose first turn is seeded with it. Once the mission is
// in Intent the action becomes a quiet status line.
//
// While the entry card is open the intent card hides its Delegate button (one
// primary at a time, and no Delegate at all once the mission is already in
// Intent — the spec then comes from the hand-off): `onExploreState` reports it.
//
// Focus never falls to the document: the entry card takes it when it mounts
// (its heading), Cancel hands it back to this button, and Start sends it to
// the Intent's strip once the strip shows the new session.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Waves } from 'lucide-react'
import type { MissionIntentExploreProps } from '../../missions/context/MissionExtensionsContext'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import { cn } from '../../../lib/utils'
import { useConversationFlow } from '../context/IntentContext'
import { isOpenFlow } from '../lib/intent-api'
import { IntentEntryCard, focusFlowBarWhenShown } from './IntentEntryCard'

/** What Explore occupies on the intent card: its entry card, or the whole paths block once the mission is in Intent. */
export type IntentExploreState = 'entry' | 'in-intent' | null

export interface IntentExploreActionProps extends MissionIntentExploreProps {
  /** The entry confirmation opened or closed (the intent card hides Delegate meanwhile). */
  onExploreState?: (state: IntentExploreState) => void
}

export function IntentExploreAction({ projectId, conversationId, intent, title, disabled, onExploreState }: IntentExploreActionProps) {
  const { t } = useTranslation('agent')
  const { active } = useAgentChat()
  const { flow } = useConversationFlow(conversationId, projectId)
  const [entry, setEntry] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  // Cancel closes the entry card: focus returns to the re-rendered Explore button.
  const returnFocus = useRef(false)

  const inIntent = isOpenFlow(flow)
  useEffect(() => {
    onExploreState?.(inIntent ? 'in-intent' : entry ? 'entry' : null)
    return () => onExploreState?.(null)
  }, [entry, inIntent, onExploreState])

  useEffect(() => {
    if (entry || !returnFocus.current) return
    returnFocus.current = false
    button.current?.focus({ preventScroll: true })
  }, [entry])

  if (inIntent) {
    return (
      <div data-testid="intent-explore-in-intent" className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-surface/40 p-2.5 text-caption text-muted-foreground @xl:col-span-2">
        <Waves className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t('intentDraft.inIntent')}
      </div>
    )
  }

  if (entry) {
    return (
      <div className="@xl:col-span-2">
        <IntentEntryCard
          idea={intent.problem}
          title={title ?? null}
          intent={intent}
          embedded
          projectId={projectId}
          conversationId={conversationId}
          provider={active?.id === conversationId ? active?.provider : null}
          onStarted={(started) => { setEntry(false); focusFlowBarWhenShown(started.id) }}
          onCancel={() => { returnFocus.current = true; setEntry(false) }}
        />
      </div>
    )
  }

  return (
    <button
      ref={button}
      type="button"
      data-testid="intent-explore-action"
      disabled={disabled}
      onClick={() => setEntry(true)}
      className={cn(
        // The same hover/focus tokens as Delegate: the two paths keep equal weight.
        'flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50',
        disabled
          ? 'cursor-default border-border/40 bg-surface/30 text-muted-foreground'
          : 'border-border/60 bg-surface/50 text-foreground hover:border-accent-primary/45 hover:bg-accent-primary/[0.06]',
      )}
    >
      <span className="flex items-center gap-1.5 text-label font-semibold">
        <Waves className="h-3.5 w-3.5" aria-hidden="true" />
        {t('intentDraft.explore')}
      </span>
      <span className="text-caption text-muted-foreground">{t('intentDraft.exploreHint')}</span>
    </button>
  )
}
