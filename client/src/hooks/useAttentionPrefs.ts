import { useCallback, useContext, useEffect, useId, useSyncExternalStore } from 'react'
import { SharedWebSocketContext } from './useSharedWebSocket'
import type { AttentionPrefs } from '../lib/attention/attention-policy'
import { attentionPrefsStore, type AttentionPrefsPatch, type AttentionPrefsStore } from '../lib/attention/attention-prefs-store'

export interface UseAttentionPrefs {
  prefs: AttentionPrefs
  loaded: boolean
  update: (patch: AttentionPrefsPatch) => Promise<AttentionPrefs>
}

/**
 * The app-wide attention prefs (Settings ▸ Notifications), read once and kept
 * current by the server's `desktop.attention_prefs` broadcast, so a change in
 * the settings window applies everywhere at once.
 */
export function useAttentionPrefs(store: AttentionPrefsStore = attentionPrefsStore): UseAttentionPrefs {
  const prefs = useSyncExternalStore(store.subscribe, store.get, store.get)
  const loaded = useSyncExternalStore(store.subscribe, store.loaded, store.loaded)
  useEffect(() => { void store.ready() }, [store])

  const ws = useContext(SharedWebSocketContext)
  const handlerId = `attention-prefs:${useId()}`
  const registerHandler = ws?.registerHandler
  const unregisterHandler = ws?.unregisterHandler
  useEffect(() => {
    if (!registerHandler || !unregisterHandler) return
    registerHandler(handlerId, (message) => {
      const msg = message as { type?: unknown; prefs?: unknown } | null
      if (msg && msg.type === 'desktop.attention_prefs') store.apply(msg.prefs)
    })
    return () => unregisterHandler(handlerId)
  }, [registerHandler, unregisterHandler, handlerId, store])

  const update = useCallback((patch: AttentionPrefsPatch) => store.update(patch), [store])
  return { prefs, loaded, update }
}
