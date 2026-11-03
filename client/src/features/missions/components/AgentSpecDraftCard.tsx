// ─── In-conversation live spec-draft card ──────────────────────────────────────
// Renders the agent's fenced ```spec-draft snapshot (see agent-spec-draft.ts)
// as a premium card: title, priority pill, labels, expandable description and
// the acceptance-criteria checklist. Purely presentational — the draft is
// authoritative in the conversation text; committing goes through the agent's
// commit_draft flow, not this card.
//
// Design (DESIGN.md): a resting card is hairline + shadow 1 on an opaque
// surface; priority is NOT a lamp (amber is caution/cost, info is running),
// so the pill is a neutral badge (dot + label) and only `critical` borrows the
// destructive hue; proposed criteria use a neutral glyph, success stays for
// verified state. The column is 360–520 px wide, so long titles, labels and
// criteria wrap instead of being clipped by the card's overflow-hidden.

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles, ChevronDown, ChevronUp, Circle, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import type { SpecDraft, SpecDraftPriority } from '../../specs/lib/spec-draft'

// Badge recipe: pill, transparent fill, 30% tinted hairline, 6 px leading dot.
const PRIORITY_PILL: Record<SpecDraftPriority, { pill: string; dot: string }> = {
  critical: { pill: 'border-destructive/30 text-destructive', dot: 'bg-destructive' },
  high: { pill: 'border-border/60 text-foreground', dot: 'bg-foreground' },
  medium: { pill: 'border-border/60 text-muted-foreground', dot: 'bg-muted-foreground' },
  low: { pill: 'border-border/60 text-muted-foreground', dot: 'bg-muted-foreground/60' },
}

// Collapsed description height (px). The fade + toggle only appear when the
// rendered markdown actually overflows this.
const DESC_CLAMP_PX = 112

// Compact markdown styling for the description body (the five ## sections).
const DESC_MD = cn(
  'text-label font-normal leading-6 text-foreground break-words',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-label [&_h2]:font-semibold [&_h2]:text-muted-foreground [&_h2:first-child]:mt-0',
  '[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-label [&_h3]:font-semibold',
  '[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5',
  '[&_code]:rounded-control [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-foreground',
  '[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface [&_pre]:p-2',
  '[&_strong]:font-semibold',
)

interface Props {
  draft: SpecDraft
  /** An older snapshot in a refinement thread: the header is muted and
   *  labelled so several cards in a row do not all read as "the draft". */
  superseded?: boolean
}

/** True when the clamped description overflows its collapsed box. Measured
 *  (ResizeObserver when available) so a two-line description gets neither a
 *  fade nor a toggle that changes nothing. */
function useOverflows(ref: React.RefObject<HTMLElement | null>, enabled: boolean, key: string): boolean {
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const measure = () => setOverflows(el.scrollHeight > DESC_CLAMP_PX + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, enabled, key])
  return overflows
}

