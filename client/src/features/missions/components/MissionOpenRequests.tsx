import { useEffect, useRef } from 'react'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { useUiMode } from '../../../context/UiModeContext'
import { OPEN_MISSION_EVENT, OPEN_MISSION_NATIVE_EVENT, requestOpenMission, type OpenMissionDetail } from '../../../lib/mission-events'
import { isTauri } from '../../../lib/tauri-shell'
import { useAgentChat } from '../context/AgentChatContext'
import { useOpenMission } from '../hooks/useOpenMission'
import { openDeviceWindow, type DeviceTarget } from '../lib/device-windows'

/** A loop editor window asks the main window to open a device (Loops ▸ Test in Mobile Device). */
const OPEN_DEVICE_NATIVE_EVENT = 'specrails://open-device'

/**
 * Answers `requestOpenMission` (lib/mission-events) in the main window: Mission
 * mode shows the mission (switching project when it is pinned elsewhere), Board
 * mode opens it in the floating agent panel, like the live board's mission cards.
 * Loop editor windows ask through the host's `specrails://open-mission` event, and for a device window
 * through `specrails://open-device`: the main window opens it so it also releases the device on close.
 * An MCP client asks over WS (`mobile_test.open_device`, specrails_integrations mobile_open_device).
 */
export function MissionOpenRequests() {
  const { uiMode } = useUiMode()
  const { selectConversation, open } = useAgentChat()
  const openMission = useOpenMission()
  const latest = useRef({ uiMode, selectConversation, open, openMission })
  latest.current = { uiMode, selectConversation, open, openMission }
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  useEffect(() => {
    registerHandler('mission-open-device', (raw: unknown) => {
      const msg = raw as { type?: string; target?: DeviceTarget }
      if (msg.type !== 'mobile_test.open_device' || !msg.target || !isTauri()) return
      void openDeviceWindow(msg.target).catch(() => {})
    })
    return () => unregisterHandler('mission-open-device')
  }, [registerHandler, unregisterHandler])
  useEffect(() => {
    const onRequest = (event: Event) => {
      const id = (event as CustomEvent<OpenMissionDetail>).detail?.conversationId
      if (typeof id !== 'string' || !id) return
      const current = latest.current
      if (current.uiMode === 'agent') current.openMission(id)
      else { void current.selectConversation(id); current.open() }
    }
    window.addEventListener(OPEN_MISSION_EVENT, onRequest)
    // A loop editor window asks through the host (Loops ▸ Fix PR CI ▸ Run on a PR).
    let disposed = false
    const unlisten: Array<() => void> = []
    if (isTauri()) {
      const keep = (stop: () => void) => { if (disposed) stop(); else unlisten.push(stop) }
      void import('@tauri-apps/api/event').then(({ listen }) => Promise.all([
        listen<OpenMissionDetail>(OPEN_MISSION_NATIVE_EVENT, event => {
          if (typeof event.payload?.conversationId === 'string') requestOpenMission(event.payload.conversationId)
        }).then(keep),
        // The host validated the target before relaying it.
        listen<DeviceTarget>(OPEN_DEVICE_NATIVE_EVENT, event => { void openDeviceWindow(event.payload).catch(() => {}) }).then(keep),
      ])).catch(() => {})
    }
    return () => { disposed = true; for (const stop of unlisten.splice(0)) stop(); window.removeEventListener(OPEN_MISSION_EVENT, onRequest) }
  }, [])
  return null
}
