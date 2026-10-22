// ─── Flow → Spec: "the reviewer requested changes" ───────────────────────────
// Replaces the generic failure block on a run/PR card when a Flow → Spec run
// stopped because the work still needs changes after its automatic correction
// rounds (`review_changes_requested`): the reviewer's own summary and issues,
// the failing host checks, and the extension's actions (Back to Flow /
// Relaunch). After "Back to Flow" the closed card says where the work went.

import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks, MessageSquareWarning, SquareTerminal, Undo2 } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { PrDeliveryFlowReview } from '../../../types'

/** Issues shown before "Show all". */
export const FLOW_REVIEW_VISIBLE_ISSUES = 4

export function AgentFlowReviewBlock({ review, children }: { review: PrDeliveryFlowReview; children?: ReactNode }) {
  const { t } = useTranslation('agent')
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? review.issues : review.issues.slice(0, FLOW_REVIEW_VISIBLE_ISSUES)
  const hidden = review.issues.length - visible.length
  return (
    <div
      className="mt-2 rounded-md border border-accent-warning/35 bg-accent-warning/[0.06] px-2.5 py-2 text-[11px]"
      data-testid="mission-flow-review"
      data-reason={review.reason}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <MessageSquareWarning className="h-3.5 w-3.5 shrink-0 text-accent-warning" aria-hidden />
        <span className="font-medium text-foreground/90">{t(`runCard.review.title.${review.reason}`)}</span>
        {review.score !== null && (
          <span className="rounded-full border border-accent-warning/40 bg-accent-warning/10 px-2 py-px font-mono text-[10px] text-accent-warning" data-testid="mission-flow-review-score">
            {t('runCard.review.score', { score: Math.round(review.score) })}
          </span>
        )}
      </div>
      {review.summary && (
        <p className="mt-1 line-clamp-3 break-words leading-4 text-foreground/70" title={review.summary}>{review.summary}</p>
      )}
      {review.issues.length > 0 && (
        <div className="mt-1.5">
          <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-foreground/50">
            <ListChecks className="h-3 w-3" aria-hidden />
            {t('runCard.review.issues', { count: review.issues.length + review.issuesOmitted })}
          </p>
          <ol className="mt-1 list-decimal space-y-1 pl-4 marker:text-foreground/40" data-testid="mission-flow-review-issues">
            {visible.map((issue, index) => (
              <li key={index} className="break-words leading-4 text-foreground/75">{issue}</li>
            ))}
          </ol>
          {(hidden > 0 || expanded) && review.issues.length > FLOW_REVIEW_VISIBLE_ISSUES && (
            <button
              type="button"
              data-agent-interactive
              onClick={() => setExpanded((open) => !open)}
              className="mt-1 text-[10px] font-medium text-accent-info hover:underline"
              data-testid="mission-flow-review-toggle"
            >
              {expanded ? t('runCard.review.showLess') : t('runCard.review.showAll', { count: review.issues.length })}
            </button>
          )}
          {review.issuesOmitted > 0 && (
            <p className="mt-0.5 text-[10px] text-foreground/45">{t('runCard.review.omitted', { count: review.issuesOmitted })}</p>
          )}
        </div>
      )}
      {review.failingChecks.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1" data-testid="mission-flow-review-checks">
          <span className="text-[10px] font-medium uppercase tracking-wide text-foreground/50">{t('runCard.review.failingChecks')}</span>
          {review.failingChecks.map((check, index) => (
            <span key={index} className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-px font-mono text-[10px] text-destructive">
              <SquareTerminal className="h-2.5 w-2.5" aria-hidden />
              {check.exitCode !== null ? t('runCard.review.check', { command: check.command, code: check.exitCode }) : check.command}
            </span>
          ))}
        </div>
      )}
      <p className="mt-1.5 leading-4 text-foreground/55">{t('runCard.review.next')}</p>
      {children && <div className="mt-2 flex flex-wrap items-center gap-1.5">{children}</div>}
    </div>
  )
}

/** The closed card after "Back to Flow": the work went back to its Flow. */
export function AgentFlowReturnedNote({ className }: { className?: string }) {
  const { t } = useTranslation('agent')
  return (
    <p className={cn('mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-accent-info', className)} data-testid="mission-flow-returned">
      <Undo2 className="mt-px h-3 w-3 shrink-0" aria-hidden />
      <span>{t('runCard.review.returned')}</span>
    </p>
  )
}
