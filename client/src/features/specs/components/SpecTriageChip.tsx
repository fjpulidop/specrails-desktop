import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Gauge, Loader2, RefreshCw, ShieldAlert, Database, Plug } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../components/ui/tooltip'
import { cn } from '../../../lib/utils'
import { anyTriage, recalculateSpecTriage, type SpecTriage, type SpecTriageReady } from '../lib/spec-triage'
import type { LocalTicket } from '../../../types'

/** Built-in loop ids → their existing rail labels (dashboard namespace). */
const FACTORY_LABEL_KEYS: Record<string, string> = {
  'factory:implement': 'dashboard:railControls.implement',
  'factory:freestyle': 'dashboard:railControls.freestyle',
  'factory:sdd-quick-openspec': 'dashboard:railControls.openspec',
}

const CONFIDENCE_DOT: Record<SpecTriageReady['confidence'], string> = {
  high: 'bg-accent-success',
  medium: 'bg-accent-warning',
  low: 'bg-muted-foreground/60',
}

/** Label of a recommended loop: built-in label, else the name stored at triage time. */
export function triageLoopLabel(t: (key: string) => string, triage: Pick<SpecTriageReady, 'recommendedLoop' | 'recommendedLoopName'>): string {
  const key = FACTORY_LABEL_KEYS[triage.recommendedLoop]
  return key ? t(key) : triage.recommendedLoopName ?? triage.recommendedLoop
}

/** One-line structured summary ("S · SDD Quick · high"), shared with the mission rail card. */
export function TriageSummaryLine({ triage, className }: { triage: SpecTriageReady; className?: string }) {
  const { t } = useTranslation('specs')
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} data-testid="triage-summary-line">
      <span className="font-mono font-semibold">{triage.size}</span>
      <span aria-hidden>·</span>
      <span className="truncate">{triageLoopLabel(t, triage)}</span>
      <span aria-hidden>·</span>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', CONFIDENCE_DOT[triage.confidence])} aria-hidden />
      <span>{t(`triage.confidence.${triage.confidence}`)}</span>
    </span>
  )
}

interface Props {
  ticket: LocalTicket
  /** Test seam / override for the recalculation call. */
  onRecalculate?: (ticketId: number) => Promise<SpecTriage>
}

/**
 * Triage chip on the spec card: size · recommended loop · confidence. The
 * tooltip (hoverable) explains the rationale, the risk flags and the likely
 * files, and offers Recalculate. A draft/todo spec without a triage shows a
 * hover-only ghost chip that computes it on demand.
 */
export function SpecTriageChip({ ticket, onRecalculate }: Props) {
  const { t } = useTranslation('specs')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const triage = anyTriage(ticket)
  const canCompute = ticket.status === 'draft' || ticket.status === 'todo'
  if (ticket.is_epic || (!triage && !canCompute)) return null

  const recalculate = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await (onRecalculate ?? recalculateSpecTriage)(ticket.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  const recalcButton = (
    <button
      type="button"
      onClick={recalculate}
      onPointerDown={stop}
      disabled={busy}
      className="mt-1.5 inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-foreground/80 hover:bg-muted/60 disabled:opacity-60"
      data-testid={`triage-recalculate-${ticket.id}`}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
      {busy ? t('triage.recalculating') : t('triage.recalculate')}
    </button>
  )

  if (!triage) {
    return (
      <button
        type="button"
        onClick={recalculate}
        onPointerDown={stop}
        disabled={busy}
        title={t('triage.computeTitle')}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-dashed border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
        data-testid={`triage-compute-${ticket.id}`}
      >
        {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden /> : <Gauge className="h-2.5 w-2.5" aria-hidden />}
        {t('triage.compute')}
      </button>
    )
  }

  const chip = triage.status === 'ready' ? (
    <span className="inline-flex max-w-[11rem] items-center gap-1 rounded-md border border-accent-info/40 bg-accent-info/5 px-1.5 py-0.5 text-[11px] text-accent-info">
      <Gauge className="h-2.5 w-2.5 shrink-0" aria-hidden />
      <TriageSummaryLine triage={triage} />
    </span>
  ) : (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]',
      triage.status === 'failed' ? 'border-accent-warning/50 text-accent-warning' : 'border-border/60 text-muted-foreground',
    )}>
      <Gauge className="h-2.5 w-2.5" aria-hidden />
      {t(triage.status === 'failed' ? 'triage.failed' : 'triage.unavailable')}
    </span>
  )

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={stop}
            onPointerDown={stop}
            className="shrink-0 rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
            aria-label={t('triage.ariaLabel', { id: ticket.id })}
            data-testid={`triage-chip-${ticket.id}`}
          >
            {chip}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-xs space-y-1 text-[11px] leading-snug" onClick={stop} onPointerDown={stop}>
          {triage.status === 'ready' ? (
            <>
              <div className="font-medium text-foreground">
                {t('triage.recommends', { loop: triageLoopLabel(t, triage) })}
              </div>
              {triage.rationale && <p className="text-foreground/75">{triage.rationale}</p>}
              <div className="flex flex-wrap gap-1 pt-0.5">
                {triage.publicInterfaces && <Flag icon={Plug} label={t('triage.flags.publicInterfaces')} />}
                {triage.dataModel && <Flag icon={Database} label={t('triage.flags.dataModel')} />}
                {triage.securitySurface && <Flag icon={ShieldAlert} label={t('triage.flags.securitySurface')} />}
                {!triage.publicInterfaces && !triage.dataModel && !triage.securitySurface && (
                  <span className="text-[11px] text-muted-foreground">{t('triage.flags.none')}</span>
                )}
              </div>
              {triage.filesLikely.length > 0 && (
                <div className="pt-0.5">
                  <div className="text-xs font-medium text-muted-foreground">{t('triage.filesLikely')}</div>
                  <ul className="font-mono text-[11px] text-foreground/70">
                    {triage.filesLikely.slice(0, 5).map((f) => <li key={f} className="truncate">{f}</li>)}
                    {triage.filesLikely.length > 5 && <li>{t('triage.moreFiles', { count: triage.filesLikely.length - 5 })}</li>}
                  </ul>
                </div>
              )}
              <div className="text-[11px] text-muted-foreground">
                {triage.costUsd != null
                  ? t('triage.modelCost', { model: triage.model, cost: triage.costUsd.toFixed(4) })
                  : t('triage.modelOnly', { model: triage.model })}
              </div>
            </>
          ) : (
            <p className="text-foreground/75">
              {triage.status === 'failed' ? t('triage.failedDetail', { error: triage.error }) : t('triage.unavailableDetail', { reason: triage.reason })}
            </p>
          )}
          {error && <p className="text-accent-warning" role="alert">{t('triage.recalculateFailed')}</p>}
          {recalcButton}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function Flag({ icon: Icon, label }: { icon: typeof Plug; label: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded border border-accent-warning/50 px-1 py-px text-[11px] text-accent-warning">
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {label}
    </span>
  )
}
