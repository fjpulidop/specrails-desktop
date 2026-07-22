import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, ChevronRight } from 'lucide-react'
import { Button } from '../ui/button'
import { wordDiff, arrayDiff, type DiffSegment, type ArrayDiffEntry } from './diff-utils'

export interface ReviewBaseline {
  title: string
  description: string
  labels: string[]
  priority: 'low' | 'medium' | 'high' | 'critical' | null
  acceptanceCriteria: string[]
}

export interface ReviewProposed {
  title: string
  description: string
  labels: string[]
  priority: 'low' | 'medium' | 'high' | 'critical' | null
  acceptanceCriteria: string[]
}

export const EMPTY_REVIEW_BASELINE: ReviewBaseline = {
  title: '',
  description: '',
  labels: [],
  priority: null,
  acceptanceCriteria: [],
}

interface Props {
  baseline: ReviewBaseline
  proposed: ReviewProposed
  isCommitting?: boolean
  /** Switches the commit-button visible label between `Create Spec` (default)
   *  and `Update Spec`. The handler is the same — only the verb differs to
   *  reflect new-spec vs. edit-existing-ticket context. */
  mode?: 'create' | 'edit'
  onBack: () => void
  onCommit: () => void
}

/**
 * Full-screen "Review changes" overlay for Explore Spec. Renders the live
 * draft against a baseline with word-level diff on text fields and set
 * diff on array fields. The user can `Back to edit` (close) or
 * `Create Spec` (commit). Esc is equivalent to Back. See
 * openspec/changes/power-up-explore-review-diff/design.md D1+D3+D5.
 */
