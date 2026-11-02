import { useTranslation } from 'react-i18next'
import { Compass, Waves } from 'lucide-react'
import { Badge } from '../../../components/ui/badge'
import { openIntentQuestions } from '../lib/spec-intent'
import { specFlowLabel } from '../lib/spec-flow'
import type { LocalTicket } from '../../../types'

/**
 * Intent-mode badges shared by every board tier (`SpecCard` rows and
 * `TicketPostitCard` post-its): the compass counts the open questions in the
 * spec's intent; "In Intent" marks a placeholder spec that still belongs to
 * its Intent session. Both wear the intent lamp (`accent-intent`), never the
 * running (info) cyan, so they do not merge with the Jira key badge.
 */

interface IntentOpenBadgeProps {
  ticket: Pick<LocalTicket, 'id' | 'intent'>
  /** Extra classes for the tier's badge height/padding. */
  className?: string
}

export function IntentOpenBadge({ ticket, className = '' }: IntentOpenBadgeProps) {
  const { t } = useTranslation('specs')
  const count = openIntentQuestions(ticket.intent)
  if (count <= 0) return null
  const title = t('badges.intentOpenTitle', { count })
  return (
    <Badge
      variant="outline"
      className={`text-caption shrink-0 gap-0.5 border-accent-intent/50 text-accent-intent bg-accent-intent/10 ${className}`}
      title={title}
      data-testid={`intent-open-badge-${ticket.id}`}
    >
      <Compass className="h-3 w-3" aria-hidden="true" />
      {count}
      <span className="sr-only"> ({title})</span>
    </Badge>
  )
}

interface InIntentBadgeProps {
  ticket: Pick<LocalTicket, 'id' | 'metadata'>
  /** Opens the mission conversation of the Intent session. */
  onOpenFlow?: (conversationId: string) => void
  /** Rendered inside a rail: the spec there was handed off, so no label. */
  onRail?: boolean
  className?: string
}

export function InIntentBadge({ ticket, onOpenFlow, onRail = false, className = '' }: InIntentBadgeProps) {
  const { t } = useTranslation('specs')
  const flowLabel = onRail ? null : specFlowLabel(ticket)
  if (!flowLabel) return null
  const paused = flowLabel.state === 'paused'
  const open = () => { if (flowLabel.conversationId) onOpenFlow?.(flowLabel.conversationId) }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); open() }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation()
          e.preventDefault()
          open()
        }
      }}
      disabled={!flowLabel.conversationId || !onOpenFlow}
      data-flow-label={flowLabel.state}
      data-testid={`flow-badge-${ticket.id}`}
      title={t(paused ? 'badges.inFlowPausedTitle' : 'badges.inFlowTitle')}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-caption font-semibold transition-colors disabled:cursor-default ${
        paused
          ? 'border-border/60 bg-surface/60 text-muted-foreground hover:border-foreground/30'
          : 'border-accent-intent/50 bg-accent-intent/10 text-accent-intent hover:bg-accent-intent/20'
      } ${className}`}
    >
      <Waves className="h-3 w-3" aria-hidden />
      {t(paused ? 'badges.inFlowPaused' : 'badges.inFlow')}
    </button>
  )
}
