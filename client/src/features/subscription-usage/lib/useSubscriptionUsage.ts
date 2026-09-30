import { useSyncExternalStore } from 'react'
import { usageStore } from './store'
export function useSubscriptionUsage() {
  const state = useSyncExternalStore(usageStore.subscribe, usageStore.getSnapshot)
  return { ...state, refresh: usageStore.refresh }
}
