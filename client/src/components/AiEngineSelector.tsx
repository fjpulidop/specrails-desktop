import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import { providerLabel } from '../lib/provider-capabilities'
import { useProviderDetection } from '../hooks/useProviderDetection'

interface AiEngineSelectorProps {
  /** Currently selected provider id. */
  value: string
  /** Installed providers to choose from. */
  providers: readonly string[]
  onChange: (next: string) => void
  disabled?: boolean
  ariaLabel?: string
  className?: string
}

/**
 * AI Engine selector for multi-provider projects. Renders nothing when only one
 * provider is installed (single-provider projects behave exactly as before —
 * there is no engine to pick). Used by Add Spec, the rails launcher, etc.
 */
export function AiEngineSelector({
  value,
  providers,
  onChange,
  disabled,
  ariaLabel,
  className,
}: AiEngineSelectorProps) {
  const { t } = useTranslation('addspec')
  const detection = useProviderDetection()
  if (!providers || providers.length <= 1) return null
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v)}
      disabled={disabled}
    >
      <SelectTrigger
        className={className ?? 'h-8 w-[130px] text-xs gap-1.5'}
        aria-label={ariaLabel ?? t('aiEngine.label')}
        data-testid="ai-engine-selector"
      >
        <SelectValue placeholder={t('aiEngine.label')} />
      </SelectTrigger>
      <SelectContent>
        {providers.map((p) => {
          const unauthenticated = detection.providers[p]?.authState === 'unauthenticated'
          return (
            <SelectItem key={p} value={p}>
              <span className="inline-flex items-center gap-1.5">
                {providerLabel(p)}
                {unauthenticated && (
                  <span
                    className="rounded-full bg-accent-warning/15 px-1.5 py-px text-[10px] leading-4 text-accent-warning"
                    title={t('aiEngine.notSignedIn')}
                  >
                    {t('aiEngine.notSignedIn')}
                  </span>
                )}
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
