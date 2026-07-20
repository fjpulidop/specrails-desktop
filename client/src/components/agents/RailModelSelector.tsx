import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { defaultModelForProvider, modelsForProvider } from '../../lib/loop-run-models'
import { providerSupportsCustomModelAliases } from '../../lib/provider-capabilities'
import { isSafeCustomModelAlias } from '../../lib/model-alias'
import { CustomModelAliasInput } from '../CustomModelAliasInput'

export type FreestyleModel = string

interface Props {
  /** Provider whose adapter validates this model. */
  provider?: string
  /** Selected model. null/undefined/invalid = provider default. */
  value: FreestyleModel | null | undefined
  onChange: (value: FreestyleModel) => void
  testId?: string
  ariaLabel?: string
}

/**
 * Compact rail-header model selector, shown only for freestyle rails. Lets the
 * user pick which provider model runs the autonomous implementation.
 */
export function RailModelSelector({
  provider = 'claude',
  value,
  onChange,
  testId = 'rail-model-selector',
  ariaLabel,
}: Props) {
  const { t } = useTranslation('agents')
  const models = modelsForProvider(provider)
  const customModelAliases = providerSupportsCustomModelAliases(provider)
  const current = value && (
    models.some((model) => model.value === value)
    || (customModelAliases && isSafeCustomModelAlias(value))
  )
    ? value
    : defaultModelForProvider(provider)
  const label = ariaLabel ?? t('railSelectors.modelTitle')
  return (
    <div
      className="inline-flex items-center"
      title={label}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Sparkles className="w-3 h-3 text-accent-highlight mr-1" />
      {customModelAliases ? (
        <CustomModelAliasInput
          value={current}
          options={models}
          ariaLabel={label}
          testId={testId}
          className="h-5 w-48 border-border/50 px-1 text-[10px] text-muted-foreground hover:text-foreground"
          onCommit={onChange}
        />
      ) : (
        <select
          value={current}
          aria-label={label}
          data-testid={testId}
          onChange={(e) => onChange(e.target.value as FreestyleModel)}
          className="h-5 text-[10px] rounded border border-border/50 bg-transparent text-muted-foreground hover:text-foreground pr-4 pl-1 focus:outline-none focus:ring-1 focus:ring-primary/40"
        >
          {models.map((model) => (
            <option key={model.value} value={model.value}>
              {model.label}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
