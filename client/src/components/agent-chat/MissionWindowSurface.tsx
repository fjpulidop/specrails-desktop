import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '../../lib/tauri-shell'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMissionWindows } from '../../context/MissionWindowsContext'
import { useAgentChat } from '../../context/AgentChatContext'
import { projectProviders, useDesktop } from '../../hooks/useDesktop'
import { useProjectTerminals } from '../../context/TerminalsContext'
import { FEATURE_TERMINAL_PANEL } from '../../lib/feature-flags'
import { AgentModeSurface } from './AgentModeSurface'
import { AgentWorkspaceSidebar } from './AgentWorkspaceSidebar'
import { BottomPanel } from '../terminal/BottomPanel'

/** A native mission window reuses the conversation and tools, without main
 * navigation, global notifications or updater/sidecar lifecycle hooks. */
export function MissionWindowSurface() {
  const { t } = useTranslation('agent')
  const { current, initialized } = useMissionWindows()
  const { active } = useAgentChat()
  const { activeProjectId, projects } = useDesktop()
  const panelState = useProjectTerminals(activeProjectId)
  const project = projects.find(item => item.id === activeProjectId)
  const [height, setHeight] = useState(window.innerHeight)
  useEffect(() => {
    if (!isTauri() || !current || active?.id !== current.conversationId) return
    void getCurrentWindow().setTitle(`${active.title?.trim() || t('header.untitled')} — Specrails`).catch(() => {})
  }, [current?.conversationId, active?.id, active?.title, t])
  useEffect(() => {
    const resize = () => setHeight(window.innerHeight)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  if (!initialized || !current || active?.id !== current.conversationId) return (
    <div role="status" className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t('window.loading')}</div>
  )
  return <div className="flex min-h-0 flex-1 overflow-hidden" data-mission-window>
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1"><AgentModeSurface /></div>
      {FEATURE_TERMINAL_PANEL && project && activeProjectId && <BottomPanel projectId={activeProjectId}
        provider={project.provider} providers={projectProviders(project)} state={panelState}
        viewportHeight={height - 36} statusBarHeight={0} />}
    </div>
    <AgentWorkspaceSidebar missionOnly />
  </div>
}
