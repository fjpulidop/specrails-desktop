import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import { useProviderBilling } from '../../../hooks/useLaunchForecast'
import { formatUsdBand } from '../../../lib/launch-forecast'
import { formatUsd } from '../../../lib/format-usd'
import { sampleBilling, type SampleEstimate, type SamplePreset } from '../lib/sample-model'

interface SampleCostStatementProps {
  preset: SamplePreset
  estimate: SampleEstimate
  className?: string
}

/**
 * The cost, said BEFORE anything runs. Same honesty rule as the launch forecast:
 * a dollar figure only when the provider is positively known to be billed per
 * use; a plan-billed provider gets "no extra charge", a local engine "no API
 * cost", and anything unknown shows the figure as conditional. It is always an
 * estimate, never a quote, and a cloud run states its soft cap.
 */
export function SampleCostStatement({ preset, estimate, className }: SampleCostStatementProps) {
  const { t, i18n } = useTranslation('onboarding')
  const billing = useProviderBilling(preset.local ? null : preset.provider)
  const kind = sampleBilling(preset, billing)
  const lang = i18n.language || 'en'
  const time = t('cost.minutes', { low: estimate.minutes[0], high: estimate.minutes[1] })
  const usd = formatUsdBand(estimate.usd[0], estimate.usd[1], lang)
  return (
    <div className={cn('space-y-0.5 text-caption text-muted-foreground', className)} data-testid="sample-cost" data-billing={kind}>
      <p className="text-label text-foreground">{t(`cost.${kind}`, { usd, time })}</p>
      <p>{t('cost.using', { model: preset.model, provider: preset.provider })}</p>
      {preset.runCapUsd !== null && <p>{t('cost.cap', { cap: formatUsd(preset.runCapUsd, lang) })}</p>}
    </div>
  )
}
