import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { focusPrCard, type RunFailureRow } from './agent-run-failure'
import { AgentContextInlineTokens } from './AgentMessage'
import type { AgentContextReference } from '../lib/agent-api'

/**
 * Compact destructive marker for a `run-failure` system row (mission-rail-cards):
 * "Rail N failed: <code>" + a one-line detail + "Open card", which focuses the
 * matching run/PR card in the pinned dock (or history) through the focus bus.
 * Deliberately NOT a second card — the card already carries the recovery
 * actions; this is the chronological trace of the moment it happened.
 */
export function AgentRunFailureMarker({ row }: { row: RunFailureRow }) {
  const { t } = useTranslation('agent')
  return (
    <div
      data-testid="agent-run-failure-marker"
      className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-1.5 text-[11px] text-foreground/70 backdrop-blur-sm"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-destructive">{t('runFailure.marker', { rail: row.railIndex + 1, code: row.code })}</span>
        {row.detail && <span className="text-foreground/55"> · {row.detail}</span>}
      </span>
      <button
        type="button"
        data-agent-interactive
        data-testid="agent-run-failure-open"
        onClick={() => focusPrCard({ prDeliveryId: row.prDeliveryId ?? null, runIds: [row.runId] })}
        className="shrink-0 rounded-md border border-destructive/35 px-2 py-0.5 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/10"
      >
        {t('runFailure.openCard')}
      </button>
    </div>
  )
}

/**
 * The automatic failure briefing the SERVER sent as a user turn: rendered as a
 * muted, collapsible chip instead of a person's speech bubble, so the
 * transcript never reads as if the user typed it.
 */
export function AgentSystemBriefing({ content, contextRefs }: { content: string; contextRefs?: AgentContextReference[] }) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  return (
    <div data-testid="agent-system-briefing" className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-agent-interactive
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-surface/50 px-2.5 py-1 text-[11px] text-foreground/60 transition-colors hover:border-accent-primary/40 hover:text-foreground/80',
        )}
      >
        <Sparkles className="h-3 w-3 text-accent-primary/70" aria-hidden />
        {t('runFailure.briefing.title')}
        {open ? <ChevronDown className="h-3 w-3 opacity-60" aria-hidden /> : <ChevronRight className="h-3 w-3 opacity-60" aria-hidden />}
      </button>
      {open && (
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm border border-border/40 bg-surface/40 px-3.5 py-2 text-xs text-foreground/70" data-testid="agent-system-briefing-body">
          <AgentContextInlineTokens content={content} contextRefs={contextRefs} />
        </div>
      )}
    </div>
  )
}
