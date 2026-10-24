import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useKeyboardShortcuts, useCheatsheetState } from '../useKeyboardShortcuts'

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>
}

function fireKey(key: string, opts?: Partial<KeyboardEvent>) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }))
}

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    mockNavigate.mockClear()
  })

  it('opens cheatsheet on ? key', () => {
    const onOpen = vi.fn()
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: onOpen }), { wrapper })

    fireKey('?')
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('navigates to dashboard on G D', () => {
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn() }), { wrapper })

    fireKey('g')
    fireKey('d')
    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('navigates to activity on G J', () => {
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn() }), { wrapper })

    fireKey('g')
    fireKey('j')
    expect(mockNavigate).toHaveBeenCalledWith('/activity')
  })

  it('navigates to analytics on G A', () => {
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn() }), { wrapper })

    fireKey('g')
    fireKey('a')
    expect(mockNavigate).toHaveBeenCalledWith('/analytics')
  })

  it('navigates to settings on G S', () => {
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn() }), { wrapper })

    fireKey('g')
    fireKey('s')
    expect(mockNavigate).toHaveBeenCalledWith('/settings')
  })

  it('navigates to dashboard on G P', () => {
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn() }), { wrapper })

    fireKey('g')
    fireKey('p')
    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('forwards cmd+5 to the project-page index handler', () => {
    const onSwitchProjectPage = vi.fn()
    renderHook(
      () =>
        useKeyboardShortcuts({
          onOpenCheatsheet: vi.fn(),
          onSwitchProjectPage,
        }),
      { wrapper },
    )

    fireKey('5', { metaKey: true, code: 'Digit5' })
    expect(onSwitchProjectPage).toHaveBeenCalledWith(5)
  })

  it('⌘B toggles the LEFT sidebar and ⌥⌘B the RIGHT one (VS Code convention)', () => {
    const onToggleLeftSidebar = vi.fn()
    const onToggleRightSidebar = vi.fn()
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn(), onToggleLeftSidebar, onToggleRightSidebar }), { wrapper })

    fireKey('b', { code: 'KeyB', metaKey: true })
    expect(onToggleLeftSidebar).toHaveBeenCalledOnce()
    expect(onToggleRightSidebar).not.toHaveBeenCalled()

    fireKey('∫', { code: 'KeyB', metaKey: true, altKey: true })
    expect(onToggleRightSidebar).toHaveBeenCalledOnce()
    expect(onToggleLeftSidebar).toHaveBeenCalledOnce()
  })

  it('does not trigger shortcuts when typing in an input', () => {
    const onOpen = vi.fn()
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: onOpen }), { wrapper })

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    const event = new KeyboardEvent('keydown', { key: '?', bubbles: true })
    Object.defineProperty(event, 'target', { value: input })
    window.dispatchEvent(event)

    expect(onOpen).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it('does not trigger shortcuts when typing in a textarea', () => {
    const onOpen = vi.fn()
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: onOpen }), { wrapper })

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()

    const event = new KeyboardEvent('keydown', { key: '?', bubbles: true })
    Object.defineProperty(event, 'target', { value: textarea })
    window.dispatchEvent(event)

    expect(onOpen).not.toHaveBeenCalled()
    document.body.removeChild(textarea)
  })

  it('does not trigger on meta key combos', () => {
    const onOpen = vi.fn()
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: onOpen }), { wrapper })

    fireKey('?', { metaKey: true })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('calls onListNavigate with down for j key', () => {
    const onNav = vi.fn()
    renderHook(
      () => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn(), onListNavigate: onNav }),
      { wrapper },
    )

    fireKey('j')
    expect(onNav).toHaveBeenCalledWith('down')
  })

  it('calls onListNavigate with up for k key', () => {
    const onNav = vi.fn()
    renderHook(
      () => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn(), onListNavigate: onNav }),
      { wrapper },
    )

    fireKey('k')
    expect(onNav).toHaveBeenCalledWith('up')
  })
})

describe('useCheatsheetState', () => {
  it('starts closed and can be opened', () => {
    const { result } = renderHook(() => useCheatsheetState())

    expect(result.current.cheatsheetOpen).toBe(false)

    act(() => result.current.openCheatsheet())
    expect(result.current.cheatsheetOpen).toBe(true)

    act(() => result.current.closeCheatsheet())
    expect(result.current.cheatsheetOpen).toBe(false)
  })
})
