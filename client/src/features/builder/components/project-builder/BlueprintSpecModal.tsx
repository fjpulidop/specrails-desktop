import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CheckCircle2, FileText } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../../components/ui/dialog'
import type { BlueprintM1Spec, BlueprintSpecPriority } from '../../lib/blueprint-draft'

// Read-only preview of ONE blueprint spec (reskin follow-up). At day 0 the M1
// specs are NOT tickets yet — they live only in the blueprint snapshot — so
// this is a lightweight markdown preview, not the heavy TicketDetailModal.
//
// Built on ui/dialog (focus trap, Escape, dialog semantics) on the `entity`
// layer: it must sit ABOVE the floating agent panel (floating-chat 60/61) and
// below the minimized chats dock (see lib/layers).

const CHIP = 'inline-flex h-5 items-center rounded px-1.5 text-caption'

// Token-based markdown prose (mirrors AgentMessage's MD — theme-safe, no
// prose-invert). Renders the spec's five-section description cleanly.
const MD = cn(
  'text-sm leading-7 text-foreground',
  '[&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold',
  '[&_h2]:mt-4 [&_h2]:mb-1.5 [&_h2]:text-strong',
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
  const hasSummary = spec.shortSummary.trim().length > 0

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        data-testid="blueprint-spec-modal"
        size="wide"
        layer="entity"
        {...(hasSummary ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader icon={<FileText />}>
          <DialogTitle>{spec.title}</DialogTitle>
          {hasSummary && (
            <DialogDescription data-testid="blueprint-spec-summary">
              <span className="sr-only">{t('specModal.summary')}: </span>
              {spec.shortSummary}
            </DialogDescription>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-muted-foreground" data-testid="blueprint-spec-position">
              {t('specModal.eyebrow', { milestone: milestoneLabel, index: index + 1 })}
            </span>
            <span
              data-chip=""
              className={cn(
                'inline-flex h-5 items-center rounded-full border px-1.5 text-micro font-medium',
                PRIORITY_PILL[spec.priority],
              )}
              data-testid="blueprint-spec-priority"
              aria-label={`${t('specModal.priority')}: ${tTickets(`priority.${spec.priority}`)}`}
            >
              {tTickets(`priority.${spec.priority}`)}
            </span>
            {spec.labels.map((label) => (
              <span key={label} data-chip="" className={cn(CHIP, 'bg-accent-primary/10 text-accent-primary')}>
                {label}
              </span>
            ))}
            {spec.dependsOnIndex !== undefined && (
              <span data-chip="" className={cn(CHIP, 'bg-muted text-muted-foreground')}>
                {t('panel.dependsOn', { index: spec.dependsOnIndex + 1 })}
              </span>
            )}
          </div>
        </DialogHeader>

        <DialogBody className="space-y-5">
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
              className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-foreground/80"
            >
              <span>{t('specModal.acceptanceCriteria')}</span>
              <span data-chip="" className="inline-flex h-5 items-center rounded-full bg-surface px-2 text-caption tabular-nums text-muted-foreground">
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
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