export function AgentSpecDraftCard({ draft, superseded = false }: Props) {
  const { t } = useTranslation('agent')
  const [expanded, setExpanded] = useState(false)
  const descId = useId()
  const descRef = useRef<HTMLDivElement>(null)
  const hasDescription = draft.description.trim().length > 0
  const criteria = draft.acceptanceCriteria
  const overflows = useOverflows(descRef, hasDescription, draft.description)
  const clamped = hasDescription && overflows && !expanded
  const priority = PRIORITY_PILL[draft.priority]

  // A description that stops overflowing (window grows) collapses its toggle;
  // keep the expanded flag coherent so the next overflow starts collapsed.
  useEffect(() => { if (!overflows) setExpanded(false) }, [overflows])

  return (
    <div
      data-testid="agent-spec-draft-card"
      data-superseded={superseded ? 'true' : undefined}
      className={cn(
        'my-1 overflow-hidden rounded-card border bg-card shadow-1',
        superseded ? 'border-border/60' : 'border-accent-primary/25',
      )}
    >
      {/* Header: identity + priority */}
      <div className={cn(
        'flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border/40 px-3.5 py-2',
        superseded ? 'bg-surface/40' : 'bg-accent-primary/[0.06]',
      )}>
        <h3 className={cn('m-0 flex items-center gap-1.5 text-label font-semibold', superseded ? 'text-muted-foreground' : 'text-accent-primary')}>
          <Sparkles className="h-3 w-3" aria-hidden />
          {t('specDraft.heading')}
          {superseded && (
            <span className="font-normal text-muted-foreground" data-testid="agent-spec-draft-superseded">
              {' · '}{t('specDraft.superseded', { defaultValue: 'Superseded' })}
            </span>
          )}
        </h3>
        <span
          data-testid="agent-spec-draft-priority"
          data-priority={draft.priority}
          className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption font-medium', priority.pill)}
        >
          <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', priority.dot)} />
          <span className="sr-only">{t('specs:priority')}: </span>
          {t(`explore:priority.${draft.priority}`)}
        </span>
      </div>

      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <div className="min-w-0 text-strong leading-snug text-foreground [overflow-wrap:anywhere]">
          {draft.title.trim() || t('specDraft.untitled')}
        </div>

        {draft.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {draft.labels.map((label, i) => (
              <span
                key={`${i}-${label}`}
                title={label}
                className="max-w-full rounded-full border border-border/60 bg-surface/70 px-2 py-0.5 text-caption text-muted-foreground [overflow-wrap:anywhere]"
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {hasDescription && (
          <div>
            <div
              id={descId}
              className={cn('relative', clamped && 'overflow-hidden')}
              style={clamped ? { maxHeight: DESC_CLAMP_PX } : undefined}
            >
              <div ref={descRef} className={DESC_MD}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.description}</ReactMarkdown>
              </div>
              {clamped && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent"
                />
              )}
            </div>
            {overflows && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                data-agent-interactive
                aria-expanded={expanded}
                aria-controls={descId}
                className="mt-1 flex min-h-6 items-center gap-1 text-label text-accent-info transition-colors hover:text-foreground"
              >
                {expanded ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />}
                {expanded ? t('specDraft.collapse') : t('specDraft.expand')}
              </button>
            )}
          </div>
        )}

        {criteria.length > 0 && (
          <div>
            <div className="mb-1 text-label text-muted-foreground">
              {t('specDraft.acceptanceCriteria')} · <span className="tabular-nums">{criteria.length}</span>
            </div>
            <ul className="flex flex-col gap-1">
              {criteria.map((c, i) => (
                <li key={`${i}-${c}`} className="flex min-w-0 items-start gap-1.5 text-label font-normal leading-5 text-foreground">
                  <Circle className="mt-[7px] h-1.5 w-1.5 shrink-0 fill-current text-muted-foreground" aria-hidden />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{c}</span>
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
      className="inline-flex w-fit items-center gap-1.5 rounded-full border border-accent-primary/25 bg-accent-primary/10 px-2.5 py-1 text-label font-normal text-accent-primary"
    >
      <Sparkles className="h-3 w-3 motion-safe:animate-pulse" aria-hidden />
      {t('specDraft.drafting')}
    </span>
  )
}

/** Muted one-line notice for a settled ```spec-draft block the parser could
 *  not read (never silent — the sibling rail-launch fence does the same). */
export function AgentSpecDraftUnreadable({ count = 1 }: { count?: number }) {
  const { t } = useTranslation('agent')
  return (
    <div
      data-testid="agent-spec-draft-unreadable"
      className="my-1 inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-surface/40 px-2.5 py-1 text-caption text-muted-foreground"
    >
      <AlertTriangle className="h-3 w-3 shrink-0 text-accent-warning" aria-hidden />
      {t('specDraft.unreadable', { count, defaultValue: count === 1 ? 'The spec draft could not be read.' : '{{count}} spec drafts could not be read.' })}
    </div>
  )
}
