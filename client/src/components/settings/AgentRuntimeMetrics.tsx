import { useTranslation } from 'react-i18next'
import type { RuntimeEfficiency } from '../../lib/runtime-efficiency'
import { formatElapsed } from '../../lib/format-duration'

export function AgentRuntimeMetrics({ metrics }: { metrics: RuntimeEfficiency }) {
  const { t, i18n } = useTranslation('agentRuntime')
  const number = (value: number | null) => value === null ? t('metrics.unknown') : new Intl.NumberFormat(i18n.language).format(value)
  const cost = (value: number | null) => value === null ? t('metrics.unknown') : new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)
  const time = (value: number | null) => value === null ? t('metrics.unknown') : formatElapsed(value)
  const total = metrics.total
  const rows = [
    ['duration', time(total.durationMs)], ['agentTime', time(total.agentDurationMs)], ['cost', cost(total.costUsd)],
    ['providerCalls', number(total.providerCalls)], ['toolCalls', number(total.toolCalls)],
    ['input', number(total.inputTokens)], ['output', number(total.outputTokens)],
    ['uncached', number(total.uncachedInputTokens)], ['cacheRead', number(total.cacheReadInputTokens)], ['cacheWrite', number(total.cacheWriteInputTokens)],
  ]
  return <details className="rounded-md border border-border p-3 text-xs">
    <summary className="cursor-pointer font-medium">{t('metrics.title')}</summary>
    <p className="mt-2 text-muted-foreground">{t('metrics.hint')}</p>
    <dl className="my-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {rows.map(([key, value]) => <div key={key}><dt className="text-muted-foreground">{t(`metrics.${key}`)}</dt><dd className="tabular-nums">{value}</dd></div>)}
    </dl>
    {total.measuredAttempts < total.attempts && <p className="mb-2 text-muted-foreground">{t('metrics.partial')}</p>}
    <div className="overflow-x-auto"><table className="w-full text-left">
      <caption className="sr-only">{t('metrics.phases')}</caption>
      <thead><tr>{['phase', 'attempts', 'duration', 'providerCalls', 'cost'].map(key => <th key={key} scope="col" className="p-1 font-medium">{t(`metrics.${key}`)}</th>)}</tr></thead>
      <tbody>{metrics.phases.map(phase => <tr key={phase.stepId} className="border-t border-border">
        <th scope="row" className="p-1 font-normal">{t(`roles.${phase.stepId}`, { defaultValue: phase.stepId })}{phase.providers.length > 0 && <span className="block max-w-48 break-words text-muted-foreground">{[...phase.providers, ...phase.models].join(' · ')}</span>}</th>
        <td className="p-1 tabular-nums">{number(phase.attempts)}</td><td className="p-1 tabular-nums">{time(phase.durationMs)}</td><td className="p-1 tabular-nums">{number(phase.providerCalls)}</td><td className="p-1 tabular-nums">{cost(phase.costUsd)}</td>
      </tr>)}</tbody>
    </table></div>
  </details>
}
