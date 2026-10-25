import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { getApiBase } from '../../../lib/api'
import { useDesktop } from '../../../hooks/useDesktop'
import { useTicketDetailModal } from '../../specs/context/TicketDetailModalContext'
import type { TicketSpendingSummary, Surface } from '../types/spending'
import { SURFACE_LABEL } from '../types/spending'
import { formatUsd } from '../lib/format'

interface Props { ticketId: number }

function fmtCost(v: number): string {
  return formatUsd(v)
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

export function TicketSpendingLine({ ticketId }: Props) {
  const { t } = useTranslation('tickets')
  const [summary, setSummary] = useState<TicketSpendingSummary | null>(null)
  const navigate = useNavigate()
  const { activeProjectId } = useDesktop()
  const { closeTicketDetail } = useTicketDetailModal()

  useEffect(() => {
    // activeProjectId in deps: per-project ticket ids collide, so a project
    // switch with the same id must refetch the new project's spending.
    const ctrl = new AbortController()
    setSummary(null)
    fetch(`${getApiBase()}/tickets/${ticketId}/spending-summary`, { signal: ctrl.signal })
      .then((r) => r.ok ? r.json() as Promise<TicketSpendingSummary> : null)
      .then((d) => { if (d) setSummary(d) })
      .catch(() => { /* ignore */ })
    return () => ctrl.abort()
  }, [ticketId, activeProjectId])

  if (!summary || !summary.bySurface || !summary.totalRuns || summary.totalRuns === 0) return null

  const breakdown = (Object.entries(summary.bySurface) as Array<[Surface, { count: number; costUsd: number }]>)
    .filter(([, v]) => v.count > 0)
    .map(([s, v]) => t('spendingLine.breakdownItem', { n: v.count, label: SURFACE_LABEL[s].toLowerCase() }))
    .join(', ')
  const unpricedRuns = summary.unpricedRuns ?? 0
  const pricedRuns = summary.pricedRuns
    ?? Math.max(0, summary.totalRuns - unpricedRuns)
  const costUnavailable = unpricedRuns > 0 && pricedRuns === 0
  const costPartiallyUnavailable = unpricedRuns > 0 && pricedRuns > 0
  const turnsUnavailableRuns = summary.turnsUnavailableRuns ?? 0
  const turnsUnavailable = summary.totalTurns == null
    || (turnsUnavailableRuns > 0 && (summary.turnsReportedRuns ?? 0) === 0)
  const turnsPartiallyUnavailable = !turnsUnavailable && turnsUnavailableRuns > 0

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        closeTicketDetail()
        navigate(`/analytics?ticketId=${ticketId}`)
      }}
      className="mt-1.5 group inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      aria-label={t('spendingLine.ariaLabel')}
    >
      <span
        className="num font-medium text-foreground"
        data-testid={costUnavailable ? 'ticket-cost-unavailable' : undefined}
        title={
          costUnavailable
            ? t('spendingLine.costUnavailableTooltip')
            : costPartiallyUnavailable
              ? t('spendingLine.costPartiallyUnavailableTooltip')
              : (summary.estimatedCostUsd ?? 0) > 0
                ? t('spendingLine.estimatedTooltip')
                : undefined
        }
      >
        {costUnavailable
          ? '—'
          : `${(summary.estimatedCostUsd ?? 0) > 0 ? '~' : ''}${costPartiallyUnavailable ? '≥' : ''}${fmtCost(summary.totalCostUsd)}`}
      {(costUnavailable ? t('spendingLine.costUnavailableTooltip') : costPartiallyUnavailable ? t('spendingLine.costPartiallyUnavailableTooltip') : (summary.estimatedCostUsd ?? 0) > 0 ? t('spendingLine.estimatedTooltip') : undefined) ? <span className="sr-only"> ({costUnavailable ? t('spendingLine.costUnavailableTooltip') : costPartiallyUnavailable ? t('spendingLine.costPartiallyUnavailableTooltip') : (summary.estimatedCostUsd ?? 0) > 0 ? t('spendingLine.estimatedTooltip') : undefined})</span> : null}</span>
      <span className="text-muted-foreground">·</span>
      <span
        className="num"
        data-testid={turnsUnavailable ? 'ticket-turns-unavailable' : undefined}
        title={
          turnsUnavailable
            ? t('spendingLine.turnsUnavailableTooltip')
            : turnsPartiallyUnavailable
              ? t('spendingLine.turnsPartiallyUnavailableTooltip')
              : undefined
        }
      >
        {turnsUnavailable
          ? '—'
          : t(turnsPartiallyUnavailable ? 'spendingLine.turnsAtLeast' : 'spendingLine.turns', { count: summary.totalTurns })}
      {(turnsUnavailable ? t('spendingLine.turnsUnavailableTooltip') : turnsPartiallyUnavailable ? t('spendingLine.turnsPartiallyUnavailableTooltip') : undefined) ? <span className="sr-only"> ({turnsUnavailable ? t('spendingLine.turnsUnavailableTooltip') : turnsPartiallyUnavailable ? t('spendingLine.turnsPartiallyUnavailableTooltip') : undefined})</span> : null}</span>
      <span className="text-muted-foreground">·</span>
      <span className="num">{t('spendingLine.active', { duration: fmtDur(summary.activeDurationMs) })}</span>
      {breakdown && (
        <>
          <span className="text-muted-foreground">·</span>
          <span>{breakdown}</span>
        </>
      )}
      <ArrowRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  )
}
