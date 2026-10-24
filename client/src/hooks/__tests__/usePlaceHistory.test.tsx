import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate, type Location, type NavigateFunction } from 'react-router-dom'
import { useEffect, useReducer, type ReactNode } from 'react'

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  desktop: {
    projects: [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ] as Array<{ id: string; name: string }>,
    activeProjectId: 'a' as string | null,
    setActiveProjectId: (_id: string | null) => {},
    listeners: new Set<() => void>(),
  },
  ui: { mode: 'kanban' as 'kanban' | 'agent', setUiMode: vi.fn(), toggleUiMode: vi.fn() },
}))

vi.mock('sonner', () => ({ toast: Object.assign((...args: unknown[]) => h.toast(...args), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('../useDesktop', () => ({ useDesktop: () => h.desktop }))
vi.mock('../../context/UiModeContext', () => ({
  useUiMode: () => ({ uiMode: h.ui.mode, setUiMode: h.ui.setUiMode, toggleUiMode: h.ui.toggleUiMode }),
}))

import { PlaceHistoryProvider, usePlaceHistory, type PlaceHistoryValue } from '../usePlaceHistory'
import { useProjectRouteMemory } from '../../App'

let places: PlaceHistoryValue | null = null
let nav: NavigateFunction
let loc: Location

function useDesktopTick() {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    h.desktop.listeners.add(tick)
    return () => { h.desktop.listeners.delete(tick) }
  }, [])
}

function Harness({ children }: { children: ReactNode }) {
  useDesktopTick()
  return <PlaceHistoryProvider>{children}</PlaceHistoryProvider>
}

function Probe({ routeMemory = true }: { routeMemory?: boolean }) {
  useDesktopTick()
  places = usePlaceHistory()
  nav = useNavigate()
  loc = useLocation()
  // Hooks may not be conditional: the flag is constant per mount.
  useProjectRouteMemoryMaybe(routeMemory)
  return null
}

function useProjectRouteMemoryMaybe(enabled: boolean) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (enabled) useProjectRouteMemory(h.desktop.activeProjectId)
}

function mount(initial = '/', options?: { routeMemory?: boolean }) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Harness><Probe routeMemory={options?.routeMemory} /></Harness>
    </MemoryRouter>,
  )
}

const url = () => `${loc.pathname}${loc.search}`
const settle = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  h.toast.mockClear()
  h.ui.mode = 'kanban'
  h.ui.setUiMode.mockClear()
  h.ui.toggleUiMode.mockClear()
  h.desktop.activeProjectId = 'a'
  h.desktop.listeners.clear()
  h.desktop.setActiveProjectId = (id) => {
    h.desktop.activeProjectId = id
    for (const l of h.desktop.listeners) l()
  }
  places = null
})

