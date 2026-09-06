import { useTerminals } from '../../context/TerminalsContext'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgentChat } from '../../context/AgentChatContext'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'
import { useMissionWindows } from '../../context/MissionWindowsContext'
import { useDesktop } from '../../hooks/useDesktop'
import { captureComposerDraft, restoreComposerDraft } from '../../lib/agent-composer-drafts'
import { missionTransferBlocked, readMissionScroll, restoreMissionView, readMissionCode, saveMissionCode } from '../../lib/mission-view-state'
import type { MissionWindowTarget, MissionWindowSnapshot } from '../../lib/mission-windows'

const workspaceCache = new Map<string, MissionWindowSnapshot['workspace']>()

/** Binds shared mission UI to native handoffs without making either provider
 * depend on the other. Acknowledgement happens after React commits hydration. */
export function MissionWindowBindings() {
  const chat = useAgentChat()
  const workspace = useAgentWorkspace()
  const desktop = useDesktop()
  const terminals = useTerminals()
  const { registerHandlers } = useMissionWindows()
  const { t } = useTranslation('agent')
  const latest = useRef({ chat, workspace, desktop, terminals, t })
  latest.current = { chat, workspace, desktop, terminals, t }
  const lastConversation = useRef<string | null>(null)
  const restoring = useRef(false)
  useLayoutEffect(() => {
    const id = chat.active?.id ?? '__new-mission__'
    const previous = lastConversation.current
    if (restoring.current || previous === id) return
    lastConversation.current = id
    if (previous) workspaceCache.set(previous, workspace.captureWorkspace())
    const saved = workspaceCache.get(id)
    if (saved) workspace.restoreWorkspace(saved)
    else if (previous) workspace.restoreWorkspace({ ...workspace.captureWorkspace(), browserOpen: false, browserOwnerId: null, browserUrl: null, pendingCaptures: [] })
  }, [chat.active?.id])
  const [commit, setCommit] = useState<{ target: MissionWindowTarget; resolve: () => void; signal: AbortSignal } | null>(null)

  useLayoutEffect(() => {
    if (commit && !commit.signal.aborted && chat.active?.id === commit.target.conversationId && desktop.activeProjectId === commit.target.projectId) {
      commit.resolve()
      setCommit(current => current === commit ? null : current)
    }
  }, [commit, chat.active?.id, desktop.activeProjectId])

  useEffect(() => registerHandlers({
    recover(snapshot, target) { restoreMissionView(target.conversationId, snapshot.scroll) },
    capture(target) {
      const { chat, workspace, terminals, t } = latest.current
      if (chat.active?.id !== target.conversationId) throw new Error(t('window.wrongMission'))
      if (missionTransferBlocked(target.conversationId)) throw new Error(t('window.finishPending'))
      return {
        version: 1, ...target, capturedAt: Date.now(),
        composer: captureComposerDraft(target.conversationId),
        scroll: readMissionScroll(target.conversationId),
        workspace: { ...workspace.captureWorkspace(), ...(target.projectId ? {
          codeSelection: readMissionCode(target.projectId, target.conversationId),
          terminal: (({ activeId, visibility, userHeight }) => ({ activeId, visibility, userHeight }))(terminals.getState(target.projectId)),
        } : {}) },
      }
    },
    async restore(snapshot, target, signal) {
      const cancelled = () => new DOMException('Window transfer cancelled', 'AbortError')
      if (signal.aborted) throw cancelled()
      // Fetch before replacing local drafts. If the API is unavailable the
      // source window stays usable and keeps the latest authoritative input.
      const previous = latest.current.chat.active?.id
      if (previous) workspaceCache.set(previous, latest.current.workspace.captureWorkspace())
      restoring.current = true
      try {
      await latest.current.chat.selectConversation(target.conversationId, { windowRestore: true, signal })
      if (signal.aborted) throw cancelled()
      lastConversation.current = target.conversationId
      workspaceCache.set(target.conversationId, snapshot.workspace)
      restoreComposerDraft(target.conversationId, snapshot.composer)
      if (target.projectId) {
        if (snapshot.workspace.codeSelection) saveMissionCode(target.projectId, target.conversationId, snapshot.workspace.codeSelection)
        if (snapshot.workspace.terminal) {
          const state = snapshot.workspace.terminal
          const terminal = latest.current.terminals
          terminal.ensureProject(target.projectId)
          terminal.setVisibility(target.projectId, state.visibility)
          terminal.setUserHeight(target.projectId, state.userHeight)
          if (state.activeId) terminal.setActive(target.projectId, state.activeId)
        }
      }
      latest.current.workspace.restoreWorkspace(snapshot.workspace)
      latest.current.desktop.setActiveProjectId(target.projectId)
      restoreMissionView(target.conversationId, snapshot.scroll)
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { setCommit(current => current?.signal === signal ? null : current); reject(cancelled()) }
        signal.addEventListener('abort', onAbort, { once: true })
        setCommit({ target, signal, resolve: () => { signal.removeEventListener('abort', onAbort); resolve() } })
      })
      } finally { restoring.current = false }
    },
  }), [registerHandlers])
  return null
}
