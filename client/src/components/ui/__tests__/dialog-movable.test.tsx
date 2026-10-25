import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Dialog, DialogContent, DialogTitle } from '../dialog'

const PANEL_RECT = { left: 100, top: 100, width: 400, height: 300, right: 500, bottom: 400, x: 100, y: 100, toJSON: () => ({}) }

describe('DialogContent movableResizable', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(PANEL_RECT as DOMRect)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400, writable: true })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900, writable: true })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('default (opt-out) renders the content with NO resize grips', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Plain</DialogTitle>
          <p>body</p>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByText('body')).toBeTruthy()
    expect(screen.queryByTestId('modal-resize-se')).toBeNull()
  })

  it('movableResizable renders the eight grips INSIDE the workspace panel', () => {
    render(
      <Dialog open>
        <DialogContent size="workspace" movableResizable>
          <DialogTitle>Floating</DialogTitle>
          <p>body</p>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByText('body')).toBeTruthy()
    const panel = screen.getByRole('dialog')
    for (const pos of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const grip = screen.getByTestId(`modal-resize-${pos}`)
      // Inside the panel: same stacking context (above its scrim) and the
      // same focus scope (keyboard resize reachable).
      expect(panel.contains(grip)).toBe(true)
      expect(grip.style.position).toBe('absolute')
    }
  })

  it('ignores movableResizable on non-workspace sizes (confirms and forms stay fixed)', () => {
    render(
      <Dialog open>
        <DialogContent size="confirm" movableResizable>
          <DialogTitle>Confirm</DialogTitle>
          <p>confirm body</p>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByText('confirm body')).toBeTruthy()
    expect(screen.queryByTestId('modal-resize-se')).toBeNull()
  })

  it('does not render grips below the viewport gate', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800, writable: true })
    render(
      <Dialog open>
        <DialogContent size="workspace" movableResizable>
          <DialogTitle>Narrow</DialogTitle>
          <p>narrow body</p>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByText('narrow body')).toBeTruthy()
    expect(screen.queryByTestId('modal-resize-se')).toBeNull()
  })
})
