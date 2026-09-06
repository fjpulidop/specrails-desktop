import { useMissionWindows } from '../../context/MissionWindowsContext'
import { lazy, Suspense } from 'react'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'
import { useAgentChat } from '../../context/AgentChatContext'
import { useDesktop } from '../../hooks/useDesktop'

const AgentBrowserCapture = lazy(() =>
  import('./AgentBrowserCapture').then((m) => ({ default: m.AgentBrowserCapture })),
)

/**
 * Single global mount for the agent browser-capture modal — lives at App root
 * (inside AgentWorkspaceProvider + AgentChatProvider) so BOTH agent surfaces
 * can open it: the Agent-Mode workspace sidebar and the composer's "+" menu in
 * the floating board-mode panel. The modal itself portals full-screen, so
 * where it mounts does not affect layout.
 */
export function AgentBrowserCaptureHost() {
  const { browserOpen } = useAgentWorkspace()
  const { active } = useAgentChat()
  const windows = useMissionWindows()
  const external = !windows.current && windows.transfers.some(item => item.conversationId === active?.id && item.state === 'detached')
  const { activeProjectId } = useDesktop()
  if (!browserOpen || !activeProjectId || external) return null
  return (
    <Suspense fallback={null}>
      <AgentBrowserCapture projectId={activeProjectId} conversationId={active?.id ?? null} />
    </Suspense>
  )
}
