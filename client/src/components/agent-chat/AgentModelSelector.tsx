import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { getAgentModels, type AgentModel } from '../../lib/agent-api'

interface Props {
  provider: string
  model: string | null
  onSelect: (model: string) => void
}

/** Per-provider model dropdown. Fetches the provider's catalog on provider change. */
export function AgentModelSelector({ provider, model, onSelect }: Props) {
  const { t } = useTranslation('agent')
  const [models, setModels] = useState<AgentModel[]>([])

  useEffect(() => {
    let alive = true
    getAgentModels(provider)
      .then((r) => { if (alive) setModels(r.models) })
      .catch(() => { if (alive) setModels([]) })
    return () => { alive = false }
  }, [provider])

  // Resolve the shown value: explicit model, else the catalog default, else first.
  const current = model ?? models.find((m) => m.default)?.value ?? models[0]?.value ?? ''

  return (
    <select
      value={current}
      onChange={(e) => onSelect(e.target.value)}
      aria-label={t('model.label')}
      data-agent-interactive
      className="rounded-lg border border-border/60 bg-surface/70 px-2.5 py-1 text-xs text-foreground outline-none hover:bg-surface"
    >
      {models.map((m) => (
        <option key={m.value} value={m.value}>{m.label}</option>
      ))}
    </select>
  )
}
