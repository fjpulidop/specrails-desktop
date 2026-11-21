import { useSyncExternalStore } from 'react'
import { startupQueue } from '../lib/startup-queue'

/** The startup queue's current reports and holds (see `lib/startup-queue.ts`). */
export function useStartupQueue() {
  return useSyncExternalStore(startupQueue.subscribe, startupQueue.getSnapshot)
}
