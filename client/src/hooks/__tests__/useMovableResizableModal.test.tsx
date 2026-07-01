import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useMovableResizableModal, type UseMovableResizableModalOptions } from '../useMovableResizableModal'
import { ResizeGrips } from '../../components/ui/ResizeGrips'

const PANEL_RECT = { left: 100, top: 100, width: 400, height: 300, right: 500, bottom: 400, x: 100, y: 100, toJSON: () => ({}) }

function setViewport(width: number, height = 800) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width, writable: true })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height, writable: true })
  act(() => { window.dispatchEvent(new Event('resize')) })
}

function Harness(props: UseMovableResizableModalOptions & { onClose?: () => void }) {
  const { onClose, ...opts } = props
  const m = useMovableResizableModal(opts)
  // headerHandleProps spread on the whole panel (the DialogContent pattern): the
  // hook itself band-limits the move surface to the top of the panel.
  return (
    <div>
      <div data-testid="panel" ref={m.panelRef} style={m.panelStyle} {...m.headerHandleProps}>
        <div data-testid="header">Title <button data-testid="header-button">x</button></div>
        <div data-testid="body" style={{ height: 200 }}>body content</div>
      </div>
      <ResizeGrips handles={m.resizeHandles} />
      <div data-testid="backdrop" onClick={m.guardBackdrop(onClose ?? (() => {}))} />
      <button data-testid="reset" onClick={m.reset}>reset</button>
      <span data-testid="floating">{String(m.isFloating)}</span>
      <span data-testid="enabled">{String(m.enabled)}</span>
    </div>
  )
}

function pointerMove(clientX: number, clientY: number) {
  act(() => {
    const e = new MouseEvent('pointermove', { clientX, clientY, bubbles: true })
    window.dispatchEvent(e)
  })
}
function pointerUp() {
  act(() => { window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })) })
}

const panelStyle = () => (screen.getByTestId('panel') as HTMLElement).style

