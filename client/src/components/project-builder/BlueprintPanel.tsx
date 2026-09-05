import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X, FileText, Layers, ListChecks, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  deriveDimensions,
  type Blueprint,
  type BlueprintSpecPriority,
} from '../../lib/blueprint-draft'
import { BlueprintSpecModal } from './BlueprintSpecModal'
import type { BuilderSnapshotState } from '../../hooks/useBuilderSession'

// Live blueprint panel (add-project-builder D8): five dimension rows filling
// in as ✓/✗ during the interview, then the complete M1 spec batch after
// generation. Renders only the LAST VALID snapshot — an invalid streamed block
// never blanks it (the parser upstream guarantees that). Spec cards are
// clickable → a read-only detail modal (reskin follow-up).

interface BlueprintPanelProps {
  blueprint: Blueprint | null
  /** The detailed-spec payload is shared by day-0 M1 and grounded M2+ drafts. */
  milestoneLabel?: string
  /** Live snapshot status — a repair in flight pulses the header. */
  snapshot?: BuilderSnapshotState
}

const PRIORITY_PILL: Record<BlueprintSpecPriority, string> = {
  critical: 'border-destructive/35 bg-destructive/15 text-destructive',
  high: 'border-accent-warning/35 bg-accent-warning/15 text-accent-warning',
  medium: 'border-accent-info/35 bg-accent-info/15 text-accent-info',
  low: 'border-border/60 bg-surface/70 text-foreground/60',
}

