import { useCallback, useEffect, useRef, useState } from 'react'
import { getAppResources, type AppResourcesSnapshot } from '../lib/app-resources-api'

/** Refresh cadence while the Resources popover is open. */
export const APP_RESOURCES_POLL_MS = 3000
/** Refresh cadence for the status-bar summary while the popover is closed (and the window visible). */
export const APP_RESOURCES_IDLE_POLL_MS = 30_000

/** App-wide resources: one read on mount, every 3 s while `open`, otherwise a slow refresh for the trigger. */
export function useAppResources(open: boolean) {
  const [snapshot, setSnapshot] = useState<AppResourcesSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    try {
      const next = await getAppResources(current.signal)
      if (!current.signal.aborted) { setSnapshot(next); setError(null) }
    } catch (err) {
      if (!current.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, open ? APP_RESOURCES_POLL_MS : APP_RESOURCES_IDLE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  useEffect(() => () => controller.current?.abort(), [])

  return { snapshot, error, refresh }
}
