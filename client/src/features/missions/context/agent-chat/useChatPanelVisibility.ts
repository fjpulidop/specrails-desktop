/**
 * The floating agent panel: hidden / open / minimized. Opening refreshes the
 * list, MCP status and providers, and makes sure a conversation is active
 * (the latest one, else a fresh one).
 */
import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { listAgentConversations, createAgentConversation, type ArchiveScope, type AgentConversation } from '../../lib/agent-api'
import type { AgentVisibility } from './types'
import type { AgentChatCore } from './useAgentChatCore'

export function useChatPanelVisibility(core: AgentChatCore, opts: {
  fixedConversationId: string | undefined
  archiveScopeRef: MutableRefObject<ArchiveScope>
  listGenerationRef: MutableRefObject<number>
  scopeCacheRef: MutableRefObject<Map<ArchiveScope, AgentConversation[]>>
  setConversations: Dispatch<SetStateAction<AgentConversation[]>>
  loadConversation: (id: string, signal?: AbortSignal) => Promise<void>
  refreshConversations: () => Promise<void>
  refreshMcp: () => Promise<void>
  refreshProviders: () => Promise<void>
}) {
  const { secondaryWindow, active, setActive, setMessages } = core
  const {
    fixedConversationId, archiveScopeRef, listGenerationRef, scopeCacheRef, setConversations,
    loadConversation, refreshConversations, refreshMcp, refreshProviders,
  } = opts
  const [visibility, setVisibility] = useState<AgentVisibility>('hidden')

  const ensureActive = useCallback(async (): Promise<AgentConversation> => {
    if (active) return active
    if (secondaryWindow || fixedConversationId) throw new Error('This view is reserved for its mission.')
    const scope = archiveScopeRef.current
    const generation = listGenerationRef.current
    const list = await listAgentConversations({ archiveScope: scope })
    if (generation === listGenerationRef.current && scope === archiveScopeRef.current) {
      scopeCacheRef.current.set(scope, list)
      setConversations(list)
    }
    if (list.length > 0) {
      await loadConversation(list[0].id)
      return list[0]
    }
    const created = await createAgentConversation({})
    setConversations((c) => [created, ...c.filter((row) => row.id !== created.id)])
    setActive(created)
    setMessages([])
    return created
  }, [active, loadConversation, secondaryWindow, fixedConversationId])

  const open = useCallback(() => {
    setVisibility('open')
    void refreshConversations()
    void refreshMcp()
    void refreshProviders()
    void ensureActive()
  }, [refreshConversations, refreshMcp, refreshProviders, ensureActive])

  const close = useCallback(() => setVisibility('hidden'), [])
  const minimize = useCallback(() => setVisibility('minimized'), [])

  const toggle = useCallback(() => {
    setVisibility((v) => (v === 'open' ? 'minimized' : 'open'))
    if (visibility !== 'open') {
      void refreshConversations()
      void refreshMcp()
      void refreshProviders()
      void ensureActive()
    }
  }, [visibility, refreshConversations, refreshMcp, refreshProviders, ensureActive])

  return { visibility, setVisibility, open, close, minimize, toggle }
}
