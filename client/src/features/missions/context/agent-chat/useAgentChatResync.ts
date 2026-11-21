/**
 * Resync of the mission chat after the world moved without us: window focus
 * refreshes the list, a recovered project re-reads list and cards, and a WS
 * reconnect refreshes everything and reconciles active turns.
 */
import { useEffect, useRef } from 'react'

export function useAgentChatResync(opts: {
  connectionStatus: string
  projectRecoveryRevision: number
  refreshConversations: () => Promise<void>
  refreshMcp: () => Promise<void>
  refreshProviders: () => Promise<void>
  hydrateActivePrCards: () => Promise<boolean>
  reconcileActiveTurns: () => Promise<void>
}) {
  const { connectionStatus, projectRecoveryRevision, refreshConversations, refreshMcp, refreshProviders, hydrateActivePrCards, reconcileActiveTurns } = opts
  useEffect(() => {
    // Card hydration on focus runs through usePrCardResync (deduplicated).
    const onFocus = () => { void refreshConversations() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshConversations])

  useEffect(() => {
    if (!projectRecoveryRevision) return
    void refreshConversations()
    void hydrateActivePrCards()
  }, [projectRecoveryRevision, refreshConversations, hydrateActivePrCards])

  const previousConnectionRef = useRef(connectionStatus)
  useEffect(() => {
    const previous = previousConnectionRef.current
    previousConnectionRef.current = connectionStatus
    if (connectionStatus === 'connected' && previous !== 'connected') {
      void refreshConversations()
      void refreshMcp()
      void refreshProviders()
      void hydrateActivePrCards()
      void reconcileActiveTurns()
    }
  }, [connectionStatus, refreshConversations, refreshMcp, refreshProviders, hydrateActivePrCards, reconcileActiveTurns])
}
