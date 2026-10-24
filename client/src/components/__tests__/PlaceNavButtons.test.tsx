import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate, type Location, type NavigateFunction } from 'react-router-dom'

const h = vi.hoisted(() => ({
  desktop: { projects: [{ id: 'a', name: 'Alpha' }], activeProjectId: 'a' as string | null, setActiveProjectId: () => {} },
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('../../hooks/useDesktop', () => ({ useDesktop: () => h.desktop }))

import { PlaceHistoryProvider } from '../../hooks/usePlaceHistory'
import { PlaceNavButtons } from '../PlaceNavButtons'

let nav: NavigateFunction
let loc: Location
function Probe() {
  nav = useNavigate()
  loc = useLocation()
  return null
}

function mount(withProvider = true) {
  const buttons = <><PlaceNavButtons /><Probe /></>
  return render(
    <MemoryRouter initialEntries={['/']}>
      {withProvider ? <PlaceHistoryProvider>{buttons}</PlaceHistoryProvider> : buttons}
    </MemoryRouter>,
  )
}
const back = () => screen.getByTestId('place-nav-back')
const forward = () => screen.getByTestId('place-nav-forward')
const url = () => `${loc.pathname}${loc.search}`

beforeEach(() => {
  Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
})
afterEach(() => { vi.useRealTimers() })

describe('PlaceNavButtons', () => {
  it('renders nothing outside the main window', () => {
    const { container } = mount(false)
    expect(container.querySelector('[data-testid^="place-nav-"]')).toBeNull()
  })

  it('both buttons are disabled when there is nowhere to go', () => {
    mount()
    expect(back()).toBeDisabled()
    expect(forward()).toBeDisabled()
    expect(back()).toHaveAttribute('aria-label', 'Back')
  })

  it('names the target and the shortcut in the tooltip', () => {
    mount()
    act(() => nav('/jobs'))
    act(() => nav('/analytics'))
    expect(back()).toBeEnabled()
    expect(back()).toHaveAttribute('title', 'Back to Jobs (Ctrl+[)')
    expect(back()).toHaveAttribute('aria-label', 'Back to Jobs')
    expect(forward()).toBeDisabled()
  })

  it('uses the ⌘ shortcut on macOS', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    mount()
    act(() => nav('/jobs'))
    expect(back()).toHaveAttribute('title', 'Back to Dashboard (⌘[)')
  })

  it('click goes back, then forward', async () => {
    mount()
    act(() => nav('/jobs'))
    fireEvent.click(back())
    expect(url()).toBe('/')
    expect(forward()).toHaveAttribute('title', 'Forward to Jobs (Ctrl+])')
    fireEvent.click(forward())
    expect(url()).toBe('/jobs')
  })

  it('right-click lists the previous places and jumps straight to the chosen one', () => {
    mount()
    act(() => nav('/jobs'))
    act(() => nav('/analytics'))
    act(() => nav('/activity'))
    fireEvent.contextMenu(back())
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent)
    expect(items).toEqual(['Analytics', 'Jobs', 'Dashboard'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Jobs' }))
    expect(url()).toBe('/jobs')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('right-click on Forward lists the places ahead', () => {
    mount()
    act(() => nav('/jobs'))
    act(() => nav('/analytics'))
    fireEvent.click(back())
    fireEvent.click(back())
    fireEvent.contextMenu(forward())
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Jobs', 'Analytics'])
  })

  it('a long press opens the same menu and the release does not also navigate', () => {
    vi.useFakeTimers()
    mount()
    act(() => nav('/jobs'))
    fireEvent.pointerDown(back(), { button: 0 })
    act(() => { vi.advanceTimersByTime(520) })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.pointerUp(back())
    fireEvent.click(back())
    expect(url()).toBe('/jobs')
  })

  it('a short press is a plain click', () => {
    vi.useFakeTimers()
    mount()
    act(() => nav('/jobs'))
    fireEvent.pointerDown(back(), { button: 0 })
    act(() => { vi.advanceTimersByTime(100) })
    fireEvent.pointerUp(back())
    fireEvent.click(back())
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(url()).toBe('/')
  })

  it('the menu is never opened on a disabled button', () => {
    mount()
    fireEvent.contextMenu(back())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