describe('PlaceHistoryProvider', () => {
  it('has nothing to go back or forward to on a fresh start', () => {
    mount()
    expect(places?.canBack).toBe(false)
    expect(places?.canForward).toBe(false)
  })

  it('Back / Forward walk through routes', async () => {
    mount()
    act(() => nav('/jobs'))
    act(() => nav('/analytics'))
    expect(places?.canBack).toBe(true)
    expect(places?.backTarget?.label).toBe('Jobs')
    act(() => places?.back())
    await settle()
    expect(url()).toBe('/jobs')
    expect(places?.forwardTarget?.label).toBe('Analytics')
    act(() => places?.forward())
    await settle()
    expect(url()).toBe('/analytics')
  })

  it('Back across a project switch restores the previous project and its route', async () => {
    mount()
    act(() => nav('/jobs'))
    // A user switch pushes an entry carrying the ?p= marker.
    act(() => h.desktop.setActiveProjectId('b'))
    await settle()
    expect(url()).toBe('/?p=b')
    expect(h.desktop.activeProjectId).toBe('b')
    expect(places?.canBack).toBe(true)

    act(() => places?.back())
    await settle()
    // The project came back AND the route memory did not bounce the URL to b's route.
    expect(h.desktop.activeProjectId).toBe('a')
    expect(url()).toBe('/jobs')

    act(() => places?.forward())
    await settle()
    expect(h.desktop.activeProjectId).toBe('b')
    expect(url()).toBe('/?p=b')
  })

  it('a project switch keeps the selected mission and drops the previous project\'s overlays', async () => {
    h.ui.mode = 'agent'
    mount('/?mission=m1&spec=15&status=done')
    act(() => h.desktop.setActiveProjectId('b'))
    await settle()
    expect(new URLSearchParams(loc.search).get('mission')).toBe('m1')
    expect(new URLSearchParams(loc.search).get('p')).toBe('b')
    expect(new URLSearchParams(loc.search).has('spec')).toBe(false)
    expect(new URLSearchParams(loc.search).has('status')).toBe(false)
  })

  it('the very first project resolution adds no history entry', async () => {
    h.desktop.activeProjectId = null
    mount()
    act(() => h.desktop.setActiveProjectId('a'))
    await settle()
    expect(places?.canBack).toBe(false)
  })

  it('labels a target in another project with that project name', async () => {
    mount()
    act(() => nav('/jobs'))
    act(() => h.desktop.setActiveProjectId('b'))
    await settle()
    expect(places?.backTarget?.label).toBe('Jobs — Alpha')
  })

  it('does not record filters / sort / search as places', async () => {
    mount()
    act(() => nav('/jobs'))
    for (const q of ['?status=done', '?status=failed&sort=cost', '?q=login']) {
      act(() => nav(`/jobs${q}`, { replace: true }))
    }
    expect(places?.list('back')).toHaveLength(1)
    act(() => places?.back())
    await settle()
    expect(url()).toBe('/')
    expect(places?.canBack).toBe(false)
  })

  it('collapses consecutive identical places even when something pushed them', async () => {
    mount()
    act(() => nav('/jobs'))
    act(() => nav('/jobs?status=done'))
    act(() => nav('/jobs?status=failed'))
    expect(places?.list('back').map((t) => t.label)).toEqual(['Dashboard'])
    act(() => places?.back())
    await settle()
    expect(url()).toBe('/')
  })

  it('Back never flips the mode: it only ever restores the entry in the current mode\'s form', async () => {
    // Entries created in Mission mode, then the person switched to Board mode.
    mount('/?mission=m1')
    act(() => nav('/?mission=m2'))
    act(() => nav('/?mission=m2&review=r1'))
    h.ui.mode = 'kanban'
    act(() => { for (const l of h.desktop.listeners) l() })
    // In Board mode the missions are the same Dashboard place; the review is the /review route.
    expect(places?.list('back').map((t) => t.label)).toEqual(['Dashboard'])
    act(() => places?.back())
    await settle()
    expect(h.ui.setUiMode).not.toHaveBeenCalled()
    expect(h.ui.toggleUiMode).not.toHaveBeenCalled()
  })

  it('Mission mode skips entries that mean nothing there and never goes back to the compose screen', async () => {
    h.ui.mode = 'agent'
    mount('/?mission=m1')
    act(() => nav('/'))            // compose screen: not restorable
    act(() => nav('/jobs'))        // Board-only route: collapses onto the compose screen
    act(() => nav('/?mission=m2'))
    expect(places?.list('back').map((t) => t.label)).toEqual(['Mission'])
    act(() => places?.back())
    await settle()
    expect(url()).toBe('/?mission=m1')
    // And Forward from m1 returns to m2, skipping the compose entries.
    act(() => places?.forward())
    await settle()
    expect(url()).toBe('/?mission=m2')
  })

  it('skips an entry whose target was deleted, with a quiet toast, continuing in the same direction', async () => {
    h.ui.mode = 'agent'
    mount('/?mission=m1')
    act(() => nav('/?mission=m2'))
    act(() => nav('/?mission=m3'))
    act(() => places?.back())
    await settle()
    expect(url()).toBe('/?mission=m2')
    // The surface that owns m2 finds it gone.
    act(() => places?.reportMissing('mission'))
    await settle()
    expect(url()).toBe('/?mission=m1')
    expect(h.toast).toHaveBeenCalledWith('That mission no longer exists, so it was skipped.', expect.anything())
    // m2 is dead for good: Forward goes straight to m3.
    act(() => places?.forward())
    await settle()
    expect(url()).toBe('/?mission=m3')
  })

  it('returns to where the user was when nothing further is left to skip to', async () => {
    h.ui.mode = 'agent'
    mount('/?mission=m1')
    act(() => nav('/?mission=m2'))
    act(() => places?.back())
    await settle()
    expect(url()).toBe('/?mission=m1')
    act(() => places?.reportMissing('mission'))
    await settle()
    expect(url()).toBe('/?mission=m2')
  })

  it('a missing target reached by a deep link (not Back) just loses the param', async () => {
    mount('/?spec=999')
    act(() => places?.reportMissing('spec'))
    await settle()
    expect(url()).toBe('/')
    expect(h.toast).toHaveBeenCalledOnce()
    expect(places?.canBack).toBe(false)
  })

  it('goTo jumps to an entry listed in the history menu', async () => {
    mount()
    act(() => nav('/jobs'))
    act(() => nav('/analytics'))
    act(() => nav('/activity'))
    const items = places!.list('back')
    expect(items.map((i) => i.label)).toEqual(['Analytics', 'Jobs', 'Dashboard'])
    act(() => places?.goTo(items[2].idx))
    await settle()
    expect(url()).toBe('/')
    expect(places?.list('forward')).toHaveLength(3)
  })

  it('caps the menu at the requested size', async () => {
    mount()
    for (let i = 0; i < 15; i++) act(() => nav(`/?mission=m${i}`))
    h.ui.mode = 'agent'
    act(() => { for (const l of h.desktop.listeners) l() })
    expect(places?.list('back')).toHaveLength(10)
  })

  it('resolves spec and mission titles through registered resolvers', () => {
    h.ui.mode = 'agent'
    mount('/?mission=m1&spec=15')
    act(() => nav('/?mission=m1'))
    const off = places!.registerLabelResolver((kind, id) => (kind === 'spec' && id === '15' ? 'Add achievements' : null))
    expect(places?.list('back')[0].label).toBe('#15 · Add achievements')
    off()
  })
})

