// ─── Mission split layout: a pure binary split tree ──────────────────────────
// The mission surface shows one or more missions side by side. Their
// arrangement is a binary tree: a leaf is one pane (the window's primary
// mission, `PRIMARY_PANE`, or a conversation id) and a split divides its box
// in two along a direction with the share of the first child as `ratio`.
//
// Everything here is pure and immutable: no React, DOM or storage. Rendering
// turns the tree into absolute rectangles (`paneRects`), so a change of
// arrangement never changes which React element hosts a pane.

export const PRIMARY_PANE = 'primary'

/** `row` places the children side by side (left | right); `column` stacks them (up / down). */
export type SplitDirection = 'row' | 'column'
/** Where a pane goes relative to another one. */
export type SplitSide = 'left' | 'right' | 'up' | 'down'
export interface SplitLeaf { readonly type: 'leaf'; readonly paneId: string }
export interface SplitBranch {
  readonly type: 'split'
  readonly direction: SplitDirection
  readonly first: SplitNode
  readonly second: SplitNode
  /** Share of the first child, 0–1 exclusive. */
  readonly ratio: number
}
export type SplitNode = SplitLeaf | SplitBranch
/** Route from the root to a node: 0 = first child, 1 = second child. */
export type SplitPath = readonly (0 | 1)[]
/** A rectangle in fractions of the layout box (0–1). */
export interface PaneRect { x: number; y: number; width: number; height: number }
export interface SplitSize { width: number; height: number }
export interface SplitDivider {
  path: SplitPath
  direction: SplitDirection
  /** The box of the split the divider resizes. */
  box: PaneRect
  ratio: number
}

/** A pane narrower or shorter than this stops being usable (composer, header, run strip). */
export const MIN_PANE_SIZE: SplitSize = Object.freeze({ width: 360, height: 240 })
/** Ratios never reach the edges, even in a stored tree that was edited by hand. */
const RATIO_FLOOR = 0.05
const EPSILON = 1e-6

export const leaf = (paneId: string): SplitLeaf => ({ type: 'leaf', paneId })
export const sideDirection = (side: SplitSide): SplitDirection => side === 'left' || side === 'right' ? 'row' : 'column'
/** The new pane is the first child for left / up. */
const sideIsFirst = (side: SplitSide): boolean => side === 'left' || side === 'up'
const clampUnit = (ratio: number): number => Math.min(1 - RATIO_FLOOR, Math.max(RATIO_FLOOR, ratio))
function branch(direction: SplitDirection, first: SplitNode, second: SplitNode, ratio: number): SplitBranch {
  return { type: 'split', direction, first, second, ratio: clampUnit(ratio) }
}

/** Pane ids in reading order (left to right, top to bottom within each split). */
export function splitLeaves(node: SplitNode | null): string[] {
  if (!node) return []
  if (node.type === 'leaf') return [node.paneId]
  return [...splitLeaves(node.first), ...splitLeaves(node.second)]
}

export function hasPane(node: SplitNode | null, paneId: string): boolean {
  return findPanePath(node, paneId) !== null
}

export function findPanePath(node: SplitNode | null, paneId: string): SplitPath | null {
  if (!node) return null
  if (node.type === 'leaf') return node.paneId === paneId ? [] : null
  const first = findPanePath(node.first, paneId)
  if (first) return [0, ...first]
  const second = findPanePath(node.second, paneId)
  return second ? [1, ...second] : null
}

export function nodeAt(node: SplitNode | null, path: SplitPath): SplitNode | null {
  let current: SplitNode | null = node
  for (const step of path) {
    if (!current || current.type !== 'split') return null
    current = step === 0 ? current.first : current.second
  }
  return current
}

function replaceAt(node: SplitNode, path: SplitPath, replace: (node: SplitNode) => SplitNode): SplitNode {
  if (path.length === 0) return replace(node)
  if (node.type !== 'split') return node
  const [step, ...rest] = path
  return step === 0
    ? { ...node, first: replaceAt(node.first, rest, replace) }
    : { ...node, second: replaceAt(node.second, rest, replace) }
}

/** Number of panes lined up along `direction` (the weight used to share space evenly). */
export function paneWeight(node: SplitNode, direction: SplitDirection): number {
  if (node.type === 'leaf') return 1
  const first = paneWeight(node.first, direction)
  const second = paneWeight(node.second, direction)
  return node.direction === direction ? first + second : Math.max(first, second)
}

/**
 * Put `newId` beside `targetId` on `side`, halving the target's box. A pane
 * already in the tree moves (it is never duplicated). A missing target splits
 * the whole layout instead.
 */
