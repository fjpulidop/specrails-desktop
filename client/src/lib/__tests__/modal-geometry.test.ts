import { describe, it, expect } from 'vitest'
import {
  GRIP_POSITIONS,
  VIEWPORT_MARGIN,
  HEADER_MIN_VISIBLE_H,
  HEADER_MIN_VISIBLE_W,
  GRIP_CORNER,
  GRIP_EDGE,
  GRIP_INSET,
  gripEdges,
  gripAriaOrientation,
  gripStyle,
  clampSize,
  clampPosition,
  computeMove,
  computeResize,
  computeResizeExtreme,
  seedFromRect,
  centerGeom,
  arrowDelta,
  type ModalGeometry,
} from '../modal-geometry'

const VP = { width: 1000, height: 800 }
const BOUNDS = { minWidth: 320, minHeight: 200 }
const G: ModalGeometry = { x: 100, y: 100, w: 400, h: 300 }

describe('modal-geometry', () => {
  it('exposes all eight grips', () => {
    expect(GRIP_POSITIONS).toHaveLength(8)
    expect(new Set(GRIP_POSITIONS).size).toBe(8)
  })

  describe('gripEdges', () => {
    it('maps corners to two edges and edges to one', () => {
      expect(gripEdges('nw')).toEqual({ left: true, top: true })
      expect(gripEdges('se')).toEqual({ right: true, bottom: true })
      expect(gripEdges('e')).toEqual({ right: true })
      expect(gripEdges('n')).toEqual({ top: true })
    })
  })

  describe('gripAriaOrientation', () => {
    it('top/bottom edges are horizontal separators, the rest vertical', () => {
      expect(gripAriaOrientation('n')).toBe('horizontal')
      expect(gripAriaOrientation('s')).toBe('horizontal')
      expect(gripAriaOrientation('e')).toBe('vertical')
      expect(gripAriaOrientation('nw')).toBe('vertical')
    })
  })

  describe('clampSize', () => {
    it('passes through values within bounds', () => {
      expect(clampSize(500, 400, VP, BOUNDS)).toEqual({ w: 500, h: 400 })
    })
    it('clamps up to the minimums', () => {
      expect(clampSize(100, 50, VP, BOUNDS)).toEqual({ w: 320, h: 200 })
    })
    it('clamps down to viewport minus margin', () => {
      expect(clampSize(5000, 5000, VP, BOUNDS)).toEqual({
        w: VP.width - VIEWPORT_MARGIN,
        h: VP.height - VIEWPORT_MARGIN,
      })
    })
  })

  describe('clampPosition (off-screen-jail guard)', () => {
    it('leaves an on-screen geometry untouched', () => {
      expect(clampPosition({ x: 400, y: 300, w: 500, h: 400 }, VP)).toEqual({ x: 400, y: 300, w: 500, h: 400 })
    })
    it('keeps the right edge on-screen and the header top visible', () => {
      const out = clampPosition({ x: 900, y: -50, w: 500, h: 400 }, VP)
      expect(out.x).toBe(VP.width - 500) // right edge pinned on-screen
      expect(out.y).toBe(0) // header top never above the viewport
    })
    it('keeps at least HEADER_MIN_VISIBLE_W reachable when dragged far left', () => {
      const out = clampPosition({ x: -10000, y: 100, w: 500, h: 400 }, VP)
      expect(out.x).toBe(HEADER_MIN_VISIBLE_W - 500)
    })
    it('keeps HEADER_MIN_VISIBLE_H of header visible at the bottom', () => {
      const out = clampPosition({ x: 100, y: 10000, w: 400, h: 300 }, VP)
      expect(out.y).toBe(VP.height - HEADER_MIN_VISIBLE_H)
    })
  })

  describe('computeMove', () => {
    it('applies the delta within bounds', () => {
      expect(computeMove(G, 50, 30, VP)).toMatchObject({ x: 150, y: 130, w: 400, h: 300 })
    })
    it('clamps a runaway move on-screen', () => {
      expect(computeMove(G, 5000, 0, VP).x).toBe(VP.width - G.w)
    })
  })

  describe('computeResize', () => {
    it('right edge grows width, anchors left/top', () => {
      expect(computeResize(G, 'e', 50, 0, VP, BOUNDS)).toMatchObject({ x: 100, y: 100, w: 450, h: 300 })
    })
    it('left edge shrinks width while anchoring the right edge', () => {
      expect(computeResize(G, 'w', 50, 0, VP, BOUNDS)).toMatchObject({ x: 150, y: 100, w: 350, h: 300 })
    })
    it('bottom edge grows height', () => {
      expect(computeResize(G, 's', 0, 50, VP, BOUNDS)).toMatchObject({ h: 350, y: 100 })
    })
    it('top edge shrinks height while anchoring the bottom edge', () => {
      expect(computeResize(G, 'n', 0, 50, VP, BOUNDS)).toMatchObject({ y: 150, h: 250 })
    })
    it('corner resizes two dimensions', () => {
      expect(computeResize(G, 'se', 50, 60, VP, BOUNDS)).toMatchObject({ w: 450, h: 360 })
      expect(computeResize(G, 'nw', 50, 60, VP, BOUNDS)).toMatchObject({ x: 150, y: 160, w: 350, h: 240 })
    })
    it('clamps width to the minimum on an over-shrink', () => {
      const out = computeResize(G, 'w', 10000, 0, VP, BOUNDS)
      expect(out.w).toBe(BOUNDS.minWidth)
      expect(out.x).toBe(G.x + G.w - BOUNDS.minWidth)
    })
  })

  describe('computeResizeExtreme', () => {
    it('Home shrinks the controlled dimension to its minimum', () => {
      expect(computeResizeExtreme(G, 'e', 'min', VP, BOUNDS)).toMatchObject({ w: BOUNDS.minWidth, x: 100 })
    })
    it('End grows height to viewport max and re-clamps position', () => {
      const out = computeResizeExtreme(G, 'n', 'max', VP, BOUNDS)
      expect(out.h).toBe(VP.height - VIEWPORT_MARGIN)
      expect(out.y).toBe(0)
    })
    it('leaves the uncontrolled axis unchanged', () => {
      const out = computeResizeExtreme(G, 'e', 'max', VP, BOUNDS)
      expect(out.h).toBe(G.h)
    })
  })

  describe('seedFromRect', () => {
    it('maps a DOMRect-like to geometry', () => {
      expect(seedFromRect({ left: 10, top: 20, width: 30, height: 40 })).toEqual({ x: 10, y: 20, w: 30, h: 40 })
    })
  })

  describe('centerGeom', () => {
    it('centers the measured size in the viewport regardless of rect position', () => {
      expect(centerGeom({ width: 400, height: 300 }, VP)).toEqual({ x: 300, y: 250, w: 400, h: 300 })
    })
    it('rounds to whole pixels', () => {
      expect(centerGeom({ width: 401, height: 301 }, VP)).toEqual({ x: 300, y: 250, w: 401, h: 301 })
    })
  })

  describe('arrowDelta', () => {
    it('maps horizontal arrows for width-controlling grips', () => {
      expect(arrowDelta('e', 'ArrowRight', 16)).toEqual({ dx: 16, dy: 0 })
      expect(arrowDelta('e', 'ArrowLeft', 16)).toEqual({ dx: -16, dy: 0 })
      expect(arrowDelta('e', 'ArrowUp', 16)).toBeNull()
    })
    it('maps vertical arrows for height-controlling grips', () => {
      expect(arrowDelta('s', 'ArrowDown', 16)).toEqual({ dx: 0, dy: 16 })
      expect(arrowDelta('s', 'ArrowRight', 16)).toBeNull()
    })
    it('corners accept both axes', () => {
      expect(arrowDelta('se', 'ArrowRight', 8)).toEqual({ dx: 8, dy: 0 })
      expect(arrowDelta('se', 'ArrowDown', 8)).toEqual({ dx: 0, dy: 8 })
    })
    it('ignores non-arrow keys', () => {
      expect(arrowDelta('e', 'Home', 16)).toBeNull()
    })
  })

  describe('gripStyle', () => {
    const rect: ModalGeometry = { x: 100, y: 200, w: 400, h: 300 }
    it('places corners straddling the edge', () => {
      expect(gripStyle('nw', rect)).toEqual({ left: 100 - GRIP_CORNER / 2, top: 200 - GRIP_CORNER / 2, width: GRIP_CORNER, height: GRIP_CORNER })
      expect(gripStyle('se', rect)).toEqual({ left: 500 - GRIP_CORNER / 2, top: 500 - GRIP_CORNER / 2, width: GRIP_CORNER, height: GRIP_CORNER })
    })
    it('places horizontal edges inset from corners', () => {
      expect(gripStyle('n', rect)).toEqual({ left: 100 + GRIP_INSET, top: 200 - GRIP_EDGE / 2, width: 400 - GRIP_INSET * 2, height: GRIP_EDGE })
    })
    it('places vertical edges inset from corners', () => {
      expect(gripStyle('e', rect)).toEqual({ left: 500 - GRIP_EDGE / 2, top: 200 + GRIP_INSET, width: GRIP_EDGE, height: 300 - GRIP_INSET * 2 })
    })
    it('never produces a negative edge length for a tiny panel', () => {
      const tiny: ModalGeometry = { x: 0, y: 0, w: 10, h: 10 }
      expect(gripStyle('n', tiny).width).toBe(0)
      expect(gripStyle('e', tiny).height).toBe(0)
    })
  })
})