describe('useMovableResizableModal', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(PANEL_RECT as DOMRect)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
    setViewport(1400)
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('default state applies no inline geometry and is not floating', () => {
    render(<Harness />)
    expect(screen.getByTestId('floating').textContent).toBe('false')
    expect(panelStyle().position).toBe('')
    expect(panelStyle().left).toBe('')
  })

  it('renders all eight grips when enabled (measured from the panel)', () => {
    render(<Harness />)
    for (const pos of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      expect(screen.getByTestId(`modal-resize-${pos}`)).toBeTruthy()
    }
  })

  it('disables below the viewport gate (no grips, empty style)', () => {
    render(<Harness />)
    setViewport(800)
    expect(screen.getByTestId('enabled').textContent).toBe('false')
    expect(screen.queryByTestId('modal-resize-se')).toBeNull()
    expect(panelStyle().position).toBe('')
  })

  it('moving from the top band makes the panel float with fixed positioning', () => {
    render(<Harness />)
    fireEvent.pointerDown(screen.getByTestId('header'), { button: 0, pointerId: 1, clientX: 130, clientY: 130 })
    pointerMove(190, 170)
    pointerUp()
    expect(screen.getByTestId('floating').textContent).toBe('true')
    expect(panelStyle().position).toBe('fixed')
    // Seed is CENTERED by size (vp 1400x800, panel 400x300) → x=500, y=250.
    // Then move delta (190-130, 170-130) = (60, 40) → 560, 290.
    expect(panelStyle().left).toBe('560px')
    expect(panelStyle().top).toBe('290px')
  })

  it('anchorFromCurrentRect seeds from the panel rect instead of centering', () => {
    render(<Harness anchorFromCurrentRect />)
    fireEvent.pointerDown(screen.getByTestId('header'), { button: 0, pointerId: 1, clientX: 130, clientY: 130 })
    pointerMove(190, 170) // delta 60,40
    pointerUp()
    // Seed from rect (100,100) + delta (60,40) = (160,140) — NOT centered (500,250).
    expect(panelStyle().left).toBe('160px')
    expect(panelStyle().top).toBe('140px')
  })

  it('persistKey restores geometry on mount and saves it after a drag', () => {
    localStorage.setItem('agent-geom', JSON.stringify({ x: 200, y: 150, w: 400, h: 300 }))
    render(<Harness persistKey="agent-geom" />)
    expect(panelStyle().position).toBe('fixed')
    expect(panelStyle().left).toBe('200px')
    cleanup()

    localStorage.removeItem('agent-geom')
    render(<Harness persistKey="agent-geom" anchorFromCurrentRect />)
    fireEvent.pointerDown(screen.getByTestId('header'), { button: 0, pointerId: 2, clientX: 130, clientY: 130 })
    pointerMove(190, 170)
    pointerUp()
    const saved = JSON.parse(localStorage.getItem('agent-geom') as string)
    expect(saved.x).toBe(160)
    expect(saved.y).toBe(140)
  })

  it('a click with no movement keeps the modal centered (no top-left jump)', () => {
    render(<Harness />)
    fireEvent.pointerDown(screen.getByTestId('header'), { button: 0, pointerId: 5, clientX: 130, clientY: 130 })
    pointerUp()
    // Floats in place at the centered seed — never the corner.
    expect(panelStyle().left).toBe('500px') // (1400-400)/2
    expect(panelStyle().top).toBe('250px') // (800-300)/2
  })

  it('does NOT move when the drag starts in the body (below the top band)', () => {
    render(<Harness />)
    // panel rect top=100, band=64 → clientY 300 is well below it.
    fireEvent.pointerDown(screen.getByTestId('body'), { button: 0, pointerId: 7, clientX: 200, clientY: 300 })
    pointerMove(260, 360)
    pointerUp()
    expect(screen.getByTestId('floating').textContent).toBe('false')
  })

  it('does not move from the header when allowMove is false (resize-only)', () => {
    render(<Harness allowMove={false} />)
    fireEvent.pointerDown(screen.getByTestId('header'), { button: 0, pointerId: 1, clientX: 130, clientY: 130 })
    pointerMove(190, 170)
    pointerUp()
    expect(screen.getByTestId('floating').textContent).toBe('false')
  })

  it('ignores header drags that start on an interactive element', () => {
    render(<Harness />)
    fireEvent.pointerDown(screen.getByTestId('header-button'), { button: 0, pointerId: 1, clientX: 130, clientY: 130 })
    pointerMove(190, 170)
    pointerUp()
    expect(screen.getByTestId('floating').textContent).toBe('false')
  })

  it('resizing from a corner grip changes the panel size', () => {
    render(<Harness />)
    fireEvent.pointerDown(screen.getByTestId('modal-resize-se'), { button: 0, pointerId: 2, clientX: 500, clientY: 400 })
    pointerMove(560, 460)
    pointerUp()
    expect(panelStyle().width).toBe('460px') // 400 + 60
    expect(panelStyle().height).toBe('360px') // 300 + 60
  })

  it('keyboard ArrowRight on the east grip grows the width by the step', () => {
    render(<Harness />)
    fireEvent.keyDown(screen.getByTestId('modal-resize-e'), { key: 'ArrowRight' })
    expect(panelStyle().width).toBe('416px') // 400 + 16
  })

  it('keyboard Shift+ArrowRight grows by the large step', () => {
    render(<Harness />)
    fireEvent.keyDown(screen.getByTestId('modal-resize-e'), { key: 'ArrowRight', shiftKey: true })
    expect(panelStyle().width).toBe('464px') // 400 + 64
  })

  it('keyboard "0" resets a floated modal back to centered', () => {
    render(<Harness />)
    fireEvent.keyDown(screen.getByTestId('modal-resize-e'), { key: 'ArrowRight' })
    expect(screen.getByTestId('floating').textContent).toBe('true')
    fireEvent.keyDown(screen.getByTestId('modal-resize-e'), { key: '0' })
    expect(screen.getByTestId('floating').textContent).toBe('false')
    expect(panelStyle().position).toBe('')
  })

  it('reset() returns to the centered default', () => {
    render(<Harness />)
    fireEvent.pointerDown(screen.getByTestId('header'), { button: 0, pointerId: 1, clientX: 130, clientY: 130 })
    pointerMove(190, 170)
    pointerUp()
    expect(screen.getByTestId('floating').textContent).toBe('true')
    fireEvent.click(screen.getByTestId('reset'))
    expect(screen.getByTestId('floating').textContent).toBe('false')
  })

  it('does not persist geometry across remounts (fresh centered every open)', () => {
    const { unmount } = render(<Harness />)
    fireEvent.pointerDown(screen.getByTestId('header'), { button: 0, pointerId: 1, clientX: 130, clientY: 130 })
    pointerMove(190, 170)
    pointerUp()
    expect(screen.getByTestId('floating').textContent).toBe('true')
    unmount()
    render(<Harness />)
    expect(screen.getByTestId('floating').textContent).toBe('false')
  })

  it('guardBackdrop suppresses the click that ends a drag, but allows a clean click', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    // Clean click → closes.
    fireEvent.click(screen.getByTestId('backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
    // A click immediately after a drag is suppressed.
    fireEvent.pointerDown(screen.getByTestId('header'), { button: 0, pointerId: 1, clientX: 130, clientY: 130 })
    pointerMove(190, 170)
    pointerUp()
    fireEvent.click(screen.getByTestId('backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1) // still 1 — suppressed
  })

  it('does not float when fully disabled via the enabled option', () => {
    render(<Harness enabled={false} />)
    expect(screen.getByTestId('enabled').textContent).toBe('false')
    expect(screen.queryByTestId('modal-resize-se')).toBeNull()
    fireEvent.pointerDown(screen.getByTestId('header'), { button: 0, pointerId: 1, clientX: 130, clientY: 130 })
    pointerMove(190, 170)
    pointerUp()
    expect(screen.getByTestId('floating').textContent).toBe('false')
  })
})
