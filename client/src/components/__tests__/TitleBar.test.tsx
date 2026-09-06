/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TitleBar } from '../TitleBar'

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

  it('renders nothing outside Tauri', () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    const { container } = render(<TitleBar />)
    expect(container.firstChild).toBeNull()
  })

  it('uses theme tokens for the macOS overlay titlebar', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
    render(<TitleBar />)

    const titlebar = screen.getByLabelText('Search (⌘K)').parentElement as HTMLElement
    expect(titlebar.style.background).toBe('var(--color-background-deep)')
    expect(titlebar.style.borderBottom).toBe('1px solid var(--color-border)')
    expect(screen.getByLabelText('Search (⌘K)')).toHaveStyle({
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
})
