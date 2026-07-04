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

/** Compact decision-state pill — shared by the pinned dock (per-card headers +
 *  collapsed bar) and the history reference marker. */
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

// Collapse state is per conversation and SESSION-ONLY by design (never
// localStorage): a fresh app session re-surfaces every attention-demanding card.
const collapseKey = (conversationId: string) =>
  `specrails-desktop:agent-pr-dock-collapsed:${conversationId}`
const cardCollapseKey = (conversationId: string) =>
  `specrails-desktop:agent-pr-dock-card-collapsed:${conversationId}`

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

/** Per-card collapse picks, keyed by prDeliveryId (stable across WS updates). */
function readCollapsedCards(conversationId: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(cardCollapseKey(conversationId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeCollapsedCards(conversationId: string, ids: Set<string>): void {
  try {
    if (ids.size === 0) sessionStorage.removeItem(cardCollapseKey(conversationId))
    else sessionStorage.setItem(cardCollapseKey(conversationId), JSON.stringify([...ids]))
  } catch {
    /* storage unavailable — collapse stays component-local */
  }
}

/**
 * The pinned implementation-card slot rendered just above the chat composer
 * (both the floating panel and the Agent-Mode inline surface, via
 * `AgentConversationView`). EVERY attention-demanding delivery renders as its
 * own full `AgentPrDecisionCard`, stacked oldest→newest (newest adjacent to
 * the composer) — parallel rails each keep their own card, each advancing at
 * its own pace. Each card carries a slim per-card header (rail + tickets +
 * decision pill) with an independent collapse-to-header toggle; a dock-level
 * chevron collapses everything to one slim bar. Purely presentational — the
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
  const [collapsedCards, setCollapsedCards] = useState<Set<string>>(() =>
    readCollapsedCards(conversationId),
  )

  // Collapse state is per conversation — re-read on mission switch.
  useEffect(() => {
    setCollapsed(readCollapsed(conversationId))
    setCollapsedCards(readCollapsedCards(conversationId))
  }, [conversationId])

  if (pinned.length === 0) return null // parent gates; defensive
  const newest = pinned[pinned.length - 1]

  const setCollapsedPersist = (v: boolean) => {
    writeCollapsed(conversationId, v)
    setCollapsed(v)
  }

  const toggleCard = (deliveryId: string) => {
    setCollapsedCards((prev) => {
      const next = new Set(prev)
      if (next.has(deliveryId)) next.delete(deliveryId)
      else next.add(deliveryId)
      writeCollapsedCards(conversationId, next)
      return next
    })
  }

  const cardLabel = (e: AgentPrDecisionEnvelope): string => {
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
            {/* Dock header: pinned label (+ count) and the collapse-all chevron. */}
            <div className="flex items-center justify-between px-1">
              <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-foreground/45">
                <Pin className="h-3 w-3 text-accent-primary/60" />
                {t('prCard.pinned.label')}
                {pinned.length > 1 && (
                  <span className="rounded-full border border-border/60 bg-surface/60 px-1.5 py-px text-[9px] tabular-nums text-foreground/55">
                    {pinned.length}
                  </span>
                )}
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
            {/* Every pinned delivery stacks as its own full card — oldest→newest
                so the freshest one sits next to the composer. Scroll-bounded so
                many parallel rails never eat the whole viewport. */}
            <div
              data-testid="agent-pr-dock-stack"
              className="max-h-[45vh] space-y-1.5 overflow-y-auto overscroll-contain"
            >
              {pinned.map((p) => {
                const deliveryId = p.envelope.prDeliveryId
                const isCardCollapsed = collapsedCards.has(deliveryId)
                return (
                  <div key={p.messageId} data-testid="agent-pr-dock-card" className="space-y-1">
                    <button
                      type="button"
                      data-testid="agent-pr-dock-card-toggle"
                      data-agent-interactive
                      onClick={() => toggleCard(deliveryId)}
                      aria-expanded={!isCardCollapsed}
                      aria-label={t(isCardCollapsed ? 'prCard.pinned.expandCard' : 'prCard.pinned.collapseCard')}
                      title={t(isCardCollapsed ? 'prCard.pinned.expandCard' : 'prCard.pinned.collapseCard')}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg border px-2.5 py-1 text-[11px] text-foreground/70 transition-colors',
                        isCardCollapsed
                          ? 'border-border/60 bg-card/80 shadow backdrop-blur-xl hover:border-accent-primary/40 hover:bg-surface/70'
                          : 'border-transparent bg-transparent hover:bg-surface/50',
                      )}
                    >
                      <GitPullRequest className="h-3 w-3 shrink-0 text-accent-primary/70" />
                      <span className="min-w-0 flex-1 truncate text-left font-medium">
                        {cardLabel(p.envelope)}
                      </span>
                      <PrDecisionPill decision={p.envelope.decision} />
                      {isCardCollapsed ? (
                        <ChevronUp className="h-3 w-3 shrink-0 opacity-60" />
                      ) : (
                        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
                      )}
                    </button>
                    {!isCardCollapsed && <AgentPrDecisionCard envelope={p.envelope} />}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  )
}
