/**
 * The mission list: conversations of the selected archive scope, with a
 * per-scope cache so switching scope paints at once, and a generation guard
 * so a late response for a previous scope never lands.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import i18n from '../../../../lib/i18n'
import { notifyError } from '../../../../lib/notify-error'
import { listAgentConversations, type ArchiveScope, type AgentConversation } from '../../lib/agent-api'
import { ARCHIVE_SCOPE_KEY, loadArchiveScope } from '../../lib/agent-chat-storage'

export function useConversationList() {
  const [archiveScope, updateArchiveScope] = useState<ArchiveScope>(loadArchiveScope)
  const archiveScopeRef = useRef(archiveScope)
  const scopeCacheRef = useRef(new Map<ArchiveScope, AgentConversation[]>())
  const listGenerationRef = useRef(0)
  const [conversationsLoading, setConversationsLoading] = useState(true)
  const [conversationsError, setConversationsError] = useState<string | null>(null)
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const conversationsRef = useRef(conversations)
  conversationsRef.current = conversations
  const setArchiveScope = useCallback((scope: ArchiveScope) => {
    if (scope === archiveScopeRef.current) return
    archiveScopeRef.current = scope
    listGenerationRef.current += 1
    updateArchiveScope(scope)
    const cached = scopeCacheRef.current.get(scope)
    setConversations(cached ?? [])
    setConversationsLoading(!cached)
    setConversationsError(null)
    try { localStorage.setItem(ARCHIVE_SCOPE_KEY, scope) } catch { /* storage is optional */ }
  }, [])

  // Refresh the conversation list + MCP status lazily on first open.
  const refreshConversations = useCallback(async (): Promise<void> => {
    const scope = archiveScopeRef.current
    const generation = ++listGenerationRef.current
    setConversationsLoading(!scopeCacheRef.current.has(scope))
    setConversationsError(null)
    try {
      const list = await listAgentConversations({ archiveScope: scope })
      if (generation !== listGenerationRef.current || scope !== archiveScopeRef.current) return
      scopeCacheRef.current.set(scope, list)
      setConversations(list)
    } catch (error) {
      if (generation !== listGenerationRef.current || scope !== archiveScopeRef.current) return
      setConversationsError(error instanceof Error ? error.message : String(error))
      notifyError(i18n.t('common:states.error'), { detail: error instanceof Error ? error.message : undefined, retry: () => { void refreshConversations() } })
    } finally {
      if (generation === listGenerationRef.current && scope === archiveScopeRef.current) setConversationsLoading(false)
    }
  }, [])

  useEffect(() => { void refreshConversations() }, [archiveScope, refreshConversations])

  return {
    archiveScope, archiveScopeRef, scopeCacheRef, listGenerationRef, setArchiveScope,
    conversations, setConversations, conversationsRef, conversationsLoading, conversationsError, setConversationsError,
    refreshConversations,
  }
}
