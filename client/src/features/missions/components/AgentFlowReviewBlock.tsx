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

export function AgentFlowReviewBlock({ review, children, hideNext = false }: { review: PrDeliveryFlowReview; children?: ReactNode; hideNext?: boolean }) {
  const { t } = useTranslation('agent')
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? review.issues : review.issues.slice(0, FLOW_REVIEW_VISIBLE_ISSUES)
  const hidden = review.issues.length - visible.length
  const isReview = review.reason === 'review'
  return (
    <div
      className={cn('mt-2 rounded-md border px-2.5 py-2 text-caption', isReview ? 'border-accent-review/35 bg-accent-review/[0.06]' : 'border-accent-warning/35 bg-accent-warning/[0.06]')}
      data-testid="mission-flow-review"
      data-reason={review.reason}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <MessageSquareWarning className={cn('h-3.5 w-3.5 shrink-0', isReview ? 'text-accent-review' : 'text-accent-warning')} aria-hidden />
        <span className="font-medium text-foreground">{t(`runCard.review.title.${review.reason}`)}</span>
        {review.score !== null && (
          <span className={cn('rounded-full border px-2 py-px font-mono text-caption', isReview ? 'border-accent-review/40 bg-accent-review/10 text-accent-review' : 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning')} data-testid="mission-flow-review-score">
            {t('runCard.review.score', { score: Math.round(review.score) })}
          </span>
        )}
      </div>
      {review.summary && (
        <p className="mt-1 line-clamp-3 break-words leading-4 text-muted-foreground" title={review.summary}>{review.summary}</p>
      )}
      {review.issues.length > 0 && (
        <div className="mt-1.5">
          <p className="flex items-center gap-1 text-label text-muted-foreground">
            <ListChecks className="h-3 w-3" aria-hidden />
            {t('runCard.review.issues', { count: review.issues.length + review.issuesOmitted })}
          </p>
          <ol className="mt-1 list-decimal space-y-1 pl-4 marker:text-muted-foreground" data-testid="mission-flow-review-issues">
            {visible.map((issue, index) => (
              <li key={index} className="break-words leading-4 text-muted-foreground">{issue}</li>
            ))}
          </ol>
          {(hidden > 0 || expanded) && review.issues.length > FLOW_REVIEW_VISIBLE_ISSUES && (
            <button
              type="button"
              data-agent-interactive
              onClick={() => setExpanded((open) => !open)}
              className="mt-1 text-caption font-medium text-accent-info hover:underline"
              data-testid="mission-flow-review-toggle"
            >
              {expanded ? t('runCard.review.showLess') : t('runCard.review.showAll', { count: review.issues.length })}
            </button>
          )}
          {review.issuesOmitted > 0 && (
            <p className="mt-0.5 text-caption text-muted-foreground">{t('runCard.review.omitted', { count: review.issuesOmitted })}</p>
          )}
        </div>
      )}
      {review.failingChecks.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1" data-testid="mission-flow-review-checks">
          <span className="text-label text-muted-foreground">{t('runCard.review.failingChecks')}</span>
          {review.failingChecks.map((check, index) => (
            <span key={index} className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-px font-mono text-caption text-destructive">
              <SquareTerminal className="h-2.5 w-2.5" aria-hidden />
              {check.exitCode !== null ? t('runCard.review.check', { command: check.command, code: check.exitCode }) : check.command}
            </span>
          ))}
        </div>
      )}
      {!hideNext && <p className="mt-1.5 leading-4 text-muted-foreground">{t('runCard.review.next')}</p>}
      {children && <div className="mt-2 flex flex-wrap items-center gap-1.5">{children}</div>}
    </div>
  )
}

/** The closed card after "Back to Flow": the work went back to its Flow. */
export function AgentFlowReturnedNote({ className }: { className?: string }) {
  const { t } = useTranslation('agent')
  return (
    <p className={cn('mt-2 flex items-start gap-1.5 text-caption leading-4 text-accent-info', className)} data-testid="mission-flow-returned">
      <Undo2 className="mt-px h-3 w-3 shrink-0" aria-hidden />
      <span>{t('runCard.review.returned')}</span>
    </p>
  )
}