export function BlueprintPanel({ blueprint, milestoneLabel = 'M1', snapshot }: BlueprintPanelProps) {
  const { t } = useTranslation('builder')
  const { t: tTickets } = useTranslation('tickets')
  const dims = deriveDimensions(blueprint)
  const [selectedSpec, setSelectedSpec] = useState<number | null>(null)

  const rows: Array<{ key: keyof typeof dims; label: string; value: string }> = [
    { key: 'product', label: t('panel.product'), value: blueprint?.product.name ?? '' },
    { key: 'coreFlow', label: t('panel.coreFlow'), value: blueprint?.coreFlow ?? '' },
    { key: 'platform', label: t('panel.platform'), value: blueprint?.platform ?? '' },
    {
      key: 'stack',
      label: t('panel.stack'),
      value: blueprint
        ? [blueprint.stack.language, blueprint.stack.framework, blueprint.stack.db].filter(Boolean).join(' · ')
        : '',
    },
    {
      key: 'milestones',
      label: t('panel.milestones'),
      value: blueprint && blueprint.milestones.length > 0
        ? t('panel.milestonesValue', { count: blueprint.milestones.length })
        : '',
    },
  ]

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4" data-testid="blueprint-panel">
      <div className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('panel.title')}
          {snapshot?.status === 'repairing' && (
            <Loader2 className="h-3 w-3 animate-spin text-accent-info" aria-hidden data-testid="panel-repairing" />
          )}
        </h3>
        <div className="space-y-1">
          {rows.map((row) => (
            <div
              key={row.key}
              className={cn(
                'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                dims[row.key] ? 'border-accent-success/30 bg-accent-success/5' : 'border-border/30',
              )}
              data-testid={`dimension-${row.key}`}
            >
              {dims[row.key] ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-accent-success" aria-label="✓" />
              ) : (
                <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" aria-label="✗" />
              )}
              <span className="font-medium">{row.label}</span>
              {row.value && (
                <span className="ml-auto truncate text-muted-foreground" title={row.value}>
                  {row.value}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {blueprint && blueprint.assumptions.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('panel.assumptions')}
          </h4>
          <ul className="space-y-0.5">
            {blueprint.assumptions.map((a, i) => (
              <li key={i} className="text-[11px] text-muted-foreground before:mr-1.5 before:content-['·']">
                {a}
              </li>
            ))}
          </ul>
        </div>
      )}

      {blueprint && blueprint.m1Specs.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Layers className="h-3 w-3" />
            {t('panel.m1Specs', { count: blueprint.m1Specs.length })}
            <span
              className={cn(
                'ml-auto rounded-full border px-1.5 py-px text-[9px] font-medium normal-case tracking-normal',
                blueprint.specsComplete
                  ? 'border-accent-success/35 bg-accent-success/10 text-accent-success'
                  : 'border-accent-warning/35 bg-accent-warning/10 text-accent-warning',
              )}
              data-testid="m1-specs-completeness"
            >
              {blueprint.specsComplete ? t('panel.specsComplete') : t('panel.specsInProgress')}
            </span>
          </h4>
          <div className="space-y-1.5">
            {blueprint.m1Specs.map((spec, i) => (
              <button
                type="button"
                key={`${i}-${spec.title}`}
                onClick={() => setSelectedSpec(i)}
                data-agent-interactive
                className="w-full rounded-lg border border-border/40 bg-surface/50 p-2.5 text-left shadow-sm transition-colors animate-in fade-in slide-in-from-bottom-1 hover:border-accent-primary/50 hover:bg-surface/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                data-testid={`m1-spec-card-${i}`}
                title={t('specModal.open')}
              >
                <div className="flex items-start gap-2">
                  <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium leading-tight">{spec.title}</p>
                    {spec.shortSummary.trim() && (
                      <p
                        className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground"
                        data-testid={`m1-spec-summary-${i}`}
                      >
                        {spec.shortSummary}
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span
                        className={cn(
                          'rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-wide',
                          PRIORITY_PILL[spec.priority],
                        )}
                        data-testid={`m1-spec-priority-${i}`}
                      >
                        {tTickets(`priority.${spec.priority}`)}
                      </span>
                      {!spec.description.trim() && spec.acceptanceCriteria.length === 0 ? (
                        // Outline entry: the batched generation has not written this
                        // spec yet — never "0 acceptance criteria" (that reads as a defect).
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px]',
                            snapshot?.status === 'generating'
                              ? 'border-accent-info/35 bg-accent-info/10 text-accent-info'
                              : 'border-border/50 bg-surface/70 text-muted-foreground',
                          )}
                          data-testid={`m1-spec-unwritten-${i}`}
                        >
                          {snapshot?.status === 'generating'
                            ? <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />
                            : <ListChecks className="h-2.5 w-2.5" aria-hidden />}
                          {t(snapshot?.status === 'generating' ? 'panel.specWriting' : 'panel.specPendingBody')}
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-surface/70 px-1.5 py-px text-[9px] text-muted-foreground"
                          data-testid={`m1-spec-criteria-count-${i}`}
                        >
                          <ListChecks className="h-2.5 w-2.5" aria-hidden />
                          {t('panel.criteriaCount', { count: spec.acceptanceCriteria.length })}
                        </span>
                      )}
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
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {blueprint && blueprint.milestones.length > 1 && (
        <div className="space-y-1">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('panel.laterMilestones')}
          </h4>
          {blueprint.milestones.slice(1).map((m) => (
            <div key={m.id || m.title} className="rounded-md border border-border/20 px-2.5 py-1.5">
              <p className="text-[11px] font-medium">{m.title}</p>
              {m.plannedSpecs.length > 0 && (
                <p className="text-[10px] text-muted-foreground">{m.plannedSpecs.join(' · ')}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {!blueprint && (
        <p className="text-[11px] italic text-muted-foreground/60">{t('panel.empty')}</p>
      )}

      {blueprint && selectedSpec !== null && blueprint.m1Specs[selectedSpec] && (
        <BlueprintSpecModal
          spec={blueprint.m1Specs[selectedSpec]}
          index={selectedSpec}
          milestoneLabel={milestoneLabel}
          onClose={() => setSelectedSpec(null)}
        />
      )}
    </div>
  )
}
