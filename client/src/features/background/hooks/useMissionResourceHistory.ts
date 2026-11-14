import { useCallback, useEffect, useRef, useState } from 'react'
import { getMissionResources, type MissionResourcesSnapshot } from '../lib/mission-resources-api'

export const MISSION_RESOURCES_POLL_MS = 3000

/** Loads a mission's live resources and its server-recorded history while `watching` (the popover is open):
 * once on open, then every few seconds. The server records history on its own, so nothing is sampled here. */
export function useMissionResourceHistory(projectId: string | null, chatId: string | null, watching: boolean) {
  const key = projectId && chatId ? `${projectId}:${chatId}` : null
  const [state, setState] = useState<{ key: string | null; latest: MissionResourcesSnapshot | null; error: string | null }>({ key, latest: null, error: null })
  const keyRef = useRef(key)
  keyRef.current = key

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!projectId || !chatId) return
    const forKey = `${projectId}:${chatId}`
    try {
      const latest = await getMissionResources(projectId, chatId, signal)
      if (keyRef.current === forKey && !signal?.aborted) setState({ key: forKey, latest, error: null })
    } catch (err) {
      if (keyRef.current === forKey && !signal?.aborted) {
        setState(prev => ({ key: forKey, latest: prev.key === forKey ? prev.latest : null, error: err instanceof Error ? err.message : String(err) }))
      }
    }
  }, [projectId, chatId])

  useEffect(() => {
    if (!watching || !key) return
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => { void refresh(controller.signal) }, MISSION_RESOURCES_POLL_MS)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [watching, key, refresh])

  const current = state.key === key
  const latest = current ? state.latest : null
  return { samples: latest?.history ?? [], latest, error: current ? state.error : null, refresh }
}
