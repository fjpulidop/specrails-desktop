import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import type { AgentModel } from '../../lib/agent-api'
import { AgentToolbarSelector } from './AgentToolbarSelector'

interface Props {
  models: AgentModel[]
  model: string | null
  onSelect: (model: string) => void
  status?: 'loading' | 'ready' | 'error'
}

/** Per-provider model picker using the Agent toolbar's shared visual language. */
export function AgentModelSelector({ models, model, onSelect, status = 'ready' }: Props) {
  const { t } = useTranslation('agent')

  // Resolve the shown value: explicit model, else the catalog default, else first.
  const current = model ?? models.find((m) => m.default)?.value ?? models[0]?.value ?? ''
  const placeholder = status === 'loading'
    ? t('model.loading')
    : status === 'error'
      ? t('model.unavailable')
      : t('model.label')

  return (
    <AgentToolbarSelector
      label={t('model.label')}
      value={current}
      options={models.map((m) => ({ value: m.value, label: m.label }))}
      icon={Sparkles}
      onSelect={onSelect}
      placeholder={placeholder}
      disabled={status !== 'ready'}
      testId="agent-model-selector"
    />
  )
}
