/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactElement } from 'react'
import { SidebarPinProvider } from '../../context/SidebarPinContext'
import { TitleBar as TitleBarComponent } from '../TitleBar'

function TitleBar({ path = '/', showSidebarToggles }: { path?: string; showSidebarToggles?: boolean } = {}): ReactElement {
  return <MemoryRouter initialEntries={[path]}><TitleBarComponent showSidebarToggles={showSidebarToggles} /></MemoryRouter>
}

const mocks = vi.hoisted(() => ({
  minimize: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  useDesktop: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: mocks.minimize,
    isMaximized: mocks.isMaximized,
    onResized: mocks.onResized,
    toggleMaximize: mocks.toggleMaximize,
    close: mocks.close,
  }),
}))

vi.mock('../PlaceNavButtons', () => ({
  PlaceNavButtons: () => <div data-testid="place-nav" />,
}))

vi.mock('../../features/inbox/components/InboxButton', () => ({
  InboxButton: () => <button type="button" data-testid="inbox-button">Inbox</button>,
}))

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => mocks.useDesktop(),
}))

describe('TitleBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isMaximized.mockResolvedValue(false)
    mocks.onResized.mockResolvedValue(() => {})
    mocks.useDesktop.mockReturnValue({
      projects: [{ id: 'p1', name: 'Project One' }],
      activeProjectId: 'p1',
    })
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  })

  it('[spec:mission-window-titlebar/other-windows-keep-their-title-bar] provides sidebar recovery controls outside Tauri', () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    render(<TitleBar />)
    expect(screen.getByRole('button', { name: /left sidebar/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /right sidebar/i })).toBeInTheDocument()
    // The inbox works in the browser too, so its button is there as in the desktop title bar.
    expect(screen.getByTestId('inbox-button')).toBeInTheDocument()
  })

  it('labels the search shortcut for the keyboard in use (Ctrl on Windows and Linux)', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    render(<TitleBar />)
    expect(screen.getByTitle('Search (Ctrl+K)')).toBeInTheDocument()
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
  })

  it('exposes the platform shortcut and a name that leads with the visible project name', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    const { unmount } = render(<TitleBar />)
    const pill = screen.getByRole('button', { name: 'Search Project One' })
    expect(pill).toHaveAttribute('aria-keyshortcuts', 'Control+K')
    unmount()
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    render(<TitleBar />)
    expect(screen.getByRole('button', { name: 'Search Project One' })).toHaveAttribute('aria-keyshortcuts', 'Meta+K')
  })

  it('uses theme tokens for the macOS overlay titlebar', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    render(<TitleBar />)

    const pill = screen.getByTitle('Search (⌘K)')
    expect(pill).toHaveAttribute('aria-keyshortcuts', 'Meta+K')
    const titlebar = pill.parentElement as HTMLElement
    expect(titlebar.tagName).toBe('HEADER')
    expect(titlebar.style.background).toBe('var(--color-background-deep)')
    expect(titlebar.style.borderBottom).toBe('1px solid var(--color-border)')
    expect(titlebar.style.height).toBe('36px')
    expect(pill).toHaveStyle({
      color: 'var(--color-foreground)',
    })
  })

  it('updates Windows maximize/restore controls after native resize and acts on this window', async () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    let resized!: () => void
    const unlisten = vi.fn()
    mocks.onResized.mockImplementation(async (handler: () => void) => { resized = handler; return unlisten })
    const { unmount } = render(<TitleBar />)
    await waitFor(() => expect(mocks.isMaximized).toHaveBeenCalled())
    fireEvent.click(screen.getByLabelText('Maximize window'))
    expect(mocks.toggleMaximize).toHaveBeenCalledTimes(1)
    mocks.isMaximized.mockResolvedValue(true)
    await act(async () => { resized() })
    expect(screen.getByLabelText('Restore window')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Minimize window'))
    fireEvent.click(screen.getByLabelText('Close window'))
    expect(mocks.minimize).toHaveBeenCalledTimes(1)
    expect(mocks.close).toHaveBeenCalledTimes(1)
    unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('cycles both sidebars from the titlebar without making buttons drag targets', () => {
    localStorage.clear()
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    render(<SidebarPinProvider><TitleBar /></SidebarPinProvider>)
    // New users start with the left sidebar pinned open.
    const left = screen.getByRole('button', { name: 'Collapse left sidebar (keep pinned)' })
    expect(left).not.toHaveAttribute('data-tauri-drag-region')
    expect(left).toHaveAttribute('aria-pressed', 'true')
    expect(left.getAttribute('title')).toContain('⌘B')
    expect(left.getAttribute('title')).not.toContain('⌥')
    fireEvent.click(left)
    expect(screen.getByRole('button', { name: 'Unpin left sidebar' })).toBeInTheDocument()
    const right = screen.getByRole('button', { name: 'Pin right sidebar open' })
    expect(right).toHaveAttribute('aria-pressed', 'false')
    expect(right.getAttribute('title')).toContain('⌥⌘B')
    fireEvent.click(right)
    expect(screen.getByRole('button', { name: 'Collapse right sidebar (keep pinned)' })).toBeInTheDocument()
    localStorage.clear()
  })

  it('hides the right sidebar button where no right sidebar is mounted', () => {
    localStorage.clear()
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    const { unmount } = render(<SidebarPinProvider><TitleBar path="/docs" /></SidebarPinProvider>)
    expect(screen.queryByRole('button', { name: 'Pin right sidebar open' })).not.toBeInTheDocument()
    unmount()
    mocks.useDesktop.mockReturnValue({ projects: [], activeProjectId: null })
    render(<SidebarPinProvider><TitleBar /></SidebarPinProvider>)
    expect(screen.queryByRole('button', { name: 'Pin right sidebar open' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse left sidebar (keep pinned)' })).toBeInTheDocument()
  })

  it('uses theme tokens for default window controls', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true })
    render(<TitleBar />)

    const titlebar = screen.getByLabelText('Minimize window').closest('[data-tauri-drag-region]') as HTMLElement
    expect(titlebar.style.background).toBe('var(--color-background-deep)')
    expect(titlebar.style.borderBottom).toBe('1px solid var(--color-border)')
    expect(screen.getByLabelText('Minimize window')).toHaveStyle({
      color: 'var(--color-muted-foreground)',
    })
  })

  it('[spec:mission-window-titlebar/mission-window-hides-sidebar-toggles] [spec:mission-window-titlebar/mission-window-keeps-the-rest-of-the-title-bar] omits both sidebar buttons in the macOS mission window and keeps the rest of the bar', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    render(<SidebarPinProvider><TitleBar showSidebarToggles={false} /></SidebarPinProvider>)
    expect(screen.queryByRole('button', { name: /left sidebar/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /right sidebar/i })).not.toBeInTheDocument()
    const pill = screen.getByTitle('Search (⌘K)')
    expect(pill).toBeInTheDocument()
    const leftCluster = screen.getByTestId('place-nav').parentElement as HTMLElement
    expect(leftCluster).toHaveClass('ml-[80px]')
    expect(leftCluster.parentElement).toBe(pill.parentElement)
  })

  it('[spec:mission-window-titlebar/mission-window-hides-sidebar-toggles] [spec:mission-window-titlebar/mission-window-keeps-the-rest-of-the-title-bar] omits sidebar buttons in the Windows/Linux mission window and keeps window controls', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true })
    render(<SidebarPinProvider><TitleBar showSidebarToggles={false} /></SidebarPinProvider>)
    expect(screen.queryByRole('button', { name: /left sidebar/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /right sidebar/i })).not.toBeInTheDocument()
    const minimize = screen.getByLabelText('Minimize window')
    fireEvent.click(minimize)
    fireEvent.click(screen.getByLabelText('Maximize window'))
    fireEvent.click(screen.getByLabelText('Close window'))
    expect(mocks.minimize).toHaveBeenCalledTimes(1)
    expect(mocks.toggleMaximize).toHaveBeenCalledTimes(1)
    expect(mocks.close).toHaveBeenCalledTimes(1)
    const controls = minimize.parentElement as HTMLElement
    expect(controls.style.minWidth).toBe('116px')
    expect(controls.style.justifyContent).toBe('flex-end')
  })

  it.each([['MacIntel'], ['Linux x86_64']])('[spec:mission-window-titlebar/other-windows-keep-their-title-bar] shows both sidebar buttons by default on %s', (platform) => {
    localStorage.clear()
    Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
    render(<SidebarPinProvider><TitleBar /></SidebarPinProvider>)
    expect(screen.getByRole('button', { name: 'Collapse left sidebar (keep pinned)' }).getAttribute('title')).toContain('B')
    expect(screen.getByRole('button', { name: 'Pin right sidebar open' })).toBeInTheDocument()
    localStorage.clear()
  })

  it('[spec:mission-window-titlebar/other-windows-keep-their-title-bar] titles the sidebar buttons with the ⌘B and ⌥⌘B shortcuts on macOS', () => {
    localStorage.clear()
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    render(<SidebarPinProvider><TitleBar /></SidebarPinProvider>)
    expect(screen.getByRole('button', { name: 'Collapse left sidebar (keep pinned)' }).getAttribute('title')).toContain('⌘B')
    expect(screen.getByRole('button', { name: 'Pin right sidebar open' }).getAttribute('title')).toContain('⌥⌘B')
    localStorage.clear()
  })
})