export function splitPane(tree: SplitNode | null, targetId: string, newId: string, side: SplitSide): SplitNode {
  if (targetId === newId) return tree ?? leaf(newId)
  const base = hasPane(tree, newId) ? removePane(tree, newId).tree : tree
  if (!base) return leaf(newId)
  const path = findPanePath(base, targetId)
  if (!path) return wrapRoot(base, newId, side)
  const direction = sideDirection(side)
  return replaceAt(base, path, (target) => sideIsFirst(side)
    ? branch(direction, leaf(newId), target, 0.5)
    : branch(direction, target, leaf(newId), 0.5))
}

/** Place `paneId` along one whole edge of the layout, sized like its new neighbours. */
export function addPaneAtEdge(tree: SplitNode | null, paneId: string, side: SplitSide): SplitNode {
  const base = hasPane(tree, paneId) ? removePane(tree, paneId).tree : tree
  return base ? wrapRoot(base, paneId, side) : leaf(paneId)
}

function wrapRoot(tree: SplitNode, paneId: string, side: SplitSide): SplitNode {
  const direction = sideDirection(side)
  const share = 1 / (paneWeight(tree, direction) + 1)
  return sideIsFirst(side)
    ? branch(direction, leaf(paneId), tree, share)
    : branch(direction, tree, leaf(paneId), 1 - share)
}

/**
 * Remove a pane; its sibling takes the parent's box. `focus` names the pane
 * that should take focus next: the nearest pane of that sibling.
 */
export function removePane(tree: SplitNode | null, paneId: string): { tree: SplitNode | null; focus: string | null } {
  const path = findPanePath(tree, paneId)
  if (!tree || !path) return { tree, focus: null }
  if (path.length === 0) return { tree: null, focus: null }
  const parentPath = path.slice(0, -1)
  const parent = nodeAt(tree, parentPath) as SplitBranch
  const removedFirst = path[path.length - 1] === 0
  const sibling = removedFirst ? parent.second : parent.first
  const siblingLeaves = splitLeaves(sibling)
  return {
    tree: replaceAt(tree, parentPath, () => sibling),
    focus: (removedFirst ? siblingLeaves[0] : siblingLeaves[siblingLeaves.length - 1]) ?? null,
  }
}

/** Move a pane beside another one. */
export function movePane(tree: SplitNode | null, paneId: string, targetId: string, side: SplitSide): SplitNode | null {
  if (!tree || paneId === targetId || !hasPane(tree, paneId) || !hasPane(tree, targetId)) return tree
  return splitPane(tree, targetId, paneId, side)
}

/** Replace one pane id by another in place (same box). Drops a second copy of `nextId`. */
export function replacePane(tree: SplitNode | null, paneId: string, nextId: string): SplitNode | null {
  if (!tree || paneId === nextId) return tree
  const path = findPanePath(tree, paneId)
  if (!path) return tree
  const base = hasPane(tree, nextId) ? removePane(tree, nextId).tree : tree
  const target = findPanePath(base, paneId)
  if (!base || !target) return base
  return replaceAt(base, target, () => leaf(nextId))
}

export function swapPanes(tree: SplitNode | null, a: string, b: string): SplitNode | null {
  if (!tree || a === b || !hasPane(tree, a) || !hasPane(tree, b)) return tree
  const swap = (node: SplitNode): SplitNode => node.type === 'leaf'
    ? node.paneId === a ? leaf(b) : node.paneId === b ? leaf(a) : node
    : { ...node, first: swap(node.first), second: swap(node.second) }
  return swap(tree)
}

/**
 * "Move left/right/up/down": beside the nearest pane on that side, or, with no
 * pane there, along that whole edge of the layout.
 */
export function movePaneInDirection(tree: SplitNode | null, paneId: string, side: SplitSide): SplitNode | null {
  if (!tree || !hasPane(tree, paneId) || tree.type === 'leaf') return tree
  const neighbor = neighborPane(tree, paneId, side)
  if (neighbor) return movePane(tree, paneId, neighbor, side)
  const rest = removePane(tree, paneId).tree
  return rest ? wrapRoot(rest, paneId, side) : tree
}

/** Set a split's ratio (already clamped by the caller when sizes matter). */
export function setRatioAt(tree: SplitNode | null, path: SplitPath, ratio: number): SplitNode | null {
  if (!tree || !Number.isFinite(ratio)) return tree
  const node = nodeAt(tree, path)
  if (!node || node.type !== 'split') return tree
  return replaceAt(tree, path, (target) => ({ ...(target as SplitBranch), ratio: clampUnit(ratio) }))
}

