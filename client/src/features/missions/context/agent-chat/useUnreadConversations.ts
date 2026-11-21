/**
 * Unread missions: output that arrived out of view (another mission, or a
 * hidden window). Cleared when the mission is shown or the window regains
 * visibility on it.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { FEATURE_AGENT_CHAT } from '../../../../lib/feature-flags'

export function useUnreadConversations(activeIdRef: MutableRefObject<string | null>) {
  const [unreadConversationIds, setUnreadConversationIds] = useState<ReadonlySet<string>>(new Set())
  // The ref is the authority for "is it already unread": a streamed token of a
  // mission that is already marked must NOT touch React state — a pending
  // setState (even one that bails out) is an urgent render that restarts the
  // interruptible render of the mission being opened, so a busy background
  // stream could otherwise starve it.
  const unreadRef = useRef<ReadonlySet<string>>(new Set())
  const markUnread = useCallback((conversationId: string): void => {
    const documentHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    if (conversationId === activeIdRef.current && !documentHidden) return
    if (unreadRef.current.has(conversationId)) return
    const next = new Set(unreadRef.current)
    next.add(conversationId)
    unreadRef.current = next
    setUnreadConversationIds(next)
  }, [])

  const clearUnread = useCallback((conversationId: string): void => {
    if (!unreadRef.current.has(conversationId)) return
    const next = new Set(unreadRef.current)
    next.delete(conversationId)
    unreadRef.current = next
    setUnreadConversationIds(next)
  }, [])

  useEffect(() => {
    if (!FEATURE_AGENT_CHAT || typeof document === 'undefined') return
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      const activeId = activeIdRef.current
      if (activeId) clearUnread(activeId)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [clearUnread])

  return { unreadConversationIds, markUnread, clearUnread }
}
