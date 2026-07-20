import { useEffect, useState } from 'react'
import { API_ORIGIN } from '../lib/origin'

export interface ProviderAvailabilityIssue {
  code: string
  message: string
}

export interface AvailableProviderCatalog {
  available: Record<string, boolean>
  availableIds: string[]
  issues: Record<string, ProviderAvailabilityIssue>
  launchDescriptors: Record<string, { command: string; args: string[] }>
  loading: boolean
}

/**
 * Registry-backed provider discovery shared by selectors that do not own a
 * project yet (Agent and Project Builder). Non-provider response metadata is
 * kept out of the provider list.
 */
export function useAvailableProviders(): AvailableProviderCatalog {
  const [catalog, setCatalog] = useState<AvailableProviderCatalog>({
    available: {},
    availableIds: [],
    issues: {},
    launchDescriptors: {},
    loading: true,
  })

  useEffect(() => {
    let alive = true
    fetch(`${API_ORIGIN}/api/available-providers`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<Record<string, unknown>>
      })
      .then((data) => {
        if (!alive) return
        const available: Record<string, boolean> = {}
        for (const [id, value] of Object.entries(data)) {
          if (id === 'tiers' || id === 'providerIssues' || id === 'launchDescriptors') continue
          if (typeof value === 'boolean') available[id] = value
        }
        const rawIssues =
          data.providerIssues && typeof data.providerIssues === 'object'
            ? data.providerIssues as Record<string, ProviderAvailabilityIssue>
            : {}
        const rawLaunchDescriptors =
          data.launchDescriptors && typeof data.launchDescriptors === 'object'
            ? data.launchDescriptors as Record<string, { command: string; args: string[] }>
            : {}
        setCatalog({
          available,
          availableIds: Object.keys(available).filter((id) => available[id]),
          issues: rawIssues,
          launchDescriptors: rawLaunchDescriptors,
          loading: false,
        })
      })
      .catch(() => {
        if (alive) setCatalog((previous) => ({ ...previous, loading: false }))
      })
    return () => { alive = false }
  }, [])

  return catalog
}
