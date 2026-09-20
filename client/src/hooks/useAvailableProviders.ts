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

  // Refetch on focus (throttled) and on the app-global detection broadcast: the
  // catalog used to be fetched ONCE per mount, so a selector could keep offering
  // an engine a later detection cycle had dropped — and the consumer that owns
  // the default would then fight the user's pick. One source, one freshness.
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let last = 0
    const refresh = (): void => {
      const now = Date.now()
      if (now - last < 30_000) return
      last = now
      setRevision((r) => r + 1)
    }
    const onDetected = (): void => { last = 0; refresh() }
    window.addEventListener('focus', refresh)
    window.addEventListener('specrails:providers-detected-changed', onDetected)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('specrails:providers-detected-changed', onDetected)
    }
  }, [enabled])

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
  }, [enabled, revision])

  return catalog
}
