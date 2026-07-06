import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'

/** Models the freestyle picker exposes (Claude aliases). Mirrors the server
 *  rails-router allow-list. */
export const FREESTYLE_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type FreestyleModel = (typeof FREESTYLE_MODELS)[number]
export const DEFAULT_FREESTYLE_MODEL: FreestyleModel = 'sonnet'

const LABELS: Record<FreestyleModel, string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
  fable: 'Fable',
}

interface Props {
  /** Selected model. null/undefined = default (sonnet). */
  value: FreestyleModel | null | undefined
  onChange: (value: FreestyleModel) => void
}

/**
 * Compact rail-header model selector, shown only for freestyle rails. Lets the
 * user pick which Claude model runs the autonomous implementation. Mirrors
 * RailEngineSelector's dense styling.
 */
export function RailModelSelector({ value, onChange }: Props) {
  const { t } = useTranslation('agents')
  const current = value ?? DEFAULT_FREESTYLE_MODEL
  return (
    <div
      className="inline-flex items-center"
      title={t('railSelectors.modelTitle')}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Sparkles className="w-3 h-3 text-accent-highlight mr-1" />
      <select
        value={current}
        aria-label={t('railSelectors.modelTitle')}
        data-testid="rail-model-selector"
        onChange={(e) => onChange(e.target.value as FreestyleModel)}
        className="h-5 text-[10px] rounded border border-border/50 bg-transparent text-muted-foreground hover:text-foreground pr-4 pl-1 focus:outline-none focus:ring-1 focus:ring-primary/40"
      >
        {FREESTYLE_MODELS.map((m) => (
          <option key={m} value={m}>
            {LABELS[m]}
          </option>
        ))}
      </select>
    </div>
  )
}
