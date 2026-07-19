import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import type { AgentModel } from '../../lib/agent-api'
import { AgentToolbarSelector } from './AgentToolbarSelector'
import { CustomModelAliasInput } from '../CustomModelAliasInput'

interface Props {
  models: AgentModel[]
  model: string | null
  onSelect: (model: string) => void
  status?: 'loading' | 'ready' | 'error'
  disabled?: boolean
  testId?: string
  customModelAliases?: boolean
}

/** Per-provider model picker using the Agent toolbar's shared visual language. */
export function AgentModelSelector({
  models,
  model,
  onSelect,
  status = 'ready',
  disabled = false,
  testId = 'agent-model-selector',
  customModelAliases = false,
}: Props) {
  const { t } = useTranslation('agent')

  // Resolve the shown value: explicit model, else the catalog default, else first.
  const current = model ?? models.find((m) => m.default)?.value ?? models[0]?.value ?? ''
  const placeholder = status === 'loading'
    ? t('model.loading')
    : status === 'error'
      ? t('model.unavailable')
      : t('model.label')

  if (customModelAliases) {
    return (
      <div className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-primary" aria-hidden />
        <CustomModelAliasInput
          value={current}
          options={models}
          onCommit={onSelect}
          disabled={disabled || status !== 'ready'}
          ariaLabel={t('model.label')}
          testId={testId}
          placeholder={placeholder}
          className="h-6 w-48 border-border/40 px-1.5 text-xs"
        />
      </div>
    )
  }

  return (
    <AgentToolbarSelector
      label={t('model.label')}
      value={current}
      options={models.map((m) => ({ value: m.value, label: m.label }))}
      icon={Sparkles}
      onSelect={onSelect}
      placeholder={placeholder}
      disabled={disabled || status !== 'ready'}
      testId={testId}
    />
  )
}
