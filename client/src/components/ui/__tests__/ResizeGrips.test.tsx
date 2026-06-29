import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ResizeGrips } from '../ResizeGrips'
import { GRIP_POSITIONS, gripAriaOrientation } from '../../../lib/modal-geometry'
import type { ResizeHandleProps } from '../../../hooks/useMovableResizableModal'

const handles = (): ResizeHandleProps[] =>
  GRIP_POSITIONS.map((position) => ({
    position,
    role: 'separator' as const,
    'aria-orientation': gripAriaOrientation(position),
    tabIndex: 0 as const,
    style: { position: 'fixed', left: 0, top: 0, width: 10, height: 10 },
    onPointerDown: () => {},
    onKeyDown: () => {},
  }))

describe('ResizeGrips', () => {
  afterEach(cleanup)

  it('renders nothing when there are no handles', () => {
    const { container } = render(<ResizeGrips handles={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders eight separator grips with aria labels and fixed positioning', () => {
    render(<ResizeGrips handles={handles()} />)
    for (const pos of GRIP_POSITIONS) {
      const grip = screen.getByTestId(`modal-resize-${pos}`)
      expect(grip.getAttribute('role')).toBe('separator')
      expect(grip.getAttribute('aria-label')).toBeTruthy()
      expect(grip.style.position).toBe('fixed')
    }
  })

  it('sets aria-orientation per grip axis', () => {
    render(<ResizeGrips handles={handles()} />)
    expect(screen.getByTestId('modal-resize-n').getAttribute('aria-orientation')).toBe('horizontal')
    expect(screen.getByTestId('modal-resize-e').getAttribute('aria-orientation')).toBe('vertical')
  })
})
