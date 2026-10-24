import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useKeyboardShortcuts, useCheatsheetState, historyDirection, SHORTCUTS } from '../useKeyboardShortcuts'

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

describe('Back / Forward shortcuts', () => {
  function chord(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }

  function mountHistory() {
    const onBack = vi.fn()
    const onForward = vi.fn()
    renderHook(
      () => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn(), onNavigateBack: onBack, onNavigateForward: onForward }),
      { wrapper },
    )
    return { onBack, onForward }
  }

  it('classifies the chords per platform', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
    expect(historyDirection(key({ metaKey: true, code: 'BracketLeft' }), true)).toBe('back')
    expect(historyDirection(key({ metaKey: true, code: 'BracketRight' }), true)).toBe('forward')
    // Ctrl+[ is not a macOS history chord, ⌘[ is not a Windows/Linux one.
    expect(historyDirection(key({ ctrlKey: true, code: 'BracketLeft' }), true)).toBeNull()
    expect(historyDirection(key({ metaKey: true, code: 'BracketLeft' }), false)).toBeNull()
    expect(historyDirection(key({ ctrlKey: true, code: 'BracketLeft' }), false)).toBe('back')
    expect(historyDirection(key({ ctrlKey: true, code: 'BracketRight' }), false)).toBe('forward')
    expect(historyDirection(key({ altKey: true, key: 'ArrowLeft' }), false)).toBe('back')
    expect(historyDirection(key({ altKey: true, key: 'ArrowRight' }), false)).toBe('forward')
    // ⌥[ ⌥] stay the run-strip cycle, never history.
    expect(historyDirection(key({ altKey: true, code: 'BracketLeft' }), true)).toBeNull()
    expect(historyDirection(key({ altKey: true, code: 'BracketLeft' }), false)).toBeNull()
    expect(historyDirection(key({ metaKey: true, shiftKey: true, code: 'BracketLeft' }), true)).toBeNull()
  })

  it('goes back / forward with Ctrl+[ ] and prevents the browser default', () => {
    const { onBack, onForward } = mountHistory()
    expect(chord({ ctrlKey: true, code: 'BracketLeft' }).defaultPrevented).toBe(true)
    expect(onBack).toHaveBeenCalledOnce()
    chord({ ctrlKey: true, code: 'BracketRight' })
    expect(onForward).toHaveBeenCalledOnce()
    chord({ altKey: true, key: 'ArrowLeft' })
    expect(onBack).toHaveBeenCalledTimes(2)
  })

  it.each(['input', 'textarea', 'select'])('is ignored while typing in a <%s>', (tag) => {
    const { onBack, onForward } = mountHistory()
    const el = document.body.appendChild(document.createElement(tag))
    chord({ ctrlKey: true, code: 'BracketLeft' }, el)
    chord({ altKey: true, key: 'ArrowRight' }, el)
    expect(onBack).not.toHaveBeenCalled()
    expect(onForward).not.toHaveBeenCalled()
    el.remove()
  })

  it('is ignored in contenteditable composers, the terminal and code editors', () => {
    const { onBack } = mountHistory()
    const editable = document.body.appendChild(document.createElement('div'))
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    const xterm = document.body.appendChild(document.createElement('div'))
    xterm.className = 'xterm'
    const xtermChild = xterm.appendChild(document.createElement('textarea'))
    const monaco = document.body.appendChild(document.createElement('div'))
    monaco.className = 'monaco-editor'
    const monacoChild = monaco.appendChild(document.createElement('div'))
    for (const target of [editable, xtermChild, monacoChild]) chord({ ctrlKey: true, code: 'BracketLeft' }, target)
    expect(onBack).not.toHaveBeenCalled()
    for (const el of [editable, xterm, monaco]) el.remove()
  })

  it('works from inside a dialog, so Back closes a modal opened as a place', () => {
    const { onBack } = mountHistory()
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    const button = dialog.appendChild(document.createElement('button'))
    chord({ ctrlKey: true, code: 'BracketLeft' }, button)
    expect(onBack).toHaveBeenCalledOnce()
    dialog.remove()
  })

  it('does nothing (and does not swallow the key) when no history handler is wired', () => {
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn() }), { wrapper })
    expect(chord({ ctrlKey: true, code: 'BracketLeft' }).defaultPrevented).toBe(false)
  })
})

describe('Inbox chord', () => {
  const chordI = (opts: KeyboardEventInit, target: EventTarget = window) => {
    const e = new KeyboardEvent('keydown', { code: 'KeyI', key: 'I', bubbles: true, cancelable: true, ...opts })
    target.dispatchEvent(e)
    return e
  }

  const asPlatform = (platform: string) => vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform)
  afterEach(() => vi.restoreAllMocks())

  it('⌘⇧I toggles the inbox on macOS, even from a text field', () => {
    asPlatform('MacIntel')
    const onToggleInbox = vi.fn()
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn(), onToggleInbox }), { wrapper })
    expect(chordI({ metaKey: true, shiftKey: true }).defaultPrevented).toBe(true)
    const input = document.body.appendChild(document.createElement('input'))
    chordI({ metaKey: true, shiftKey: true }, input)
    expect(onToggleInbox).toHaveBeenCalledTimes(2)
    input.remove()
  })

  it('Ctrl+Alt+I toggles it elsewhere; Ctrl+Shift+I stays free for DevTools', () => {
    asPlatform('Win32')
    const onToggleInbox = vi.fn()
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn(), onToggleInbox }), { wrapper })
    expect(chordI({ ctrlKey: true, altKey: true }).defaultPrevented).toBe(true)
    expect(onToggleInbox).toHaveBeenCalledTimes(1)
    expect(chordI({ ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false)
    expect(onToggleInbox).toHaveBeenCalledTimes(1)
  })

  it('leaves the chord alone without a handler, without Shift, or inside a dialog', () => {
    asPlatform('MacIntel')
    const onToggleInbox = vi.fn()
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn() }), { wrapper })
    expect(chordI({ metaKey: true, shiftKey: true }).defaultPrevented).toBe(false)
    renderHook(() => useKeyboardShortcuts({ onOpenCheatsheet: vi.fn(), onToggleInbox }), { wrapper })
    chordI({ metaKey: true })
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    const button = dialog.appendChild(document.createElement('button'))
    chordI({ metaKey: true, shiftKey: true }, button)
    expect(onToggleInbox).not.toHaveBeenCalled()
    dialog.remove()
  })

  it('is listed in the cheatsheet shortcuts', () => {
    expect(SHORTCUTS.find((s) => s.keys === '⌘⇧I')).toMatchObject({ descriptionKey: 'shortcuts.items.openInbox', platform: 'mac' })
    expect(SHORTCUTS.find((s) => s.keys === 'Ctrl+Alt+I')).toMatchObject({ descriptionKey: 'shortcuts.items.openInbox', platform: 'other' })
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
