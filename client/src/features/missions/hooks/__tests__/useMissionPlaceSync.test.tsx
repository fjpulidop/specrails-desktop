import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { MemoryRouter, useLocation, type Location } from 'react-router-dom'
import { useEffect, useReducer } from 'react'

type Conversation = { id: string; title: string | null }

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  desktop: { projects: [{ id: 'a', name: 'Alpha' }], activeProjectId: 'a' as string | null, setActiveProjectId: () => {} },
  ui: { mode: 'agent' as 'kanban' | 'agent' },
  chat: {
    active: null as { id: string } | null,
    conversations: [] as Array<{ id: string; title: string | null }>,
    missing: new Set<string>(),
    select: vi.fn(),
    listeners: new Set<() => void>(),
  },
}))

vi.mock('sonner', () => ({ toast: Object.assign((...args: unknown[]) => h.toast(...args), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => h.desktop }))
vi.mock('../../../../context/UiModeContext', () => ({
  useUiMode: () => ({ uiMode: h.ui.mode, setUiMode: vi.fn(), toggleUiMode: vi.fn() }),
}))
vi.mock('../../context/AgentChatContext', () => ({
  useAgentChat: () => ({
    active: h.chat.active,
    conversations: h.chat.conversations,
    selectConversation: h.chat.select,
  }),
}))

import { PlaceHistoryProvider, usePlaceHistory, type PlaceHistoryValue } from '../../../../hooks/usePlaceHistory'
import { markUserPlaceIntent, consumeUserPlaceIntent } from '../../../../lib/places'
import { useMissionPlaceSync } from '../useMissionPlaceSync'

let places: PlaceHistoryValue | null = null
let loc: Location

function useChatTick() {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    h.chat.listeners.add(tick)
    return () => { h.chat.listeners.delete(tick) }
  }, [])
}
const notify = () => act(() => { for (const l of h.chat.listeners) l() })

function Harness({ children }: { children: React.ReactNode }) {
  useChatTick()
  return <PlaceHistoryProvider>{children}</PlaceHistoryProvider>
}
function Probe() {
  useChatTick()
  places = usePlaceHistory()
  loc = useLocation()
  useMissionPlaceSync()
  return null
}

const url = () => `${loc.pathname}${loc.search}`
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

/** The person picks a mission (sidebar / selector): the click marks intent, the load finishes later. */
async function userSelects(id: string) {
  markUserPlaceIntent()
  h.chat.active = { id }
  notify()
  await settle()
}

function mount(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Harness><Probe /></Harness>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  h.toast.mockClear()
  h.ui.mode = 'agent'
  h.chat.active = null
  h.chat.missing = new Set()
  h.chat.listeners.clear()
  h.chat.conversations = [
    { id: 'm1', title: 'First mission' },
    { id: 'm2', title: 'Second mission' },
    { id: 'm3', title: null },
  ] satisfies Conversation[]
  h.chat.select = vi.fn(async (id: string) => {
    if (h.chat.missing.has(id)) throw new Error('404')
    h.chat.active = { id }
    for (const l of h.chat.listeners) l()
  })
  consumeUserPlaceIntent()
  places = null
})

