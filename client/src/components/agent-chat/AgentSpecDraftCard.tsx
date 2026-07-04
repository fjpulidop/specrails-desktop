// ─── In-conversation live spec-draft card ──────────────────────────────────────
// Renders the agent's fenced ```spec-draft snapshot (see agent-spec-draft.ts)
// as a premium card: title, priority pill, labels, expandable description and
// the acceptance-criteria checklist. Purely presentational — the draft is
// authoritative in the conversation text; committing goes through the agent's
// commit_draft flow, not this card.

import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles, ChevronDown, ChevronUp, CheckCircle2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import type { SpecDraft, SpecDraftPriority } from '../../lib/spec-draft'

const PRIORITY_PILL: Record<SpecDraftPriority, string> = {
  critical: 'border-destructive/35 bg-destructive/15 text-destructive',
  high: 'border-accent-warning/35 bg-accent-warning/15 text-accent-warning',
  medium: 'border-accent-info/35 bg-accent-info/15 text-accent-info',
  low: 'border-border/60 bg-surface/70 text-foreground/60',
}

// Compact markdown styling for the description body (the five ## sections).
const DESC_MD = cn(
  'text-xs leading-6 text-foreground/85',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-[11px] [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-wider [&_h2]:text-foreground/60 [&_h2:first-child]:mt-0',
  '[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold',
  '[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5',
  '[&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-accent-info',
  '[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface [&_pre]:p-2',
  '[&_strong]:font-semibold',
)

interface Props {
  draft: SpecDraft
}

export function AgentSpecDraftCard({ draft }: Props) {
  const { t } = useTranslation('agent')
  const [expanded, setExpanded] = useState(false)
  const hasDescription = draft.description.trim().length > 0
  const criteria = draft.acceptanceCriteria

  return (
    <div
      data-testid="agent-spec-draft-card"
      className="my-1 overflow-hidden rounded-xl border border-accent-primary/25 bg-card/80 shadow-lg backdrop-blur"
    >
      {/* Header: identity + priority */}
      <div className="flex items-center justify-between gap-2 border-b border-border/40 bg-accent-primary/[0.06] px-3.5 py-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-accent-primary/90">
          <Sparkles className="h-3 w-3" />
          {t('specDraft.heading')}
        </span>
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            PRIORITY_PILL[draft.priority],
          )}
        >
          {t(`explore:priority.${draft.priority}`)}
        </span>
      </div>

      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <div className="text-sm font-semibold leading-snug text-foreground">
          {draft.title.trim() || t('specDraft.untitled')}
        </div>

        {draft.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {draft.labels.map((label, i) => (
              <span
                key={`${i}-${label}`}
                className="rounded-full border border-border/60 bg-surface/70 px-2 py-0.5 text-[10px] text-foreground/70"
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {hasDescription && (
          <div>
            <div className={cn('relative', !expanded && 'max-h-28 overflow-hidden')}>
              <div className={DESC_MD}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.description}</ReactMarkdown>
              </div>
              {!expanded && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent"
                />
              )}
            </div>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              data-agent-interactive
              className="mt-1 flex items-center gap-1 text-[11px] text-accent-info transition-colors hover:text-foreground"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {expanded ? t('specDraft.collapse') : t('specDraft.expand')}
            </button>
          </div>
        )}

        {criteria.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-foreground/50">
              {t('specDraft.acceptanceCriteria')} · {criteria.length}
            </div>
            <ul className="flex flex-col gap-1">
              {criteria.map((c, i) => (
                <li key={`${i}-${c}`} className="flex items-start gap-1.5 text-xs leading-5 text-foreground/85">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-success/80" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

/** Tiny shimmer chip shown while the agent is mid-way through streaming a
 *  spec-draft block (the raw JSON is cut from the bubble meanwhile). */
export function AgentSpecDraftPending() {
  const { t } = useTranslation('agent')
  return (
    <span
      data-testid="agent-spec-draft-pending"
      className="inline-flex w-fit items-center gap-1.5 rounded-full border border-accent-primary/25 bg-accent-primary/10 px-2.5 py-1 text-[11px] text-accent-primary/90"
    >
      <Sparkles className="h-3 w-3 animate-pulse" />
      {t('specDraft.drafting')}
    </span>
  )
}
