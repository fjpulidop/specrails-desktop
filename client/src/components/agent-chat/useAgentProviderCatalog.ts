import { useEffect, useState } from 'react'
import { getAgentModels, type AgentModel } from '../../lib/agent-api'

export interface AgentProviderCatalog {
  provider: string
  models: AgentModel[]
  efforts: string[]
  customModelAliases: boolean
  supportsImageInput: boolean
  status: 'loading' | 'ready' | 'error'
}

function pendingCatalog(provider: string): AgentProviderCatalog {
  return {
    provider,
    models: [],
    efforts: [],
    customModelAliases: false,
    // Preserve the existing optimistic attachment behaviour while the
    // capability endpoint is pending. The ready response remains authoritative.
    supportsImageInput: true,
    status: 'loading',
  }
}

/**
 * Fetch the provider catalog once for the whole composer. Results carry their
 * provider identity so a provider switch can never render stale models or
 * effort tiers while the next request is in flight.
 */
export function useAgentProviderCatalog(provider: string): AgentProviderCatalog {
  const [catalog, setCatalog] = useState<AgentProviderCatalog>(() => pendingCatalog(provider))

  useEffect(() => {
    let alive = true
    setCatalog(pendingCatalog(provider))
    getAgentModels(provider)
      .then((result) => {
        if (!alive) return
        setCatalog({
          provider,
          models: result.models,
          efforts: result.efforts,
          customModelAliases: result.customModelAliases,
          supportsImageInput: result.supportsImageInput,
          status: 'ready',
        })
      })
      .catch(() => {
        if (!alive) return
        setCatalog({ ...pendingCatalog(provider), status: 'error' })
      })
    return () => { alive = false }
  }, [provider])

  // Effects run after render. This guard closes the single render where React
  // has received a new provider prop but still holds the previous state object.
  return catalog.provider === provider ? catalog : pendingCatalog(provider)
}
