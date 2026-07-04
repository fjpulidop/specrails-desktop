import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Pin, ChevronDown, ChevronUp, GitPullRequest } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AgentPrDecisionEnvelope, AgentPrDecisionValue } from '../../lib/agent-api'
import { AgentPrDecisionCard } from './AgentPrDecisionCard'
import type { PinnedPrCard } from './agent-pr-pinning'

const PILL_TONE: Record<AgentPrDecisionValue, string> = {
  building: 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary',
  on_review: 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary',
  pr_draft: 'border-accent-info/40 bg-accent-info/10 text-accent-info',
  pr_ready: 'border-accent-info/40 bg-accent-info/10 text-accent-info',
  pr_failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  merged: 'border-accent-success/40 bg-accent-success/10 text-accent-success',
  discarded: 'border-border/60 bg-surface/60 text-foreground/50',
}

/** Compact decision-state pill — shared by the pinned dock (chips + collapsed
 *  bar) and the history reference marker. */
export function PrDecisionPill({ decision }: { decision: AgentPrDecisionValue }) {
  const { t } = useTranslation('agent')
  return (
    <span
      data-testid="pr-decision-pill"
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide',
        PILL_TONE[decision],
      )}
    >
      {t(`prCard.pinned.state.${decision}`)}
    </span>
  )
}

// Collapse-to-chip is per conversation and SESSION-ONLY by design (never
// localStorage): a fresh app session re-surfaces every attention-demanding card.
const collapseKey = (conversationId: string) =>
  `specrails-desktop:agent-pr-dock-collapsed:${conversationId}`

function readCollapsed(conversationId: string): boolean {
  try {
    return sessionStorage.getItem(collapseKey(conversationId)) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(conversationId: string, collapsed: boolean): void {
  try {
    if (collapsed) sessionStorage.setItem(collapseKey(conversationId), '1')
    else sessionStorage.removeItem(collapseKey(conversationId))
  } catch {
    /* storage unavailable — collapse stays component-local */
  }
}

/**
 * The pinned implementation-card slot rendered just above the chat composer
 * (both the floating panel and the Agent-Mode inline surface, via
 * `AgentConversationView`). Shows the FULL `AgentPrDecisionCard` for the newest
 * attention-demanding delivery; additional active deliveries stack as a compact
 * chip row above it (click a chip to expand that card in place). A subtle
 * chevron collapses the whole dock to a slim bar. Purely presentational — the
 * pinned set is derived upstream from the conversation's system rows.
 */
export function AgentPrPinnedDock({
  pinned,
  conversationId,
  inline,
}: {
  /** Message-ordered pinned cards — newest LAST (from `derivePrCards`). */
  pinned: PinnedPrCard[]
  conversationId: string
  /** Agent-Mode inline surface (centers to the composer column) vs floating panel. */
  inline: boolean
}) {
  const { t } = useTranslation('agent')
  const [collapsed, setCollapsed] = useState(() => readCollapsed(conversationId))
  // Chip-row expand-in-place pick; null = follow the newest pinned card.
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Collapse + pick are per conversation — re-read/reset on mission switch.
  useEffect(() => {
    setCollapsed(readCollapsed(conversationId))
    setSelectedId(null)
  }, [conversationId])

  if (pinned.length === 0) return null // parent gates; defensive
  const newest = pinned[pinned.length - 1]
  // A stale pick (its card unpinned meanwhile) falls back to the newest.
  const expanded = pinned.find((p) => p.messageId === selectedId) ?? newest
  const others = pinned.filter((p) => p.messageId !== expanded.messageId)

  const setCollapsedPersist = (v: boolean) => {
    writeCollapsed(conversationId, v)
    setCollapsed(v)
  }

  const chipLabel = (e: AgentPrDecisionEnvelope): string => {
    const rail = t('prCard.rail', { index: e.railIndex + 1 })
    const tickets = e.ticketIds.map((id) => `#${id}`).join(' ')
    return tickets ? `${rail} · ${tickets}` : rail
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      data-testid="agent-pr-pinned-dock"
      className={cn('shrink-0', inline ? 'px-4 pb-2' : 'px-3 pb-2')}
    >
      <div className={cn(inline && 'mx-auto w-full max-w-[680px]')}>
        {collapsed ? (
          // Slim bar: everything minimized to one row — click re-expands.
          <button
            type="button"
            data-testid="agent-pr-dock-expand"
            data-agent-interactive
            onClick={() => setCollapsedPersist(false)}
            aria-label={t('prCard.pinned.expand')}
            title={t('prCard.pinned.expand')}
            className="flex w-full items-center gap-2 rounded-xl border border-border/60 bg-card/80 px-3 py-1.5 text-xs text-foreground/70 shadow-lg backdrop-blur-xl transition-colors hover:border-accent-primary/40 hover:bg-surface/60"
          >
            <Pin className="h-3.5 w-3.5 shrink-0 text-accent-primary/70" />
            <span className="min-w-0 flex-1 truncate text-left">
              {t('prCard.pinned.collapsed', { count: pinned.length })}
            </span>
            <PrDecisionPill decision={newest.envelope.decision} />
            <ChevronUp className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </button>
        ) : (
          <div className="space-y-1.5">
            {/* Additional active deliveries — newest-first compact chips;
                clicking one expands it in place below. */}
            {others.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" data-testid="agent-pr-dock-chips">
                {[...others].reverse().map((p) => (
                  <button
                    key={p.messageId}
                    type="button"
                    data-testid="agent-pr-dock-chip"
                    data-agent-interactive
                    onClick={() => setSelectedId(p.messageId)}
                    title={t('prCard.pinned.showCard')}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-card/80 px-2 py-0.5 text-[11px] text-foreground/70 shadow backdrop-blur-xl transition-colors hover:border-accent-primary/40 hover:bg-surface/70"
                  >
                    <GitPullRequest className="h-3 w-3 shrink-0 text-accent-primary/70" />
                    <span className="max-w-[180px] truncate">{chipLabel(p.envelope)}</span>
                    <PrDecisionPill decision={p.envelope.decision} />
                  </button>
                ))}
              </div>
            )}
            {/* Slim pinned header + the FULL decision card (reused verbatim). */}
            <div className="flex items-center justify-between px-1">
              <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-foreground/45">
                <Pin className="h-3 w-3 text-accent-primary/60" />
                {t('prCard.pinned.label')}
              </span>
              <button
                type="button"
                data-testid="agent-pr-dock-collapse"
                data-agent-interactive
                onClick={() => setCollapsedPersist(true)}
                aria-label={t('prCard.pinned.collapse')}
                title={t('prCard.pinned.collapse')}
                className="rounded p-0.5 text-foreground/45 transition-colors hover:bg-surface hover:text-foreground"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            <AgentPrDecisionCard envelope={expanded.envelope} />
          </div>
        )}
      </div>
    </motion.div>
  )
}
