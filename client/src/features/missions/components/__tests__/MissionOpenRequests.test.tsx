import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'

const h = vi.hoisted(() => ({ mode: 'agent' as 'agent' | 'kanban', openMission: vi.fn(), selectConversation: vi.fn(), open: vi.fn() }))
vi.mock('../../../../context/UiModeContext', () => ({ useUiMode: () => ({ uiMode: h.mode }) }))
vi.mock('../../context/AgentChatContext', () => ({ useAgentChat: () => ({ selectConversation: h.selectConversation, open: h.open }) }))
vi.mock('../../hooks/useOpenMission', () => ({ useOpenMission: () => h.openMission }))
const ws = vi.hoisted(() => ({ handlers: new Map<string, (msg: unknown) => void>(), opened: [] as unknown[] }))
vi.mock('../../../../hooks/useSharedWebSocket', () => ({ useSharedWebSocket: () => ({ registerHandler: (id: string, fn: (msg: unknown) => void) => ws.handlers.set(id, fn), unregisterHandler: (id: string) => ws.handlers.delete(id) }) }))
vi.mock('../../lib/device-windows', () => ({ openDeviceWindow: async (target: unknown) => { ws.opened.push(target) } }))
vi.mock('../../../../lib/tauri-shell', async (load) => ({ ...(await load<typeof import('../../../../lib/tauri-shell')>()), isTauri: () => true }))

import { requestOpenMission } from '../../../../lib/mission-events'
import { MissionOpenRequests } from '../MissionOpenRequests'

beforeEach(() => { h.openMission.mockClear(); h.selectConversation.mockClear(); h.open.mockClear() })

describe('MissionOpenRequests', () => {
  it('Mission mode shows the requested mission', () => {
    h.mode = 'agent'
    render(<MissionOpenRequests />)
    act(() => requestOpenMission('conv-1'))
    expect(h.openMission).toHaveBeenCalledWith('conv-1')
    expect(h.open).not.toHaveBeenCalled()
  })

  it('Board mode opens it in the floating agent panel; an empty request does nothing', () => {
    h.mode = 'kanban'
    const { unmount } = render(<MissionOpenRequests />)
    act(() => requestOpenMission('conv-2'))
    act(() => requestOpenMission(''))
    expect(h.selectConversation).toHaveBeenCalledTimes(1)
    expect(h.selectConversation).toHaveBeenCalledWith('conv-2')
    expect(h.open).toHaveBeenCalledTimes(1)
    unmount()
    act(() => requestOpenMission('conv-3'))
    expect(h.selectConversation).toHaveBeenCalledTimes(1)
  })

  it('[spec:mobile-device-testing/mcp-control] opens the device an MCP client asks for (mobile_open_device), and nothing else', async () => {
    ws.opened.length = 0
    render(<MissionOpenRequests />)
    const target = { deviceId: 'avd:tapflow-phone', sessionId: 's1', buildId: 8, platform: 'android', name: 'tapflow-phone' }
    act(() => ws.handlers.get('mission-open-device')?.({ type: 'mobile_test.open_device', projectId: 'p1', target }))
    act(() => ws.handlers.get('mission-open-device')?.({ type: 'plugin.tapflow_status' }))
    await vi.waitFor(() => expect(ws.opened).toEqual([target]))
  })
})
