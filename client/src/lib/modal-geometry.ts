/**
 * Pure geometry helpers for movable + resizable modals.
 *
 * All functions here are side-effect free and DOM-free so they can be unit
 * tested in isolation. `useMovableResizableModal` wires them to pointer/keyboard
 * events and React state.
 *
 * Coordinate system: `x`/`y` are the panel's top-left corner in viewport
 * (`position: fixed`) pixels; `w`/`h` are its width/height.
 */

export interface ModalGeometry {
  x: number
  y: number
  w: number
  h: number
}

export type GripPosition = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** All eight grips in DOM/visual order (corners + edges). */
export const GRIP_POSITIONS: GripPosition[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export interface Viewport {
  width: number
  height: number
}

export interface SizeBounds {
  minWidth: number
  minHeight: number
}

/** Gap kept between the panel's max size and the viewport edge. */
export const VIEWPORT_MARGIN = 16
/** Minimum header height kept on-screen by the off-screen-jail guard. */
export const HEADER_MIN_VISIBLE_H = 48
/** Minimum header width (incl. close button) kept on-screen. */
export const HEADER_MIN_VISIBLE_W = 120

/** Which edges a given grip moves. */
const GRIP_EDGES: Record<GripPosition, { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }> = {
  nw: { left: true, top: true },
  n: { top: true },
  ne: { right: true, top: true },
  e: { right: true },
  se: { right: true, bottom: true },
  s: { bottom: true },
  sw: { left: true, bottom: true },
  w: { left: true },
}

export function gripEdges(position: GripPosition) {
  return GRIP_EDGES[position]
}

/** ARIA orientation for a grip: corners + horizontal edges resize width
 *  (vertical separator), top/bottom edges resize height (horizontal). */
export function gripAriaOrientation(position: GripPosition): 'horizontal' | 'vertical' {
  return position === 'n' || position === 's' ? 'horizontal' : 'vertical'
}

function clamp(value: number, lo: number, hi: number): number {
  const high = Math.max(lo, hi)
  return Math.min(Math.max(value, lo), high)
}

/** Clamp a width/height pair to `[min, viewport − margin]`. */
export function clampSize(w: number, h: number, vp: Viewport, bounds: SizeBounds): { w: number; h: number } {
  return {
    w: clamp(w, bounds.minWidth, vp.width - VIEWPORT_MARGIN),
    h: clamp(h, bounds.minHeight, vp.height - VIEWPORT_MARGIN),
  }
}

/**
 * Off-screen-jail guard: clamp `x`/`y` so the panel's header band stays
 * reachable — the entire right edge (where the close button lives) on-screen
 * horizontally, and the top of the header on-screen vertically with at least
 * `HEADER_MIN_VISIBLE_H` px showing.
 */
export function clampPosition(g: ModalGeometry, vp: Viewport): ModalGeometry {
  const x = clamp(g.x, HEADER_MIN_VISIBLE_W - g.w, vp.width - g.w)
  const y = clamp(g.y, 0, Math.max(0, vp.height - HEADER_MIN_VISIBLE_H))
  return { ...g, x, y }
}

/** Apply a move delta to a geometry, clamped on-screen. */
export function computeMove(startGeom: ModalGeometry, dx: number, dy: number, vp: Viewport): ModalGeometry {
  return clampPosition({ ...startGeom, x: startGeom.x + dx, y: startGeom.y + dy }, vp)
}

/**
 * Apply a resize delta from a grip. Right/bottom edges grow with the pointer;
 * left/top edges shrink it while shifting `x`/`y` so the opposite edge stays
 * anchored. Result is size- and position-clamped.
 */
export function computeResize(
  startGeom: ModalGeometry,
  position: GripPosition,
  dx: number,
  dy: number,
  vp: Viewport,
  bounds: SizeBounds,
): ModalGeometry {
  const edges = GRIP_EDGES[position]
  const right = startGeom.x + startGeom.w
  const bottom = startGeom.y + startGeom.h
  let w = startGeom.w
  let h = startGeom.h
  if (edges.right) w = startGeom.w + dx
  if (edges.left) w = startGeom.w - dx
  if (edges.bottom) h = startGeom.h + dy
  if (edges.top) h = startGeom.h - dy
  const sized = clampSize(w, h, vp, bounds)
  let x = startGeom.x
  let y = startGeom.y
  if (edges.left) x = right - sized.w
  if (edges.top) y = bottom - sized.h
  return clampPosition({ x, y, w: sized.w, h: sized.h }, vp)
}

/** Resize a grip's controlled dimension(s) to their min or max extent. */
export function computeResizeExtreme(
  startGeom: ModalGeometry,
  position: GripPosition,
  extreme: 'min' | 'max',
  vp: Viewport,
  bounds: SizeBounds,
): ModalGeometry {
  const edges = GRIP_EDGES[position]
  const horizontal = edges.left || edges.right
  const vertical = edges.top || edges.bottom
  const targetW = horizontal ? (extreme === 'min' ? bounds.minWidth : vp.width - VIEWPORT_MARGIN) : startGeom.w
  const targetH = vertical ? (extreme === 'min' ? bounds.minHeight : vp.height - VIEWPORT_MARGIN) : startGeom.h
  const right = startGeom.x + startGeom.w
  const bottom = startGeom.y + startGeom.h
  const sized = clampSize(targetW, targetH, vp, bounds)
  const x = edges.left ? right - sized.w : startGeom.x
  const y = edges.top ? bottom - sized.h : startGeom.y
  return clampPosition({ x, y, w: sized.w, h: sized.h }, vp)
}

/** Seed geometry from a panel's live bounding rect (used for grip overlay placement). */
export function seedFromRect(rect: { left: number; top: number; width: number; height: number }): ModalGeometry {
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
}

/**
 * Seed the INITIAL floating geometry by centering the measured size in the
 * viewport, rather than trusting the rect's `left`/`top`. A centered modal's
 * `getBoundingClientRect().left/top` can be skewed mid-entry-animation (Radix
 * applies a `translate`/`zoom` transform), which would otherwise jam the panel
 * into the top-left corner the instant it floats. Centering by size is stable.
 */
export function centerGeom(rect: { width: number; height: number }, vp: Viewport): ModalGeometry {
  return {
    w: rect.width,
    h: rect.height,
    x: Math.round((vp.width - rect.width) / 2),
    y: Math.round((vp.height - rect.height) / 2),
  }
}

/** Corner grip hit-box size (px). */
export const GRIP_CORNER = 14
/** Edge grip thickness (px). */
export const GRIP_EDGE = 8
/** Inset of an edge grip from the corners (px). */
export const GRIP_INSET = 12

/**
 * Fixed-position placement for a grip straddling the panel edge described by
 * `rect`. Used to render grips as a viewport-fixed overlay independent of the
 * modal's internal layout/scroll.
 */
export function gripStyle(
  position: GripPosition,
  rect: ModalGeometry,
): { left: number; top: number; width: number; height: number } {
  const { x, y, w, h } = rect
  const c = GRIP_CORNER
  const e = GRIP_EDGE
  const inset = GRIP_INSET
  const edgeW = Math.max(0, w - inset * 2)
  const edgeH = Math.max(0, h - inset * 2)
  switch (position) {
    case 'nw': return { left: x - c / 2, top: y - c / 2, width: c, height: c }
    case 'ne': return { left: x + w - c / 2, top: y - c / 2, width: c, height: c }
    case 'se': return { left: x + w - c / 2, top: y + h - c / 2, width: c, height: c }
    case 'sw': return { left: x - c / 2, top: y + h - c / 2, width: c, height: c }
    case 'n': return { left: x + inset, top: y - e / 2, width: edgeW, height: e }
    case 's': return { left: x + inset, top: y + h - e / 2, width: edgeW, height: e }
    case 'e': return { left: x + w - e / 2, top: y + inset, width: e, height: edgeH }
    case 'w': return { left: x - e / 2, top: y + inset, width: e, height: edgeH }
  }
}

/** Map an arrow key + grip into a screen-space pointer delta (keyboard resize). */
export function arrowDelta(position: GripPosition, key: string, step: number): { dx: number; dy: number } | null {
  const edges = GRIP_EDGES[position]
  const horizontal = edges.left || edges.right
  const vertical = edges.top || edges.bottom
  switch (key) {
    case 'ArrowRight':
      return horizontal ? { dx: step, dy: 0 } : null
    case 'ArrowLeft':
      return horizontal ? { dx: -step, dy: 0 } : null
    case 'ArrowDown':
      return vertical ? { dx: 0, dy: step } : null
    case 'ArrowUp':
      return vertical ? { dx: 0, dy: -step } : null
    default:
      return null
  }
}