describe('useMissionPlaceSync', () => {
  it('an automatic selection (initial restore, first send) rewrites the URL without adding a Back stop', async () => {
    mount()
    h.chat.active = { id: 'm1' }
    notify()
    await settle()
    expect(url()).toBe('/?mission=m1')
    expect(places?.canBack).toBe(false)
  })

  it('a mission the person picks is a place; Back selects the previous one without pushing', async () => {
    mount('/?mission=m1')
    h.chat.active = { id: 'm1' }
    notify()
    await userSelects('m2')
    expect(url()).toBe('/?mission=m2')
    expect(places?.canBack).toBe(true)
    expect(places?.backTarget?.label).toBe('Mission · First mission')

    h.chat.select.mockClear()
    act(() => places?.back())
    await settle()
    expect(h.chat.select).toHaveBeenCalledWith('m1', { placeRestore: true })
    expect(url()).toBe('/?mission=m1')
    // Restoring added nothing: Forward still returns to m2, and there is no m3 stop.
    expect(places?.forwardTarget?.label).toBe('Mission · Second mission')
    act(() => places?.forward())
    await settle()
    expect(h.chat.select).toHaveBeenLastCalledWith('m2', { placeRestore: true })
    expect(url()).toBe('/?mission=m2')
  })

  it('a mission switch preserves filters and other params of the entry', async () => {
    mount('/?mission=m1&status=done')
    h.chat.active = { id: 'm1' }
    notify()
    await userSelects('m2')
    expect(new URLSearchParams(loc.search).get('status')).toBe('done')
    expect(new URLSearchParams(loc.search).get('mission')).toBe('m2')
  })

  it('skips a deleted mission on Back with a quiet toast', async () => {
    mount('/?mission=m1')
    h.chat.active = { id: 'm1' }
    notify()
    await userSelects('m2')
    await userSelects('m3')
    // m2 was deleted meanwhile.
    h.chat.conversations = h.chat.conversations.filter((c) => c.id !== 'm2')
    h.chat.missing.add('m2')
    act(() => places?.back())
    await settle()
    await settle()
    expect(h.toast).toHaveBeenCalledWith('That mission no longer exists, so it was skipped.', expect.anything())
    expect(url()).toBe('/?mission=m1')
    expect(h.chat.active).toEqual({ id: 'm1' })
  })

  it('a transient load failure is not mistaken for a deleted mission', async () => {
    mount('/?mission=m1')
    h.chat.active = { id: 'm1' }
    notify()
    await userSelects('m2')
    h.chat.missing.add('m1') // still listed, but the load fails (offline)
    act(() => places?.back())
    await settle()
    await settle()
    expect(h.toast).not.toHaveBeenCalled()
  })

  it('starting a new mission is a push, Back returns to the mission and never re-creates a draft', async () => {
    mount('/?mission=m1')
    h.chat.active = { id: 'm1' }
    notify()
    markUserPlaceIntent()
    h.chat.active = null // startNewConversation
    notify()
    await settle()
    expect(url()).toBe('/')
    act(() => places?.back())
    await settle()
    expect(url()).toBe('/?mission=m1')
    expect(h.chat.select).toHaveBeenCalledWith('m1', { placeRestore: true })
    // Forward does not go to the compose screen: it would reset the conversation to a draft.
    expect(places?.canForward).toBe(false)
  })

  it('the first message of a new mission replaces the compose entry', async () => {
    mount('/?mission=m1')
    h.chat.active = { id: 'm1' }
    notify()
    markUserPlaceIntent()
    h.chat.active = null
    notify()
    await settle()
    h.chat.active = { id: 'm3' } // send() created the conversation: not a user pick
    notify()
    await settle()
    expect(url()).toBe('/?mission=m3')
    act(() => places?.back())
    await settle()
    expect(url()).toBe('/?mission=m1')
  })

  it('does nothing in Board mode', async () => {
    h.ui.mode = 'kanban'
    mount()
    h.chat.active = { id: 'm1' }
    notify()
    await settle()
    expect(url()).toBe('/')
    expect(h.chat.select).not.toHaveBeenCalled()
  })

  it('does not write a mission onto a docs route', async () => {
    mount('/docs/guide/intro')
    h.chat.active = { id: 'm1' }
    notify()
    await settle()
    expect(url()).toBe('/docs/guide/intro')
  })

  it('a deep link to a mission selects it', async () => {
    mount('/?mission=m2')
    await settle()
    expect(h.chat.select).toHaveBeenCalledWith('m2', { placeRestore: true })
    expect(url()).toBe('/?mission=m2')
  })

  it('ignores a router location that trails the History API (a cached revisit must not be pulled back)', async () => {
    mount('/?mission=m1')
    h.chat.active = { id: 'm1' }
    notify()
    await settle()
    h.chat.select.mockClear()
    // The browser router already moved the real history entry on; its React state commits later (a transition).
    window.history.replaceState({ idx: 3, key: 'newer-entry', usr: null }, '')
    try {
      await userSelects('m2') // sync from cache: m2 is open, `?mission=m1` has not been replaced yet
      expect(h.chat.select).not.toHaveBeenCalledWith('m1', expect.anything())
      expect(h.chat.active).toEqual({ id: 'm2' })
    } finally {
      window.history.replaceState(null, '')
    }
  })
})
