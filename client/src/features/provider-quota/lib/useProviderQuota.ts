import { useSyncExternalStore } from 'react'
import { quotaStore } from './quota-store'
import type { ProviderQuota } from './types'

export function useProviderQuotas(): ProviderQuota[] {
  return useSyncExternalStore(quotaStore.subscribe, quotaStore.getSnapshot).providers
}

export function useProviderQuota(providerId: string | null | undefined): ProviderQuota | null {
  const providers = useProviderQuotas()
  return providerId ? providers.find((provider) => provider.providerId === providerId) ?? null : null
}
