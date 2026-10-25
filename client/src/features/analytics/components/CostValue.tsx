import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import { formatUsd } from '../lib/format'

export interface CostValueProps {
  usd: number | null | undefined
  /** The amount is a pricing-table estimate, not a provider-billed cost. */
  estimated?: boolean
  /** Cost telemetry is missing; renders the placeholder instead of an amount. */
  unavailable?: boolean
  /** Rendered when the amount is missing or unavailable. */
  placeholder?: string
  className?: string
}

/**
 * Single rendering point for a USD cost. Estimates read `~$x`, carry the
 * estimate tooltip and an sr-only "estimated" so they stay distinguishable
 * from billed cost for every user (AGENTS invariant).
 */
export function CostValue({ usd, estimated = false, unavailable = false, placeholder = '—', className }: CostValueProps) {
  const { t, i18n } = useTranslation('analytics')
  if (unavailable || usd == null || !Number.isFinite(usd)) {
    return <span className={className}>{placeholder}</span>
  }
  const amount = formatUsd(usd, i18n?.language)
  if (!estimated) return <span className={cn('num', className)}>{amount}</span>
  return (
    <span className={cn('num', className)} title={t('table.estimatedCostTooltip')}>
      <span aria-hidden>~</span>
      {amount}
      <span className="sr-only"> {t('common:estimated')}</span>
    </span>
  )
}
