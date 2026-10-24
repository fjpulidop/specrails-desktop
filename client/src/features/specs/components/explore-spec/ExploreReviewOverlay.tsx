import { useCallback, useMemo, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, ChevronRight } from 'lucide-react'
import { useDesktop } from '../../../../hooks/useDesktop'
import { projectRepositories } from '../../../projects/lib/project-repositories'
import { Button } from '../../../../components/ui/button'
import { DIALOG_SCRIM_CLASS, DialogLayerProvider } from '../../../../components/ui/dialog'
import { DIALOG_LAYER_CLASS } from '../../../../lib/layers'
import { cn } from '../../../../lib/utils'
import { wordDiff, arrayDiff, type DiffSegment, type ArrayDiffEntry } from './diff-utils'

export interface ReviewBaseline {
  title: string
  description: string
  labels: string[]
  repositoryIds?: string[]
  priority: 'low' | 'medium' | 'high' | 'critical' | null
  acceptanceCriteria: string[]
}

export interface ReviewProposed {
  title: string
  description: string
  labels: string[]
  repositoryIds?: string[]
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
  const { activeProjectId, projects } = useDesktop()
  const repositories = projectRepositories(projects.find((project) => project.id === activeProjectId))
  const primaryIds = repositories.filter((repository) => repository.isPrimary).map((repository) => repository.id)
  const repositoryNames = (ids: string[]) => ids.map((id) => repositories.find((repository) => repository.id === id)?.name ?? id)
  const repositoryDiff = arrayDiff(repositoryNames(baseline.repositoryIds ?? primaryIds), repositoryNames(proposed.repositoryIds ?? primaryIds))
  const titleDiff = useMemo(() => wordDiff(baseline.title, proposed.title), [baseline.title, proposed.title])
  const descDiff = useMemo(() => wordDiff(baseline.description, proposed.description), [baseline.description, proposed.description])
  const labelsDiff = useMemo(() => arrayDiff(baseline.labels, proposed.labels), [baseline.labels, proposed.labels])
  const criteriaDiff = useMemo(() => arrayDiff(baseline.acceptanceCriteria, proposed.acceptanceCriteria), [baseline.acceptanceCriteria, proposed.acceptanceCriteria])
  const priorityChanged = baseline.priority !== proposed.priority
  // Focus return to the shell's Review button (Radix only refocuses a DialogTrigger).
  const [returnTarget] = useState<HTMLElement | null>(() => {
    if (typeof document === 'undefined') return null
    const el = document.activeElement
    return el instanceof HTMLElement && el !== document.body ? el : null
  })
  const handleCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault()
    if (returnTarget?.isConnected) returnTarget.focus()
  }, [returnTarget])

  // Opened over the Explore Spec shell, so it sits on the `stacked` layer.
  // Radix owns Escape (= Back to edit) and stacks it above the shell's own
  // Esc handling; full-height column geometry is specific to this review.
  return (
    <DialogPrimitive.Root open onOpenChange={(next) => { if (!next && !isCommitting) onBack() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={cn(DIALOG_SCRIM_CLASS, DIALOG_LAYER_CLASS.stacked)} />
        <DialogPrimitive.Content
          aria-label={t('reviewOverlay.dialogAriaLabel')}
          aria-describedby={undefined}
          data-testid="explore-review-overlay"
          data-dialog-layer="stacked"
          onCloseAutoFocus={handleCloseAutoFocus}
          className={cn(
            'modal-panel fixed inset-y-0 left-1/2 flex w-full max-w-5xl -translate-x-1/2 flex-col border-x border-border/30 bg-background shadow-xl outline-none',
            DIALOG_LAYER_CLASS.stacked,
          )}
        >
        <DialogLayerProvider layer="stacked">
        <header className="flex items-center justify-between px-6 py-4 border-b border-border/30">
          <div>
            <DialogPrimitive.Title className="text-base font-semibold">{t('reviewOverlay.heading')}</DialogPrimitive.Title>
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
                    <ChevronRight className="w-3 h-3 text-muted-foreground" aria-hidden="true" />
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

            {repositories.length > 1 && <section className="space-y-2" data-testid="review-repositories">
              <FieldHeader label={t('common:repositories.specScope')} />
              <div className="flex flex-wrap gap-2">{repositoryDiff.ordered.map((entry, index) => <DiffChip key={index} entry={entry} />)}</div>
            </section>}
            <section data-testid="review-labels" className="space-y-2">
              <FieldHeader label={t('reviewOverlay.labelsLabel')} />
              {labelsDiff.ordered.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">{t('reviewOverlay.noLabels')}</p>
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
                <p className="text-xs text-muted-foreground italic">{t('reviewOverlay.noCriteria')}</p>
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
            onClick={onBack}
            disabled={isCommitting}
            data-testid="review-back"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            {t('reviewOverlay.backToEdit')}
          </Button>
          <Button
            type="button"
            onClick={onCommit}
            disabled={isCommitting || !proposed.title.trim()}
            data-testid="review-commit"
            className="gap-1.5"
          >
            <Check className="w-3.5 h-3.5" />
            {mode === 'edit' ? t('reviewOverlay.updateSpec') : t('reviewOverlay.createSpec')}
          </Button>
        </footer>
        </DialogLayerProvider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function FieldHeader({ label }: { label: string }) {
  return (
    <div className="text-xs font-medium text-muted-foreground">
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
  const base = 'inline-flex h-5 items-center gap-1 rounded-full px-2 text-caption'
  if (entry.status === 'added') {
    return <span data-chip="" className={`${base} diff-chip-added`} aria-label={t('reviewOverlay.added')}>+ {entry.value}</span>
  }
  if (entry.status === 'removed') {
    return <span data-chip="" className={`${base} diff-chip-removed`} aria-label={t('reviewOverlay.removed')}>− {entry.value}</span>
  }
  return (
    <span data-chip=""
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
    return <span className="text-xs text-muted-foreground italic">{t('reviewOverlay.noPriority')}</span>
  }
  const base = 'inline-flex h-5 items-center gap-1 rounded-full px-2 text-caption capitalize border'
  if (added) {
    return <span data-chip="" className={`${base} diff-chip-added`} aria-label={t('reviewOverlay.added')}>{t(`priority.${value}`)}</span>
  }
  if (removed) {
    return <span data-chip="" className={`${base} diff-chip-removed`} aria-label={t('reviewOverlay.removed')}>{t(`priority.${value}`)}</span>
  }
  return <span data-chip="" className={`${base} bg-card/60 text-muted-foreground border-border/40`}>{t(`priority.${value}`)}</span>
}
