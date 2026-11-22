import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'

const h = vi.hoisted(() => ({ mode: 'agent' as 'agent' | 'kanban', openMission: vi.fn(), selectConversation: vi.fn(), open: vi.fn() }))
vi.mock('../../../../context/UiModeContext', () => ({ useUiMode: () => ({ uiMode: h.mode }) }))
vi.mock('../../context/AgentChatContext', () => ({ useAgentChat: () => ({ selectConversation: h.selectConversation, open: h.open }) }))
vi.mock('../../hooks/useOpenMission', () => ({ useOpenMission: () => h.openMission }))

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
})