export function ExploreReviewOverlay({ baseline, proposed, isCommitting, mode = 'create', onBack, onCommit }: Props) {
  const { t } = useTranslation('explore')
  const titleDiff = useMemo(() => wordDiff(baseline.title, proposed.title), [baseline.title, proposed.title])
  const descDiff = useMemo(() => wordDiff(baseline.description, proposed.description), [baseline.description, proposed.description])
  const labelsDiff = useMemo(() => arrayDiff(baseline.labels, proposed.labels), [baseline.labels, proposed.labels])
  const criteriaDiff = useMemo(() => arrayDiff(baseline.acceptanceCriteria, proposed.acceptanceCriteria), [baseline.acceptanceCriteria, proposed.acceptanceCriteria])
  const priorityChanged = baseline.priority !== proposed.priority

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('reviewOverlay.dialogAriaLabel')}
      data-testid="explore-review-overlay"
      className="fixed inset-0 z-[60] flex items-stretch justify-center bg-black/70 backdrop-blur-sm"
    >
      <div className="flex flex-col w-full max-w-5xl h-full bg-background border-x border-border/30 shadow-2xl">
        <header className="flex items-center justify-between px-6 py-4 border-b border-border/30">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
              {t('reviewOverlay.eyebrow')}
            </div>
            <h2 className="text-base font-semibold mt-0.5">{t('reviewOverlay.heading')}</h2>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section data-testid="review-title" className="space-y-2">
              <FieldHeader label={t('reviewOverlay.titleLabel')} />
              <div className="text-sm whitespace-pre-wrap break-words rounded-lg bg-card/40 border border-border/30 px-3 py-2">
                <DiffText parts={titleDiff} />
              </div>
            </section>

            <section data-testid="review-priority" className="space-y-2">
              <FieldHeader label={t('reviewOverlay.priorityLabel')} />
              <div className="flex items-center gap-2">
                {priorityChanged ? (
                  <>
                    <PriorityPill value={baseline.priority} removed />
                    <ChevronRight className="w-3 h-3 text-muted-foreground/60" aria-hidden="true" />
                    <PriorityPill value={proposed.priority} added />
                  </>
                ) : (
                  <PriorityPill value={proposed.priority} />
                )}
              </div>
            </section>

            <section data-testid="review-description" className="lg:col-span-2 space-y-2">
              <FieldHeader label={t('reviewOverlay.descriptionLabel')} />
              <div className="text-xs font-mono whitespace-pre-wrap break-words rounded-lg bg-card/40 border border-border/30 px-3 py-3 leading-relaxed">
                <DiffText parts={descDiff} />
              </div>
            </section>

            <section data-testid="review-labels" className="space-y-2">
              <FieldHeader label={t('reviewOverlay.labelsLabel')} />
              {labelsDiff.ordered.length === 0 ? (
                <p className="text-xs text-muted-foreground/60 italic">{t('reviewOverlay.noLabels')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {labelsDiff.ordered.map((entry, i) => (
                    <DiffChip key={`${entry.status}-${i}`} entry={entry} />
                  ))}
                </div>
              )}
            </section>

            <section data-testid="review-criteria" className="space-y-2">
              <FieldHeader label={t('reviewOverlay.acceptanceCriteriaLabel')} />
              {criteriaDiff.ordered.length === 0 ? (
                <p className="text-xs text-muted-foreground/60 italic">{t('reviewOverlay.noCriteria')}</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {criteriaDiff.ordered.map((entry, i) => (
                    <DiffBullet key={`${entry.status}-${i}`} entry={entry} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 px-6 py-4 border-t border-border/30">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onBack}
            disabled={isCommitting}
            data-testid="review-back"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            {t('reviewOverlay.backToEdit')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onCommit}
            disabled={isCommitting || !proposed.title.trim()}
            data-testid="review-commit"
            className="gap-1.5"
          >
            <Check className="w-3.5 h-3.5" />
            {mode === 'edit' ? t('reviewOverlay.updateSpec') : t('reviewOverlay.createSpec')}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

function FieldHeader({ label }: { label: string }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
      {label}
    </div>
  )
}

function DiffText({ parts }: { parts: DiffSegment[] }) {
  const { t } = useTranslation('explore')
  return (
    <>
      {parts.map((p, i) => {
        if (p.added) {
          return (
            <span key={i} className="diff-added" aria-label={t('reviewOverlay.inserted')}>
              {p.value}
            </span>
          )
        }
        if (p.removed) {
          if (!p.value.trim()) return null
          return (
            <span key={i} className="diff-removed" aria-label={t('reviewOverlay.removed')}>
              {p.value}
            </span>
          )
        }
        return <span key={i}>{p.value}</span>
      })}
    </>
  )
}

function DiffChip<T extends string>({ entry }: { entry: ArrayDiffEntry<T> }) {
  const { t } = useTranslation('explore')
  const base = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]'
  if (entry.status === 'added') {
    return <span className={`${base} diff-chip-added`} aria-label={t('reviewOverlay.added')}>+ {entry.value}</span>
  }
  if (entry.status === 'removed') {
    return <span className={`${base} diff-chip-removed`} aria-label={t('reviewOverlay.removed')}>− {entry.value}</span>
  }
  return (
    <span
      className={`${base} bg-card/60 text-muted-foreground border border-border/40`}
      aria-label={t('reviewOverlay.unchanged')}
    >
      {entry.value}
    </span>
  )
}

function DiffBullet<T extends string>({ entry }: { entry: ArrayDiffEntry<T> }) {
  const { t } = useTranslation('explore')
  if (entry.status === 'added') {
    return (
      <li className="diff-bullet-added rounded px-2 py-1 list-none" aria-label={t('reviewOverlay.added')}>
        <span className="mr-1 font-mono">+</span>
        {entry.value}
      </li>
    )
  }
  if (entry.status === 'removed') {
    return (
      <li className="diff-bullet-removed rounded px-2 py-1 list-none" aria-label={t('reviewOverlay.removed')}>
        <span className="mr-1 font-mono">−</span>
        {entry.value}
      </li>
    )
  }
  return (
    <li className="text-foreground/90 list-disc list-inside" aria-label={t('reviewOverlay.unchanged')}>
      {entry.value}
    </li>
  )
}

function PriorityPill({
  value,
  added,
  removed,
}: {
  value: ReviewBaseline['priority']
  added?: boolean
  removed?: boolean
}) {
  const { t } = useTranslation('explore')
  if (!value) {
    return <span className="text-[11px] text-muted-foreground/60 italic">{t('reviewOverlay.noPriority')}</span>
  }
  const base = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] capitalize border'
  if (added) {
    return <span className={`${base} diff-chip-added`} aria-label={t('reviewOverlay.added')}>{t(`priority.${value}`)}</span>
  }
  if (removed) {
    return <span className={`${base} diff-chip-removed`} aria-label={t('reviewOverlay.removed')}>{t(`priority.${value}`)}</span>
  }
  return <span className={`${base} bg-card/60 text-muted-foreground border-border/40`}>{t(`priority.${value}`)}</span>
}