function equalizedRatio(node: SplitBranch): number {
  const first = paneWeight(node.first, node.direction)
  return first / (first + paneWeight(node.second, node.direction))
}

/** Share one split's space evenly between its panes. */
export function equalizeAt(tree: SplitNode | null, path: SplitPath): SplitNode | null {
  const node = nodeAt(tree, path)
  if (!tree || !node || node.type !== 'split') return tree
  return setRatioAt(tree, path, equalizedRatio(node))
}

/** Every pane gets the same share of its row or column. */
export function equalizeTree(tree: SplitNode | null): SplitNode | null {
  if (!tree || tree.type === 'leaf') return tree
  return { ...tree, ratio: equalizedRatio(tree), first: equalizeTree(tree.first)!, second: equalizeTree(tree.second)! }
}

const FULL: PaneRect = Object.freeze({ x: 0, y: 0, width: 1, height: 1 })
function childBoxes(node: SplitBranch, box: PaneRect): [PaneRect, PaneRect] {
  if (node.direction === 'row') {
    const width = box.width * node.ratio
    return [{ ...box, width }, { ...box, x: box.x + width, width: box.width - width }]
  }
  const height = box.height * node.ratio
  return [{ ...box, height }, { ...box, y: box.y + height, height: box.height - height }]
}

/** Each pane's box in fractions of the layout. */
export function paneRects(tree: SplitNode | null, box: PaneRect = FULL): Map<string, PaneRect> {
  const rects = new Map<string, PaneRect>()
  const walk = (node: SplitNode, current: PaneRect) => {
    if (node.type === 'leaf') { rects.set(node.paneId, current); return }
    const [first, second] = childBoxes(node, current)
    walk(node.first, first)
    walk(node.second, second)
  }
  if (tree) walk(tree, box)
  return rects
}

/** One divider per split, with the box it divides. */
export function splitDividers(tree: SplitNode | null): SplitDivider[] {
  const dividers: SplitDivider[] = []
  const walk = (node: SplitNode, box: PaneRect, path: (0 | 1)[]) => {
    if (node.type === 'leaf') return
    dividers.push({ path, direction: node.direction, box, ratio: node.ratio })
    const [first, second] = childBoxes(node, box)
    walk(node.first, first, [...path, 0])
    walk(node.second, second, [...path, 1])
  }
  if (tree) walk(tree, FULL, [])
  return dividers
}

/** The smallest box a subtree fits in with every pane at least `min`. */
export function minimumSize(node: SplitNode | null, min: SplitSize = MIN_PANE_SIZE): SplitSize {
  if (!node) return { width: 0, height: 0 }
  if (node.type === 'leaf') return { ...min }
  const first = minimumSize(node.first, min)
  const second = minimumSize(node.second, min)
  return node.direction === 'row'
    ? { width: first.width + second.width, height: Math.max(first.height, second.height) }
    : { width: Math.max(first.width, second.width), height: first.height + second.height }
}

export function fitsIn(tree: SplitNode | null, size: SplitSize, min: SplitSize = MIN_PANE_SIZE): boolean {
  const needed = minimumSize(tree, min)
  return needed.width <= size.width + EPSILON && needed.height <= size.height + EPSILON
}

/** The range a split's ratio may take so both sides keep their minimum size. */
export function ratioBounds(node: SplitBranch, boxPixels: SplitSize, min: SplitSize = MIN_PANE_SIZE): { min: number; max: number } {
  const along = node.direction === 'row' ? boxPixels.width : boxPixels.height
  const key = node.direction === 'row' ? 'width' : 'height'
  const first = minimumSize(node.first, min)[key]
  const second = minimumSize(node.second, min)[key]
  if (along <= 0 || first + second >= along) {
    // No room for both minimums: share what there is in proportion to them.
    const proportional = first / (first + second)
    return { min: proportional, max: proportional }
  }
  return { min: clampUnit(first / along), max: clampUnit(1 - second / along) }
}

export function clampRatio(node: SplitBranch, ratio: number, boxPixels: SplitSize, min: SplitSize = MIN_PANE_SIZE): number {
  const bounds = ratioBounds(node, boxPixels, min)
  return Math.min(bounds.max, Math.max(bounds.min, ratio))
}

/** Pull a ratio to one half when the divider is within `snapPixels` of the middle. */
export function snapRatio(ratio: number, alongPixels: number, snapPixels = 24, target = 0.5): number {
  return Math.abs(ratio - target) * alongPixels <= snapPixels ? target : ratio
}

/**
 * The tree as it is drawn in a box of `size` pixels: every ratio clamped so
 * each pane keeps its minimum size where the box allows it. The stored ratios
 * stay untouched, so widening the window again restores the chosen layout.
 */
