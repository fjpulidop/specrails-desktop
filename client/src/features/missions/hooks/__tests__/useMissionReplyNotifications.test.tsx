import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const h = vi.hoisted(() => ({
  handler: null as ((message: unknown) => void) | null,
  chat: { active: { id: 'c1' } as { id: string } | null, visibility: 'hidden', conversations: [{ id: 'c1', title: 'Login flow', pinned_project_id: 'p1' }, { id: 'c2', title: '', pinned_project_id: null }], open: vi.fn() },
  split: { primaryVisible: true, conversationIds: [] as string[] },
  windows: { transfers: [] as Array<{ conversationId: string; windowLabel: string; state: string }>, focus: vi.fn() },
  mode: 'agent' as 'agent' | 'kanban',
  openMission: vi.fn(),
}))
vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({ registerHandler: (_id: string, fn: (m: unknown) => void) => { h.handler = fn }, unregisterHandler: () => { h.handler = null } }),
}))
vi.mock('../../../../context/UiModeContext', () => ({ useUiMode: () => ({ uiMode: h.mode }) }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => ({ projects: [{ id: 'p1', name: 'Alpha' }] }) }))
vi.mock('../../context/AgentChatContext', () => ({ useAgentChat: () => h.chat }))
vi.mock('../../context/MissionSplitViewsContext', () => ({ useMissionSplitViews: () => h.split }))
vi.mock('../../context/MissionWindowsContext', () => ({ useMissionWindows: () => h.windows }))
vi.mock('../useOpenMission', () => ({ useOpenMission: () => h.openMission }))

import { missionOnScreen, replySnippet, useMissionReplyNotifications, type MissionScreen } from '../useMissionReplyNotifications'
import type { AttentionCenter, AttentionEvent } from '../../../../lib/attention/attention-center'

const screen = (over: Partial<MissionScreen> = {}): MissionScreen => ({
  uiMode: 'agent', pathname: '/', activeId: 'c1', primaryVisible: true, splitIds: [], chatOpen: false, detached: new Map(), ...over,
})
const main = { appFocused: true, label: 'main' }

describe('missionOnScreen', () => {
  it('Mission mode: the primary mission or a split pane, in the focused main window', () => {
    expect(missionOnScreen('c1', screen(), main)).toBe(true)
    expect(missionOnScreen('c2', screen(), main)).toBe(false)
    expect(missionOnScreen('c2', screen({ splitIds: ['c2'] }), main)).toBe(true)
    expect(missionOnScreen('c1', screen({ primaryVisible: false }), main)).toBe(false)
    expect(missionOnScreen('c1', screen({ pathname: '/docs' }), main)).toBe(false)
    expect(missionOnScreen('c1', screen(), { appFocused: false, label: null })).toBe(false)
  })

  it('Board mode: the open floating chat on that mission', () => {
    expect(missionOnScreen('c1', screen({ uiMode: 'kanban' }), main)).toBe(false)
    expect(missionOnScreen('c1', screen({ uiMode: 'kanban', chatOpen: true }), main)).toBe(true)
  })

  it('a detached mission is watched only when its own window has the focus', () => {
    const detached = new Map([['c1', 'mission-1']])
    expect(missionOnScreen('c1', screen({ detached }), main)).toBe(false)
    expect(missionOnScreen('c1', screen({ detached }), { appFocused: true, label: 'mission-1' })).toBe(true)
  })
})

describe('replySnippet', () => {
  it('plain first words of the reply', () => {
    expect(replySnippet('## Done\n\nI **fixed** the `login` bug. See [PR](https://x).')).toBe('Done I fixed the login bug. See PR.')
    expect(replySnippet('```ts\ncode\n```\nShort answer')).toBe('Short answer')
    expect(Array.from(replySnippet('a'.repeat(500)))).toHaveLength(140)
    expect(replySnippet(undefined)).toBe('')
  })
})

describe('useMissionReplyNotifications', () => {
  let events: AttentionEvent[]
  let center: AttentionCenter
  beforeEach(() => {
    events = []
    center = { dispatch: vi.fn(async (event: AttentionEvent) => { events.push(event); return 'notify' as const }), takeAway: () => [], forget: vi.fn() }
    h.mode = 'agent'
    h.windows.transfers = []
    h.openMission.mockClear(); h.chat.open.mockClear(); h.windows.focus.mockClear()
  })

  const send = (message: Record<string, unknown>) => act(() => { h.handler?.(message) })

  it('announces "<mission> replied" (category question) with the project and the reply\'s first words', () => {
    renderHook(() => useMissionReplyNotifications({ pathname: '/', center }))
    send({ type: 'agent_done', conversationId: 'c1', messageId: 'm1', fullText: 'All tests pass.' })
    send({ type: 'agent_turn_done', conversationId: 'c2', messageId: 'm2' })
    send({ type: 'agent_stream', conversationId: 'c1', delta: 'x' })
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ key: 'mission:c1:m1', category: 'question', projectId: 'p1', title: 'Login flow replied', body: 'Alpha · All tests pass.' })
    expect(events[1]).toMatchObject({ projectId: null, title: 'Your mission replied', body: '' })
  })

  it('isOnScreen reads the screen at decision time', () => {
    const view = renderHook(() => useMissionReplyNotifications({ pathname: '/', center }))
    send({ type: 'agent_done', conversationId: 'c1', messageId: 'm1' })
    expect(events[0].isOnScreen?.(main)).toBe(true)
    h.chat.active = { id: 'c2' }
    view.rerender()
    expect(events[0].isOnScreen?.(main)).toBe(false)
    h.chat.active = { id: 'c1' }
  })

  it('the way back opens the mission (and the chat in Board mode), or focuses its own window', () => {
    const view = renderHook(() => useMissionReplyNotifications({ pathname: '/', center }))
    send({ type: 'agent_done', conversationId: 'c1', messageId: 'm1' })
    events[0].open?.()
    expect(h.openMission).toHaveBeenCalledWith('c1')
    expect(h.chat.open).not.toHaveBeenCalled()
    h.mode = 'kanban'
    view.rerender()
    events[0].open?.()
    expect(h.chat.open).toHaveBeenCalledOnce()
    h.windows.transfers = [{ conversationId: 'c1', windowLabel: 'mission-1', state: 'detached' }]
    view.rerender()
    events[0].open?.()
    expect(h.windows.focus).toHaveBeenCalledWith('c1')
  })
})
