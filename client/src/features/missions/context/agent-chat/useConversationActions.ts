/**
 * Mission lifecycle actions: start a new mission (draft or created), select
 * one (respecting window ownership and the Builder skin), and archive,
 * unarchive, delete (with Undo) and rename — keeping the per-scope list cache,
 * the revisit cache and the open view consistent.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import i18n from '../../../../lib/i18n'
import { markUserPlaceIntent } from '../../../../lib/places'
import { TRASH_RETENTION_DAYS, type useUndo } from '../../../../hooks/useUndo'
import { preferredProvider } from '../../../providers/lib/provider-capabilities'
import type { UiMode } from '../../../../context/UiModeContext'
import {
  listAgentConversations,
  createAgentConversation,
  patchAgentConversation,
  archiveAgentConversation,
  unarchiveAgentConversation,
  deleteAgentConversation,
  restoreAgentConversation,
  type ArchiveScope,
  type AgentConversation,
} from '../../lib/agent-api'
import { readLastTierLevel, saveFavoriteConversationIds } from '../../lib/agent-chat-storage'
import { patchCachedTitle } from '../../lib/agent-chat-transcript'
import type { AgentVisibility } from './types'
import type { AgentChatCore } from './useAgentChatCore'
import type { useComposeDraft } from './useComposeDraft'

export function useConversationActions(core: AgentChatCore, opts: {
  fixedConversationId: string | undefined
  uiMode: UiMode
  activeProjectId: string | null
  pushUndo: ReturnType<typeof useUndo>['pushUndo']
  draft: ReturnType<typeof useComposeDraft>
  usableProvidersRef: MutableRefObject<string[]>
  exitBuilderMode: () => void
  loadConversation: (id: string, signal?: AbortSignal) => Promise<void>
  pendingSelectionRef: MutableRefObject<boolean>
  setVisibility: Dispatch<SetStateAction<AgentVisibility>>
  archiveScopeRef: MutableRefObject<ArchiveScope>
  listGenerationRef: MutableRefObject<number>
  scopeCacheRef: MutableRefObject<Map<ArchiveScope, AgentConversation[]>>
  conversationsRef: MutableRefObject<AgentConversation[]>
  setConversations: Dispatch<SetStateAction<AgentConversation[]>>
  setConversationsError: Dispatch<SetStateAction<string | null>>
  refreshConversations: () => Promise<void>
  setFavoriteConversationIds: Dispatch<SetStateAction<ReadonlySet<string>>>
}) {
  const {
    windowsRef, secondaryWindow, editable, active, setActive, setMessages, metadataVersion, activeIdRef, activeRef,
    patchLive, archiveVersionsRef, conversationCacheRef, inflightConversationRef, prSnapshotVersionRef,
    conversationLoadEpochRef, selectConversationRef,
  } = core
  const {
    fixedConversationId, uiMode, activeProjectId, pushUndo, draft, usableProvidersRef, exitBuilderMode, loadConversation,
    pendingSelectionRef, setVisibility, archiveScopeRef, listGenerationRef, scopeCacheRef, conversationsRef,
    setConversations, setConversationsError, refreshConversations, setFavoriteConversationIds,
  } = opts
  const { setDraftPinnedProjectId, draftProviderChosenRef, setDraftProvider, setDraftModel, setDraftTierLevel, setDraftEffort } = draft

  const startNewConversation = useCallback((projectId?: string | null) => {
    if (secondaryWindow || fixedConversationId) return
    markUserPlaceIntent()
    // An explicit mission action while the Builder skin is up is a clear
    // intent to leave it — exit (abort + reset) so the normal compose screen
    // is actually visible, not hidden behind the builder branch.
    exitBuilderMode()
    setActive(null)
    setMessages([])
    setDraftPinnedProjectId(projectId ?? null)
    draftProviderChosenRef.current = false
    setDraftProvider(preferredProvider(usableProvidersRef.current))
    setDraftModel(null)
    setDraftTierLevel(readLastTierLevel()) // sticky tier across missions
    setDraftEffort(null)
  }, [exitBuilderMode, secondaryWindow, fixedConversationId])

  const newConversation = useCallback(async (projectId?: string | null) => {
    if (secondaryWindow || fixedConversationId) return
    markUserPlaceIntent()
    exitBuilderMode() // same intent-to-leave as startNewConversation
    // Explicit arg pins to that project (null ⇒ Home); arg-less preserves the
    // legacy behavior of inheriting the active conversation's pin.
    const pinnedProjectId = projectId !== undefined ? projectId : (active?.pinned_project_id ?? null)
    const created = await createAgentConversation({ pinnedProjectId, tierLevel: readLastTierLevel() })
    setConversations((c) => [created, ...c.filter((row) => row.id !== created.id)])
    setActive(created)
    setMessages([])
  }, [active, exitBuilderMode, secondaryWindow, fixedConversationId])

  const selectConversation = useCallback(async (id: string, options?: { windowRestore?: boolean; signal?: AbortSignal; placeRestore?: boolean }) => {
    if (fixedConversationId && id !== fixedConversationId) return
    // A mission the person picked is a navigable place; a Back/Forward restore is not a new one.
    if (!options?.placeRestore && !options?.windowRestore && id !== activeIdRef.current) markUserPlaceIntent()
    if (secondaryWindow && !fixedConversationId && !options?.windowRestore && windowsRef.current.current?.conversationId !== id) return
    if (!fixedConversationId && !secondaryWindow && !options?.windowRestore && await windowsRef.current.focus(id)) return
    if (options?.signal?.aborted) throw new DOMException('Window transfer cancelled', 'AbortError')
    exitBuilderMode()
    pendingSelectionRef.current = true
    try {
      await loadConversation(id, options?.signal)
    } finally {
      pendingSelectionRef.current = false
    }
    if (options?.windowRestore && uiMode !== 'agent') setVisibility('open')
  }, [loadConversation, exitBuilderMode, secondaryWindow, uiMode, fixedConversationId])

  selectConversationRef.current = selectConversation

  const applyArchiveConversation = useCallback((updated: AgentConversation) => {
    const id = updated.id
    listGenerationRef.current += 1
    archiveVersionsRef.current.set(id, (archiveVersionsRef.current.get(id) ?? 0) + 1)
    metadataVersion.current.set(id, (metadataVersion.current.get(id) ?? 0) + 1)
    conversationCacheRef.current.delete(id)
    inflightConversationRef.current.delete(id)
    const updateScope = (scope: ArchiveScope, rows: AgentConversation[]): AgentConversation[] => {
      const belongs = scope === 'all' || (scope === 'archived') === Boolean(updated.archivedAt)
      if (!belongs) return rows.filter((row) => row.id !== id)
      if (rows.some((row) => row.id === id)) return rows.map((row) => row.id === id ? updated : row)
      return [...rows, updated].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    }
    for (const [scope, rows] of scopeCacheRef.current) scopeCacheRef.current.set(scope, updateScope(scope, rows))
    setConversations((rows) => updateScope(archiveScopeRef.current, rows))
    setActive((current) => current?.id === id ? { ...current, archivedAt: updated.archivedAt } : current)
  }, [])

  const archiveConversation = useCallback(async (id: string) => {
    if (!editable(id)) return
    const ordering = conversationsRef.current
    const archiveVersions = new Map(archiveVersionsRef.current)
    const index = ordering.findIndex((row) => row.id === id)
    const updated = await archiveAgentConversation(id)
    applyArchiveConversation(updated)
    if (activeIdRef.current === id) {
      conversationLoadEpochRef.current += 1
      prSnapshotVersionRef.current += 1
      const candidates = [...ordering.slice(index + 1), ...ordering.slice(0, Math.max(0, index)).reverse()]
      // Keep neighbor order, but reject rows changed by a concurrent mutation.
      const isActiveCandidate = (row: AgentConversation) => row.id !== id && !row.archivedAt
        && (archiveVersions.get(row.id) ?? 0) === (archiveVersionsRef.current.get(row.id) ?? 0)
      let neighbor = candidates.find(isActiveCandidate)
      if (!neighbor) {
        try {
          const activeRows = await listAgentConversations({ archiveScope: 'active' })
          neighbor = activeRows.find(isActiveCandidate)
        } catch (error) {
          setConversationsError(error instanceof Error ? error.message : String(error))
        }
      }
      if (activeIdRef.current === id) {
        activeRef.current = null
        activeIdRef.current = null
        setActive(null)
        setMessages([])
        if (neighbor) {
          try {
            await selectConversation(neighbor.id)
          } catch {
            // Archive is committed; a failed neighbor load leaves the empty view.
          }
        }
      }
    }
    await refreshConversations()
  }, [applyArchiveConversation, selectConversation, refreshConversations])

  const unarchiveConversation = useCallback(async (id: string) => {
    if (!editable(id)) return
    const updated = await unarchiveAgentConversation(id)
    applyArchiveConversation(updated)
    await refreshConversations()
  }, [applyArchiveConversation, refreshConversations])

  const deleteConversation = useCallback(async (id: string) => {
    if (!editable(id)) return
    const deleted = conversationsRef.current.find((c) => c.id === id) ?? (activeIdRef.current === id ? active : null)
    await deleteAgentConversation(id)
    listGenerationRef.current += 1
    archiveVersionsRef.current.set(id, (archiveVersionsRef.current.get(id) ?? 0) + 1)
    for (const [scope, rows] of scopeCacheRef.current) scopeCacheRef.current.set(scope, rows.filter((row) => row.id !== id))
    conversationCacheRef.current.delete(id)
    inflightConversationRef.current.delete(id)
    // Applied at once, no confirm: Undo restores the mission with its history.
    pushUndo({
      projectId: deleted?.pinned_project_id ?? activeProjectId,
      label: i18n.t('undo:missionDeleted', { title: deleted?.title?.trim() || i18n.t('undo:missionUntitled') }),
      recoverableDays: TRASH_RETENTION_DAYS,
      undo: async () => {
        applyArchiveConversation(await restoreAgentConversation(id))
        await refreshConversations()
      },
    })
    await windowsRef.current.discard(id)
    setConversations((c) => c.filter((x) => x.id !== id))
    setFavoriteConversationIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      saveFavoriteConversationIds(next)
      return next
    })
    patchLive(id, () => null)
    if (activeIdRef.current === id) {
      setActive(null)
      setMessages([])
    }
  }, [patchLive, pushUndo, activeProjectId, active, refreshConversations, applyArchiveConversation])

  /** Rename a conversation. Optimistic: the title updates locally immediately and
   *  reverts on failure. A blank/whitespace title clears back to auto-title. */
  const renameConversation = useCallback(async (id: string, rawTitle: string): Promise<void> => {
    if (!editable(id)) return
    const title = rawTitle.trim() || null
    metadataVersion.current.set(id, (metadataVersion.current.get(id) ?? 0) + 1)
    let prev: string | null | undefined
    setConversations((cs) => cs.map((c) => {
      if (c.id === id) { prev = c.title; return { ...c, title } }
      return c
    }))
    setActive((a) => (a && a.id === id ? { ...a, title } : a))
    patchCachedTitle(conversationCacheRef.current, id, title)
    try {
      await patchAgentConversation(id, { title })
    } catch (err) {
      // Revert the optimistic write.
      setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, title: prev ?? null } : c)))
      setActive((a) => (a && a.id === id ? { ...a, title: prev ?? null } : a))
      patchCachedTitle(conversationCacheRef.current, id, prev ?? null)
      throw err
    }
  }, [])

  return {
    startNewConversation, newConversation, selectConversation,
    archiveConversation, unarchiveConversation, deleteConversation, renameConversation,
  }
}