describe('mouse buttons 4 / 5', () => {
  function click(button: number, type = 'mouseup'): MouseEvent {
    const event = new MouseEvent(type, { button, bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    return event
  }

  it('button 4 (index 3) goes back and button 5 (index 4) goes forward, preventing the native navigation', async () => {
    mount()
    act(() => nav('/jobs'))
    let event!: MouseEvent
    act(() => { event = click(3) })
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(url()).toBe('/')
    act(() => { event = click(4) })
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(url()).toBe('/jobs')
  })

  it('swallows the press / aux events too, so WebView2 cannot navigate a second time', () => {
    mount()
    expect(click(3, 'mousedown').defaultPrevented).toBe(true)
    expect(click(4, 'auxclick').defaultPrevented).toBe(true)
  })

  it('leaves the other buttons alone', async () => {
    mount()
    act(() => nav('/jobs'))
    expect(click(0).defaultPrevented).toBe(false)
    expect(click(1).defaultPrevented).toBe(false)
    expect(click(2).defaultPrevented).toBe(false)
    expect(url()).toBe('/jobs')
  })

  it('does nothing (but still blocks the native jump) when there is nowhere to go', () => {
    mount()
    expect(click(3).defaultPrevented).toBe(true)
    expect(url()).toBe('/')
  })
})
