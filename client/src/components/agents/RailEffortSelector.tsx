import { useTranslation } from 'react-i18next'
import { Gauge } from 'lucide-react'
import {
  defaultReasoningEffortForProvider,
  reasoningEffortsForProvider,
  type ProviderReasoningEffort,
} from '../../lib/provider-capabilities'

export type ReasoningEffort = ProviderReasoningEffort

/**
 * Compact reasoning-effort dropdown for the rail header (loop mode). Mirrors
 * RailModelSelector's dense styling. Codex applies effort natively; Claude
 * applies it softly — both honour it, so the selector shows for either engine.
 */
export function RailEffortSelector({
  value,
  provider,
  model,
  onChange,
}: {
  value: ReasoningEffort | null | undefined
  provider: string
  model: string
  onChange: (value: ReasoningEffort) => void
}) {
  const { t } = useTranslation('dashboard')
  const efforts = reasoningEffortsForProvider(provider, model)
  const current = value && efforts.includes(value)
    ? value
    : defaultReasoningEffortForProvider(provider, model) ?? ''
  return (
    <div
      className="inline-flex items-center"
      title={t('railControls.effortTitle')}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Gauge className="w-3 h-3 text-muted-foreground mr-1" />
      <select
        value={current}
        aria-label={t('railControls.effortTitle')}
        data-testid="rail-effort-selector"
        onChange={(e) => onChange(e.target.value as ReasoningEffort)}
        className="h-5 text-[10px] rounded border border-border/50 bg-transparent text-muted-foreground hover:text-foreground pr-4 pl-1 focus:outline-none focus:ring-1 focus:ring-primary/40"
      >
        {efforts.map((e) => (
          <option key={e} value={e}>{e}</option>
        ))}
      </select>
    </div>
  )
}