export function fitTree(tree: SplitNode | null, size: SplitSize, min: SplitSize = MIN_PANE_SIZE): SplitNode | null {
  if (!tree || tree.type === 'leaf') return tree
  const walk = (node: SplitNode, box: SplitSize): SplitNode => {
    if (node.type === 'leaf') return node
    const ratio = clampRatio(node, node.ratio, box, min)
    const fitted = { ...node, ratio }
    const [first, second]: [SplitSize, SplitSize] = node.direction === 'row'
      ? [{ width: box.width * ratio, height: box.height }, { width: box.width * (1 - ratio), height: box.height }]
      : [{ width: box.width, height: box.height * ratio }, { width: box.width, height: box.height * (1 - ratio) }]
    return { ...fitted, first: walk(node.first, first), second: walk(node.second, second) }
  }
  return walk(tree, size)
}

/** The nearest pane on `side` of a pane, sharing part of the facing edge. */
export function neighborPane(tree: SplitNode | null, paneId: string, side: SplitSide): string | null {
  const rects = paneRects(tree)
  const me = rects.get(paneId)
  if (!me) return null
  const horizontal = side === 'left' || side === 'right'
  let best: { id: string; distance: number; overlap: number; offset: number } | null = null
  for (const [id, rect] of rects) {
    if (id === paneId) continue
    const before = side === 'left' ? rect.x + rect.width <= me.x + EPSILON : side === 'up' ? rect.y + rect.height <= me.y + EPSILON : false
    const after = side === 'right' ? rect.x >= me.x + me.width - EPSILON : side === 'down' ? rect.y >= me.y + me.height - EPSILON : false
    if (!before && !after) continue
    const [start, end, myStart, myEnd] = horizontal
      ? [rect.y, rect.y + rect.height, me.y, me.y + me.height]
      : [rect.x, rect.x + rect.width, me.x, me.x + me.width]
    const overlap = Math.min(end, myEnd) - Math.max(start, myStart)
    if (overlap <= EPSILON) continue
    const distance = side === 'left' ? me.x - (rect.x + rect.width)
      : side === 'right' ? rect.x - (me.x + me.width)
        : side === 'up' ? me.y - (rect.y + rect.height) : rect.y - (me.y + me.height)
    const offset = Math.abs((start + end) / 2 - (myStart + myEnd) / 2)
    const better = !best || distance < best.distance - EPSILON
      || (Math.abs(distance - best.distance) <= EPSILON && (overlap > best.overlap + EPSILON
        || (Math.abs(overlap - best.overlap) <= EPSILON && offset < best.offset - EPSILON)))
    if (better) best = { id, distance, overlap, offset }
  }
  return best?.id ?? null
}

/** Same arrangement of the same panes, ignoring ratios. */
export function sameShape(a: SplitNode | null, b: SplitNode | null): boolean {
  if (!a || !b) return a === b
  if (a.type === 'leaf' || b.type === 'leaf') return a.type === b.type && (a as SplitLeaf).paneId === (b as SplitLeaf).paneId
  return a.direction === b.direction && sameShape(a.first, b.first) && sameShape(a.second, b.second)
}

/** Drop every pane `keep` rejects, collapsing their splits. */
export function pruneTree(tree: SplitNode | null, keep: (paneId: string) => boolean): SplitNode | null {
  let next = tree
  for (const id of splitLeaves(tree)) if (!keep(id)) next = removePane(next, id).tree
  return next
}

const MAX_DEPTH = 24
const MAX_ID_LENGTH = 200
/**
 * A stored tree, validated: unknown shapes, bad ratios and duplicate panes are
 * repaired or dropped rather than trusted.
 */
export function parseSplitTree(value: unknown): SplitNode | null {
  const seen = new Set<string>()
  const read = (input: unknown, depth: number): SplitNode | null => {
    if (!input || typeof input !== 'object' || depth > MAX_DEPTH) return null
    const node = input as Record<string, unknown>
    if (node.type === 'leaf') {
      const id = node.paneId
      if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH || seen.has(id)) return null
      seen.add(id)
      return leaf(id)
    }
    if (node.type !== 'split' || (node.direction !== 'row' && node.direction !== 'column')) return null
    const first = read(node.first, depth + 1)
    const second = read(node.second, depth + 1)
    if (!first || !second) return first ?? second
    const ratio = typeof node.ratio === 'number' && Number.isFinite(node.ratio) ? node.ratio : 0.5
    return branch(node.direction, first, second, ratio)
  }
  return read(value, 0)
}
