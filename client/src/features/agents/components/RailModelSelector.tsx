import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { defaultModelForProvider, modelsForProvider } from '../../loops/lib/loop-run-models'
import { providerSupportsCustomModelAliases } from '../../providers/lib/provider-capabilities'
import { isSafeCustomModelAlias } from '../../providers/lib/model-alias'
import { CustomModelAliasInput } from '../../providers/components/CustomModelAliasInput'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select'

/** A provider model id (or a safe custom alias) chosen for a rail's loop runs. */
export type RailModel = string

interface Props {
  /** Provider whose adapter validates this model. */
  provider?: string
  /** Selected model. null/undefined/invalid = provider default. */
  value: RailModel | null | undefined
  onChange: (value: RailModel) => void
  testId?: string
  ariaLabel?: string
}

/**
 * Compact rail-header model selector (custom-loop rails). Lets the user pick
 * which provider model the loop's AI steps run on.
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
          className="h-6 w-48 border-border/50 px-1 text-caption text-muted-foreground hover:text-foreground"
          onCommit={onChange}
        />
      ) : (
        <Select value={current} onValueChange={(next) => onChange(next as RailModel)}>
          <SelectTrigger
            size="sm"
            aria-label={label}
            data-testid={testId}
            className="border-border/50 bg-transparent text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 max-w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {models.map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
