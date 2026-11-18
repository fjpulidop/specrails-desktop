/**
 * The sidebar's Favorite missions, persisted per machine and kept in sync
 * across windows through the storage event.
 */
import { useCallback, useEffect, useState } from 'react'
import { FAVORITE_CONVERSATIONS_KEY, loadFavoriteConversationIds, saveFavoriteConversationIds } from '../../lib/agent-chat-storage'

export function useFavoriteConversations() {
  const [favoriteConversationIds, setFavoriteConversationIds] = useState<ReadonlySet<string>>(loadFavoriteConversationIds)
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === FAVORITE_CONVERSATIONS_KEY || event.key === null) setFavoriteConversationIds(loadFavoriteConversationIds())
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const toggleFavoriteConversation = useCallback((id: string): void => {
    setFavoriteConversationIds(() => {
      const next = new Set(loadFavoriteConversationIds())
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveFavoriteConversationIds(next)
      return next
    })
  }, [])

  return { favoriteConversationIds, setFavoriteConversationIds, toggleFavoriteConversation }
}
