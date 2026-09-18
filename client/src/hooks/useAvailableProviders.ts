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
  /** Display name per provider id (a local engine's connection label). */
  labels: Record<string, string>
  loading: boolean
}

/**
 * Registry-backed provider discovery shared by selectors that do not own a
 * project yet (Agent and Project Builder). Non-provider response metadata is
 * kept out of the provider list.
 */
export function useAvailableProviders(options: { enabled?: boolean } = {}): AvailableProviderCatalog {
  const enabled = options.enabled !== false
  const [catalog, setCatalog] = useState<AvailableProviderCatalog>({
    available: {},
    availableIds: [],
    issues: {},
    launchDescriptors: {},
    labels: {},
    loading: true,
  })

  useEffect(() => {
    if (!enabled) return
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
          if (id === 'tiers' || id === 'providerIssues' || id === 'launchDescriptors' || id === 'labels') continue
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
        const rawLabels: Record<string, string> = {}
        if (data.labels && typeof data.labels === 'object') {
          for (const [id, label] of Object.entries(data.labels as Record<string, unknown>)) if (typeof label === 'string') rawLabels[id] = label
        }
        setCatalog({
          available,
          availableIds: Object.keys(available).filter((id) => available[id]),
          issues: rawIssues,
          launchDescriptors: rawLaunchDescriptors,
          labels: rawLabels,
          loading: false,
        })
      })
      .catch(() => {
        if (alive) setCatalog((previous) => ({ ...previous, loading: false }))
      })
    return () => { alive = false }
  }, [enabled])

  return catalog
}
