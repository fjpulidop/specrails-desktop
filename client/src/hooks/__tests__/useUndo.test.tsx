import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'

let mockActiveProjectId: string | null = 'p1'
vi.mock('../useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: mockActiveProjectId }),
}))

const toastFn = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>
  fn.success = vi.fn()
  fn.error = vi.fn()
  fn.dismiss = vi.fn()
  return fn
})
vi.mock('sonner', () => ({ toast: toastFn }))

import { UndoProvider, UndoBlockedError, UNDO_WINDOW_MS, useUndo, type UndoRequest } from '../useUndo'

let api: ReturnType<typeof useUndo>
function Probe() {
  api = useUndo()
  return <input data-testid="field" />
}
function Wrapper({ children }: { children?: ReactNode }) {
  return <UndoProvider>{children}<Probe /></UndoProvider>
}

function lastToast() {
  const call = toastFn.mock.calls.at(-1)!
  return { label: call[0] as string, options: call[1] as { id: string; duration: number; action: { label: string; onClick: () => void } } }
}
function pressUndoKey(target: Element | Document = document.body, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(target, { code: 'KeyZ', key: 'z', metaKey: true, ...init })
}

describe('useUndo / UndoProvider', () => {
  beforeEach(() => {
    mockActiveProjectId = 'p1'
    vi.clearAllMocks()
  })
  afterEach(() => { vi.useRealTimers() })

  it('shows a toast with an Undo action that stays for the 8 s window', () => {
    render(<Wrapper />)
    const undo = vi.fn()
    let shown = false
    act(() => { shown = api.pushUndo({ label: 'Deleted “A”', undo }) })
    expect(shown).toBe(true)
    const { label, options } = lastToast()
    expect(label).toBe('Deleted “A”')
    expect(options.duration).toBe(UNDO_WINDOW_MS)
    expect(UNDO_WINDOW_MS).toBe(8000)
    expect(options.action.label).toBe('Undo')
  })

  it('the Undo button runs the undo once and confirms', async () => {
    render(<Wrapper />)
    const undo = vi.fn(async () => {})
    act(() => { api.pushUndo({ label: 'Deleted “A”', undo }) })
    const { options } = lastToast()
    await act(async () => { options.action.onClick(); options.action.onClick() })
    expect(undo).toHaveBeenCalledTimes(1)
    expect(toastFn.success).toHaveBeenCalledWith('Undone · Deleted “A”', expect.objectContaining({ id: options.id }))
  })

  it('⌘Z / Ctrl+Z undoes the latest live entry, newest first', async () => {
    render(<Wrapper />)
    const first = vi.fn(async () => {})
    const second = vi.fn(async () => {})
    act(() => { api.pushUndo({ label: 'one', undo: first }); api.pushUndo({ label: 'two', undo: second }) })
    await act(async () => { pressUndoKey() })
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    await act(async () => { pressUndoKey(document.body, { metaKey: false, ctrlKey: true }) })
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('ignores ⌘Z while focus is in a text field, a code editor or a terminal', async () => {
    render(<Wrapper />)
    const undo = vi.fn(async () => {})
    act(() => { api.pushUndo({ label: 'x', undo }) })
    await act(async () => { pressUndoKey(screen.getByTestId('field')) })
    const editor = document.createElement('div'); editor.className = 'monaco-editor'
    const inner = document.createElement('span'); editor.appendChild(inner); document.body.appendChild(editor)
    await act(async () => { pressUndoKey(inner) })
    const term = document.createElement('div'); term.className = 'specrails-xterm-container'; document.body.appendChild(term)
    await act(async () => { pressUndoKey(term) })
    expect(undo).not.toHaveBeenCalled()
    editor.remove(); term.remove()
    await act(async () => { pressUndoKey() })
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('does nothing for ⌘⇧Z / Alt+⌘Z (redo and other chords)', async () => {
    render(<Wrapper />)
    const undo = vi.fn(async () => {})
    act(() => { api.pushUndo({ label: 'x', undo }) })
    await act(async () => { pressUndoKey(document.body, { shiftKey: true }) })
    await act(async () => { pressUndoKey(document.body, { altKey: true }) })
    expect(undo).not.toHaveBeenCalled()
  })

  it('⌘Z stops working once the window has passed', async () => {
    vi.useFakeTimers()
    render(<Wrapper />)
    const undo = vi.fn(async () => {})
    act(() => { api.pushUndo({ label: 'x', undo }) })
    act(() => { vi.advanceTimersByTime(UNDO_WINDOW_MS + 50) })
    await act(async () => { pressUndoKey() })
    expect(undo).not.toHaveBeenCalled()
  })

  it('is per project: ⌘Z never undoes another project, and a switch ends the previous window', async () => {
    const { rerender } = render(<Wrapper />)
    const undoP1 = vi.fn(async () => {})
    act(() => { api.pushUndo({ label: 'in p1', undo: undoP1 }) })
    const { options } = lastToast()

    mockActiveProjectId = 'p2'
    rerender(<Wrapper />)
    expect(toastFn.dismiss).toHaveBeenCalledWith(options.id)
    await act(async () => { pressUndoKey() })
    expect(undoP1).not.toHaveBeenCalled()

    const undoP2 = vi.fn(async () => {})
    act(() => { api.pushUndo({ label: 'in p2', undo: undoP2 }) })
    await act(async () => { pressUndoKey() })
    expect(undoP2).toHaveBeenCalledTimes(1)
    expect(undoP1).not.toHaveBeenCalled()

    // Coming back to p1 does not resurrect the dismissed entry.
    mockActiveProjectId = 'p1'
    rerender(<Wrapper />)
    await act(async () => { pressUndoKey() })
    expect(undoP1).not.toHaveBeenCalled()
  })

  it('an entry pushed for another project than the active one is not reachable by ⌘Z', async () => {
    render(<Wrapper />)
    const other = vi.fn(async () => {})
    act(() => { api.pushUndo({ projectId: 'p9', label: 'elsewhere', undo: other }) })
    await act(async () => { pressUndoKey() })
    expect(other).not.toHaveBeenCalled()
  })

  it('reports a failed undo, and a refusal with its own reason', async () => {
    render(<Wrapper />)
    act(() => { api.pushUndo({ label: 'x', undo: async () => { throw new Error('boom') } }) })
    await act(async () => { lastToast().options.action.onClick() })
    expect(toastFn.error).toHaveBeenLastCalledWith("Couldn't undo that", expect.anything())
    act(() => { api.pushUndo({ label: 'y', undo: () => { throw new UndoBlockedError('That rail is running') } }) })
    await act(async () => { lastToast().options.action.onClick() })
    expect(toastFn.error).toHaveBeenLastCalledWith('That rail is running', expect.anything())
  })

  it('is a harmless no-op without a provider', () => {
    let bare: ReturnType<typeof useUndo> | undefined
    function Bare() { bare = useUndo(); return null }
    render(<Bare />)
    const req: UndoRequest = { label: 'x', undo: vi.fn() }
    expect(bare!.pushUndo(req)).toBe(false)
    expect(toastFn).not.toHaveBeenCalled()
  })
})
