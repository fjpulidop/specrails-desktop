import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CheckCircle2, FileText, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { BlueprintM1Spec, BlueprintSpecPriority } from '../../lib/blueprint-draft'

// Read-only preview of ONE blueprint spec (reskin follow-up). At day 0 the M1
// specs are NOT tickets yet — they live only in the blueprint snapshot — so
// this is a lightweight markdown preview, not the heavy TicketDetailModal.
//
// Hand-rolled portal (NOT ui/dialog): it must layer ABOVE the floating agent
// panel (z-[60]/[61]) — same tier + pattern as LoopPreviewModal: portal to
// document.body at z-[65], below the MinimizedChatsDock (z-[70]).

// Token-based markdown prose (mirrors AgentMessage's MD — theme-safe, no
// prose-invert). Renders the spec's five-section description cleanly.
const MD = cn(
  'text-sm leading-7 text-foreground',
  '[&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold',
  '[&_h2]:mt-4 [&_h2]:mb-1.5 [&_h2]:text-[15px] [&_h2]:font-semibold',
  '[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_em]:italic',
  '[&_a]:text-accent-info [&_a]:underline [&_a]:underline-offset-2',
  '[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1',
  '[&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-accent-info',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface [&_pre]:p-3',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-foreground',
  '[&_hr]:my-3 [&_hr]:border-border/60',
)

interface BlueprintSpecModalProps {
  spec: BlueprintM1Spec
  index: number
  milestoneLabel?: string
  onClose: () => void
}

const PRIORITY_PILL: Record<BlueprintSpecPriority, string> = {
  critical: 'border-destructive/35 bg-destructive/15 text-destructive',
  high: 'border-accent-warning/35 bg-accent-warning/15 text-accent-warning',
  medium: 'border-accent-info/35 bg-accent-info/15 text-accent-info',
  low: 'border-border/60 bg-surface/70 text-foreground/60',
}

export function BlueprintSpecModal({ spec, index, milestoneLabel = 'M1', onClose }: BlueprintSpecModalProps) {
  const { t } = useTranslation('builder')
  const { t: tTickets } = useTranslation('tickets')
  const summaryId = `blueprint-spec-summary-${index}`

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div data-testid="blueprint-spec-modal" className="fixed inset-0 z-[65] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={spec.title}
        aria-describedby={spec.shortSummary.trim() ? summaryId : undefined}
        className="relative flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border/40 bg-popover shadow-2xl backdrop-blur-md"
      >
        <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-accent-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('specModal.eyebrow', { milestone: milestoneLabel, index: index + 1 })}
            </p>
            <h2 className="mt-0.5 text-base font-semibold text-foreground">{spec.title}</h2>
            {spec.shortSummary.trim() && (
              <p id={summaryId} className="mt-1 text-xs leading-5 text-muted-foreground" data-testid="blueprint-spec-summary">
                <span className="sr-only">{t('specModal.summary')}: </span>
                {spec.shortSummary}
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap gap-1">
              <span
                className={cn(
                  'rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-wide',
                  PRIORITY_PILL[spec.priority],
                )}
                data-testid="blueprint-spec-priority"
                aria-label={`${t('specModal.priority')}: ${tTickets(`priority.${spec.priority}`)}`}
              >
                {tTickets(`priority.${spec.priority}`)}
              </span>
              {spec.labels.map((label) => (
                <span key={label} className="rounded bg-accent-primary/10 px-1.5 py-px text-[9px] text-accent-primary">
                  {label}
                </span>
              ))}
              {spec.dependsOnIndex !== undefined && (
                <span className="rounded bg-muted px-1.5 py-px text-[9px] text-muted-foreground">
                  {t('panel.dependsOn', { index: spec.dependsOnIndex + 1 })}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('specModal.close')}
            data-agent-interactive
            className="rounded-md p-1.5 text-muted-foreground hover:bg-surface hover:text-foreground"
            data-testid="blueprint-spec-modal-close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section aria-label={t('specModal.description')} data-testid="blueprint-spec-description">
            {spec.description.trim() ? (
              <div className={MD}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{spec.description}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-xs italic text-muted-foreground">{t('specModal.empty')}</p>
            )}
          </section>

          <section aria-labelledby="blueprint-spec-criteria-heading" data-testid="blueprint-spec-acceptance-criteria">
            <h3
              id="blueprint-spec-criteria-heading"
              className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-foreground/60"
            >
              <span>{t('specModal.acceptanceCriteria')}</span>
              <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {spec.acceptanceCriteria.length}
              </span>
            </h3>
            {spec.acceptanceCriteria.length > 0 ? (
              <ol className="space-y-2">
                {spec.acceptanceCriteria.map((criterion, criterionIndex) => (
                  <li
                    key={`${criterionIndex}-${criterion}`}
                    className="flex items-start gap-2 text-sm leading-6 text-foreground/85"
                    data-testid={`blueprint-spec-criterion-${criterionIndex}`}
                  >
                    <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-accent-success" aria-hidden />
                    <span>{criterion}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs italic text-muted-foreground">{t('specModal.criteriaEmpty')}</p>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}
