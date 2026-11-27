/**
 * Settings of the active mission (or of the EMPTY compose draft when none is
 * active): tier, provider, model, effort and pinned project, plus the
 * backward binding that lets the sidebar's active project move an UNSTARTED
 * mission.
 */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { patchAgentConversation, saveMissionDefaultTier, type AgentConversation, type AgentTierLevel } from '../../lib/agent-api'
import { saveLastTierLevel } from '../../lib/agent-chat-storage'
import type { UiMode } from '../../../../context/UiModeContext'
import type { useDesktop } from '../../../../hooks/useDesktop'
import type { AgentChatCore } from './useAgentChatCore'
import type { useComposeDraft } from './useComposeDraft'

export function useConversationSettings(core: AgentChatCore, opts: {
  fixedConversationId: string | undefined
  uiMode: UiMode
  activeProjectId: string | null
  setActiveProjectId: ReturnType<typeof useDesktop>['setActiveProjectId']
  setConversations: Dispatch<SetStateAction<AgentConversation[]>>
  draft: ReturnType<typeof useComposeDraft>
}) {
  const { secondaryWindow, editable, active, setActive, messagesRef, metadataVersion } = core
  const { fixedConversationId, uiMode, activeProjectId, setActiveProjectId, setConversations, draft } = opts
  const { draftTierLevel, setDraftTierLevel, draftProviderChosenRef, setDraftProvider, setDraftModel, setDraftEffort, setDraftPinnedProjectId } = draft

  const patchActive = useCallback(async (patch: Parameters<typeof patchAgentConversation>[1]) => {
    if (!active || !editable(active.id)) return
    const revision = (metadataVersion.current.get(active.id) ?? 0) + 1
    metadataVersion.current.set(active.id, revision)
    const updated = await patchAgentConversation(active.id, patch)
    if (metadataVersion.current.get(active.id) !== revision) return
    setActive(current => current?.id === updated.id ? updated : current)
    setConversations((c) => c.map((x) => (x.id === updated.id ? updated : x)))
  }, [active])

  const setTier = useCallback(async (level: AgentTierLevel) => {
    if (!editable(active?.id)) return
    saveLastTierLevel(level) // sticky across missions
    // …and the default of missions created outside the app (MCP clients, Run on a PR).
    void saveMissionDefaultTier(level).catch(() => {})
    if (active) await patchActive({ tierLevel: level })
    else setDraftTierLevel(level)
  }, [active, patchActive])
  const cycleTier = useCallback(async () => {
    const next = (((active?.tier_level ?? draftTierLevel) + 1) % 4) as AgentTierLevel
    await setTier(next)
  }, [active, draftTierLevel, setTier])
  const setProvider = useCallback(async (provider: string) => {
    if (active) await patchActive({ provider })
    // Model + effort reset on provider switch (mirrors the server's stale reset).
    // The pick is the user's: freeze the machine-default reconciliation for this
    // draft so a flaky detection cycle cannot undo it.
    else { draftProviderChosenRef.current = true; setDraftProvider(provider); setDraftModel(null); setDraftEffort(null) }
  }, [active, patchActive])
  const setModel = useCallback(async (model: string) => {
    if (active) await patchActive({ model })
    else {
      setDraftModel(model)
      setDraftEffort(null)
    }
  }, [active, patchActive])
  const setEffort = useCallback(async (effort: string | null) => {
    if (active) await patchActive({ reasoningEffort: effort })
    else setDraftEffort(effort)
  }, [active, patchActive])
  const setPinnedProject = useCallback(async (projectId: string | null) => {
    if (secondaryWindow || fixedConversationId || !editable(active?.id)) return
    // On the EMPTY compose screen there's no conversation yet — record the pick
    // as a draft pin; otherwise patch the live conversation.
    if (active) await patchActive({ pinnedProjectId: projectId })
    else setDraftPinnedProjectId(projectId)
    // Agent Mode coherence: picking a project on the "+ New Agent" compose
    // screen also moves the left sidebar's highlighted project (the reverse
    // already holds — sidebar clicks seed the draft pin). Home (null) leaves
    // the sidebar untouched; the Kanban floating panel is unaffected.
    if (!active && projectId && uiMode === 'agent') setActiveProjectId(projectId)
  }, [active, patchActive, uiMode, setActiveProjectId, secondaryWindow, fixedConversationId])

  // Backward binding: the sidebar's active project moves an UNSTARTED mission.
  // `setPinnedProject` above owns the forward direction (mission selector moves
  // the sidebar); this is the reverse, so picking a project in Agent Mode
  // immediately points the agent at it without a second click in the mission's
  // own project selector. Two guards keep it honest:
  //   - only an actual CHANGE binds (the mounted value is recorded and skipped),
  //     so an explicitly Home-pinned mission is never converted on first render;
  //   - a mission that already carries messages keeps its project, because its
  //     transcript, tool calls and `#ref` resolution are scoped to it.
  // Reading the active project from context (not from a click handler) keeps the
  // invariant regardless of which surface moved it — sidebar, command palette,
  // a ref chip, or a minimized-chat restore.
  const lastBoundProjectIdRef = useRef<string | null | undefined>(undefined)
  // A project change caused by selecting another mission follows that mission's pin;
  // it must not re-pin the mission being left (or the draft pin).
  const pendingSelectionRef = useRef(false)
  useEffect(() => {
    const previous = lastBoundProjectIdRef.current
    lastBoundProjectIdRef.current = activeProjectId
    if (previous === undefined || previous === activeProjectId) return
    if (pendingSelectionRef.current) {
      pendingSelectionRef.current = false
      return
    }
    if (secondaryWindow || fixedConversationId || uiMode !== 'agent' || !activeProjectId) return
    if (!active) {
      setDraftPinnedProjectId(activeProjectId)
      return
    }
    if (messagesRef.current.length > 0) return
    if (active.pinned_project_id === activeProjectId) return
    void patchActive({ pinnedProjectId: activeProjectId })
  }, [activeProjectId, uiMode, active, patchActive, secondaryWindow, fixedConversationId])

  const beginMissionSelection = useCallback(() => { pendingSelectionRef.current = true }, [])

  return { setTier, cycleTier, setProvider, setModel, setEffort, setPinnedProject, beginMissionSelection, pendingSelectionRef }
}
