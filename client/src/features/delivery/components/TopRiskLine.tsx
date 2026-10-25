/**
 * One-line top risk from the reviewer's risk brief (Core `reviewBrief: 1`) for
 * the mission and dashboard delivery cards: severity chip + what to look at.
 * Renders nothing when the delivery carries no listed risk.
 */
import { useTranslation } from 'react-i18next'
import type { PrDeliveryRiskSummary } from '../../../types'
import { SeverityChip } from './review-packet/WhatToLookAt'

export function TopRiskLine({ summary, className = '' }: { summary: PrDeliveryRiskSummary | null | undefined; className?: string }) {
  const { t } = useTranslation('packet')
  const top = summary?.top
  if (!summary || !top) return null
  const total = summary.highCount + summary.mediumCount + summary.lowCount
  return (
    <div className={`flex min-w-0 items-center gap-1.5 text-caption ${className}`} data-testid="top-risk-line" title={top.ref ?? undefined}>
      <span className="shrink-0 text-muted-foreground">{t('brief.topRisk')}</span>
      <SeverityChip severity={top.severity} />
      <span className="min-w-0 truncate text-foreground">{top.whatToLookAt}</span>
      {total > 1 ? <span className="shrink-0 text-muted-foreground">{t('brief.moreRisks', { count: total - 1 })}</span> : null}
    </div>
  )
}
