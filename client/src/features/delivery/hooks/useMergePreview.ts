import { useContext, useEffect, useId, useSyncExternalStore } from 'react'
import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { getApiBase } from '../../../lib/api'
import {
  mergePreviewVersion, nudgeMergePreviews, readMergePreview, subscribeMergePreviews,
} from '../lib/merge-preview-store'
import type { DeliveryMergePreview } from '../lib/merge-preview'

/**
 * The merge preview of one delivery of the active project (null while unknown).
 * Every strip shares one request per project (merge-preview-store.ts).
 */
export function useMergePreview(deliveryId: string | null | undefined): DeliveryMergePreview | null {
  const projectId = activeProjectOf()
  const ws = useContext(SharedWebSocketContext)
  const handlerId = `merge-preview-${useId()}`
  useSyncExternalStore(
    (listener) => (projectId && deliveryId ? subscribeMergePreviews(projectId.id, projectId.base, listener) : () => {}),
    () => (projectId ? mergePreviewVersion(projectId.id) : 0),
  )
  const registerHandler = ws?.registerHandler
  const unregisterHandler = ws?.unregisterHandler
  useEffect(() => {
    if (!projectId || !deliveryId || !registerHandler || !unregisterHandler) return
    registerHandler(handlerId, (message) => nudgeMergePreviews(projectId.id, message))
    return () => unregisterHandler(handlerId)
  }, [projectId?.id, projectId?.base, deliveryId, handlerId, registerHandler, unregisterHandler])
  return projectId && deliveryId ? readMergePreview(projectId.id, deliveryId) : null
}

/** The active project's id and API base (null before a project is chosen). */
function activeProjectOf(): { id: string; base: string } | null {
  let base: string
  try { base = getApiBase() } catch { return null }
  const match = /\/api\/projects\/([^/]+)$/.exec(base)
  return match ? { id: decodeURIComponent(match[1]!), base } : null
}
