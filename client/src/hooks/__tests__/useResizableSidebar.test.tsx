import { describe, it, expect, beforeEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import { useResizableSidebar } from '../useResizableSidebar'

const KEY = 'specrails-desktop:sidebar-width:test'

// A tiny host that wires the hook to a real DOM panel + grip, mirroring the
// sidebars. `side`/`expanded` are props so tests exercise both edges/states.
function Host({ side = 'left' as 'left' | 'right', expanded = true }) {
  const r = useResizableSidebar('test', { side, defaultWidth: 240, min: 200, max: 460, collapsedWidth: 44, expanded })
  return (
    <div ref={r.panelRef} data-testid="panel">
      <div data-testid="grip" onPointerDown={r.onGripPointerDown} onKeyDown={r.onGripKeyDown} tabIndex={0} />
      <span data-testid="w">{r.width}</span>
      <span data-testid="dragging">{String(r.dragging)}</span>
    </div>
  )
}

function panelWidth(getByTestId: (id: string) => HTMLElement): string {
  return getByTestId('panel').style.width
}

// jsdom has no real PointerEvent constructor with clientX; fake it.
function pointer(type: string, clientX: number): Event {
  return Object.assign(new Event(type, { bubbles: true }), { clientX, button: 0, pointerId: 1 })
}

describe('useResizableSidebar (imperative, jank-free)', () => {
  beforeEach(() => localStorage.clear())

  it('applies the committed width to the DOM imperatively (expanded)', () => {
    const { getByTestId } = render(<Host />)
    expect(panelWidth(getByTestId)).toBe('240px')
  })

  it('applies the collapsed rail width when collapsed', () => {
    const { getByTestId } = render(<Host expanded={false} />)
    expect(panelWidth(getByTestId)).toBe('44px')
  })

  it('restores a stored width, clamped to [min,max]', () => {
    localStorage.setItem(KEY, '9999')
    const { getByTestId } = render(<Host />)
    expect(panelWidth(getByTestId)).toBe('460px')
  })

  it('a LEFT drag updates the DOM width LIVE without committing state until pointer-up', () => {
    const { getByTestId } = render(<Host side="left" />)
    fireEvent.pointerDown(getByTestId('grip'), { button: 0, clientX: 300, pointerId: 1 })
    // Mid-drag: DOM tracks the pointer, but the state `width` stays at 240 (no
    // re-render churn — the whole point).
    act(() => { window.dispatchEvent(pointer('pointermove', 360)) })
    expect(panelWidth(getByTestId)).toBe('300px')   // +60 imperatively
    expect(getByTestId('w').textContent).toBe('240') // NOT committed yet
    expect(getByTestId('dragging').textContent).toBe('true')
    // Pointer-up commits once + persists.
    act(() => { window.dispatchEvent(pointer('pointerup', 360)) })
    expect(getByTestId('w').textContent).toBe('300')
    expect(getByTestId('dragging').textContent).toBe('false')
    expect(localStorage.getItem(KEY)).toBe('300')
  })

  it('a RIGHT sidebar widens when dragging its grip to the LEFT (inverted axis)', () => {
    const { getByTestId } = render(<Host side="right" />)
    fireEvent.pointerDown(getByTestId('grip'), { button: 0, clientX: 300, pointerId: 1 })
    act(() => { window.dispatchEvent(pointer('pointermove', 240)) }) // -60 → wider
    expect(panelWidth(getByTestId)).toBe('300px')
    act(() => { window.dispatchEvent(pointer('pointerup', 240)) })
    expect(getByTestId('w').textContent).toBe('300')
  })

  it('clamps to min/max during the drag', () => {
    const { getByTestId } = render(<Host side="left" />)
    fireEvent.pointerDown(getByTestId('grip'), { button: 0, clientX: 300, pointerId: 1 })
    act(() => { window.dispatchEvent(pointer('pointermove', 99999)) })
    expect(panelWidth(getByTestId)).toBe('460px')
    act(() => { window.dispatchEvent(pointer('pointermove', -99999)) })
    expect(panelWidth(getByTestId)).toBe('200px')
    act(() => { window.dispatchEvent(pointer('pointerup', 0)) })
  })

  it('arrow keys resize (side-aware) + persist; Home resets to default', () => {
    const { getByTestId } = render(<Host side="left" />)
    fireEvent.keyDown(getByTestId('grip'), { key: 'ArrowRight' })
    expect(getByTestId('w').textContent).toBe('248')
    expect(panelWidth(getByTestId)).toBe('248px')
    fireEvent.keyDown(getByTestId('grip'), { key: 'ArrowLeft', shiftKey: true })
    expect(getByTestId('w').textContent).toBe('224')
    fireEvent.keyDown(getByTestId('grip'), { key: 'Home' })
    expect(getByTestId('w').textContent).toBe('240')
    expect(localStorage.getItem(KEY)).toBe('240')
  })
})
