import { describe, expect, it } from 'vitest'
import {
  clampRatio, equalizeAt, equalizeTree, findPanePath, fitTree, fitsIn, leaf, minimumSize, movePane, movePaneInDirection,
  neighborPane, nodeAt, paneRects, paneWeight, parseSplitTree, pruneTree, ratioBounds, removePane, replacePane, sameShape,
  setRatioAt, snapRatio, splitDividers, splitLeaves, splitPane, swapPanes, PRIMARY_PANE,
  type SplitBranch, type SplitNode,
} from '../mission-split-tree'

const row = (first: SplitNode, second: SplitNode, ratio = 0.5): SplitNode => ({ type: 'split', direction: 'row', first, second, ratio })
const column = (first: SplitNode, second: SplitNode, ratio = 0.5): SplitNode => ({ type: 'split', direction: 'column', first, second, ratio })
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(leaf)

describe('splitPane', () => {
  it('splits the target on each side, halving its box', () => {
    expect(splitPane(A, 'a', 'b', 'right')).toEqual(row(A, B))
    expect(splitPane(A, 'a', 'b', 'left')).toEqual(row(B, A))
    expect(splitPane(A, 'a', 'b', 'down')).toEqual(column(A, B))
    expect(splitPane(A, 'a', 'b', 'up')).toEqual(column(B, A))
  })
  it('splits a nested leaf in place and leaves the rest untouched', () => {
    expect(splitPane(row(A, B, 0.3), 'b', 'c', 'down')).toEqual(row(A, column(B, C), 0.3))
  })
  it('moves a pane already in the tree instead of duplicating it', () => {
    const tree = splitPane(row(A, B), 'a', 'b', 'down')
    expect(tree).toEqual(column(A, B))
    expect(splitLeaves(tree)).toEqual(['a', 'b'])
  })
  it('starts a tree from nothing and wraps the whole layout when the target is missing', () => {
    expect(splitPane(null, 'x', 'a', 'right')).toEqual(A)
    const wrapped = splitPane(row(A, B), 'missing', 'c', 'right') as SplitBranch
    expect(splitLeaves(wrapped)).toEqual(['a', 'b', 'c'])
    expect(wrapped.ratio).toBeCloseTo(2 / 3)
  })
  it('ignores splitting a pane beside itself', () => {
    expect(splitPane(A, 'a', 'a', 'right')).toBe(A)
  })
})

describe('removePane', () => {
  it('collapses the parent and focuses the nearest pane of the sibling', () => {
    expect(removePane(row(A, column(B, C)), 'a')).toEqual({ tree: column(B, C), focus: 'b' })
    expect(removePane(row(column(A, B), C), 'c')).toEqual({ tree: column(A, B), focus: 'b' })
    expect(removePane(row(A, column(B, C, 0.2), 0.7), 'b')).toEqual({ tree: row(A, C, 0.7), focus: 'c' })
  })
  it('empties a single-leaf tree and ignores unknown panes', () => {
    expect(removePane(A, 'a')).toEqual({ tree: null, focus: null })
    const tree = row(A, B)
    expect(removePane(tree, 'zzz')).toEqual({ tree, focus: null })
    expect(removePane(null, 'a')).toEqual({ tree: null, focus: null })
  })
})

describe('moves and swaps', () => {
  it('moves a pane beside another', () => {
    expect(movePane(row(A, row(B, C)), 'c', 'a', 'up')).toEqual(row(column(C, A), B))
    expect(movePane(row(A, B), 'a', 'a', 'left')).toEqual(row(A, B))
    expect(movePane(row(A, B), 'a', 'zzz', 'left')).toEqual(row(A, B))
  })
  it('moves toward the nearest neighbour on that side', () => {
    expect(movePaneInDirection(row(A, B), 'b', 'left')).toEqual(row(B, A))
    expect(movePaneInDirection(row(A, row(B, C)), 'c', 'left')).toEqual(row(A, row(C, B)))
    expect(movePaneInDirection(column(A, B), 'a', 'down')).toEqual(column(B, A))
  })
  it('moves along the whole edge when no pane is on that side', () => {
    expect(movePaneInDirection(column(A, B), 'b', 'left')).toEqual(row(B, A))
    expect(movePaneInDirection(column(A, B), 'a', 'right')).toEqual(row(B, A))
    // Already along that edge: the same shape (the caller treats it as a no-op).
    expect(sameShape(movePaneInDirection(row(B, A), 'b', 'left'), row(B, A))).toBe(true)
    expect(movePaneInDirection(A, 'a', 'left')).toBe(A)
  })
  it('swaps two panes keeping every ratio', () => {
    expect(swapPanes(row(A, column(B, C, 0.3), 0.6), 'a', 'c')).toEqual(row(C, column(B, A, 0.3), 0.6))
    const tree = row(A, B)
    expect(swapPanes(tree, 'a', 'zzz')).toBe(tree)
  })
  it('replaces a pane in place, dropping a duplicate of the replacement', () => {
    expect(replacePane(row(A, B), 'a', 'c')).toEqual(row(C, B))
    expect(replacePane(row(A, column(B, C)), 'a', 'c')).toEqual(row(C, B))
    expect(replacePane(row(A, B), 'zzz', 'c')).toEqual(row(A, B))
  })
})

describe('ratios', () => {
  it('sets a ratio by path and keeps it inside the unit range', () => {
    const tree = row(A, column(B, C))
    expect(nodeAt(setRatioAt(tree, [1], 0.25), [1])).toMatchObject({ ratio: 0.25 })
    expect(nodeAt(setRatioAt(tree, [], 2), [])).toMatchObject({ ratio: 0.95 })
    expect(setRatioAt(tree, [0], 0.3)).toBe(tree)
    expect(setRatioAt(tree, [], Number.NaN)).toBe(tree)
  })
  it('equalizes by pane weight along the split direction', () => {
    const tree = row(A, row(B, C, 0.9), 0.1)
    const equal = equalizeTree(tree) as SplitBranch
    expect(equal.ratio).toBeCloseTo(1 / 3)
    expect((equal.second as SplitBranch).ratio).toBeCloseTo(0.5)
    expect(paneWeight(row(column(A, B), C), 'column')).toBe(2)
    expect((equalizeAt(tree, []) as SplitBranch).ratio).toBeCloseTo(1 / 3)
    expect(((equalizeAt(tree, []) as SplitBranch).second as SplitBranch).ratio).toBe(0.9)
  })
  it('clamps a ratio so both sides keep their minimum size', () => {
    const tree = row(A, row(B, C)) as SplitBranch
    expect(ratioBounds(tree, { width: 1200, height: 800 })).toEqual({ min: 0.3, max: 0.4 })
    expect(clampRatio(tree, 0.9, { width: 1200, height: 800 })).toBeCloseTo(0.4)
    // Not enough room for both minimums: proportional to them.
    expect(ratioBounds(tree, { width: 600, height: 800 })).toEqual({ min: 1 / 3, max: 1 / 3 })
  })
  it('snaps to the middle within the snap distance', () => {
    expect(snapRatio(0.52, 1000)).toBe(0.5)
    expect(snapRatio(0.53, 1000)).toBe(0.53)
  })
  it('fits stored ratios to a box without changing the stored tree', () => {
    const tree = row(A, B, 0.9)
    expect((fitTree(tree, { width: 1000, height: 600 }) as SplitBranch).ratio).toBeCloseTo(0.64)
    expect((tree as SplitBranch).ratio).toBe(0.9)
    expect(fitTree(A, { width: 10, height: 10 })).toBe(A)
  })
})

describe('geometry', () => {
  const grid = row(column(A, B, 0.25), C, 0.4)
  it('computes pane boxes and dividers', () => {
    const rects = paneRects(grid)
    expect(rects.get('a')).toEqual({ x: 0, y: 0, width: 0.4, height: 0.25 })
    expect(rects.get('b')).toEqual({ x: 0, y: 0.25, width: 0.4, height: 0.75 })
    expect(rects.get('c')?.x).toBeCloseTo(0.4)
    expect(splitDividers(grid).map((divider) => [divider.path, divider.direction])).toEqual([[[], 'row'], [[0], 'column']])
    expect(findPanePath(grid, 'b')).toEqual([0, 1])
    expect(findPanePath(grid, 'zzz')).toBeNull()
  })
  it('finds neighbours by side', () => {
    expect(neighborPane(grid, 'c', 'left')).toBe('b')
    expect(neighborPane(grid, 'a', 'right')).toBe('c')
    expect(neighborPane(grid, 'a', 'down')).toBe('b')
    expect(neighborPane(grid, 'a', 'up')).toBeNull()
    expect(neighborPane(grid, 'zzz', 'up')).toBeNull()
  })
  it('measures the minimum size of a tree', () => {
    expect(minimumSize(grid)).toEqual({ width: 720, height: 480 })
    expect(fitsIn(grid, { width: 720, height: 480 })).toBe(true)
    expect(fitsIn(grid, { width: 719, height: 480 })).toBe(false)
    expect(minimumSize(null)).toEqual({ width: 0, height: 0 })
  })
})

describe('persistence helpers', () => {
  it('prunes panes and collapses their splits', () => {
    expect(pruneTree(row(A, column(B, C)), (id) => id !== 'b')).toEqual(row(A, C))
    expect(pruneTree(A, () => false)).toBeNull()
  })
  it('parses a stored tree, repairing ratios and dropping duplicates and junk', () => {
    expect(parseSplitTree(JSON.parse(JSON.stringify(row(leaf(PRIMARY_PANE), column(B, C, 0.3)))))).toEqual(row(leaf(PRIMARY_PANE), column(B, C, 0.3)))
    expect(parseSplitTree({ type: 'split', direction: 'row', first: A, second: A, ratio: 0.5 })).toEqual(A)
    expect(parseSplitTree({ type: 'split', direction: 'row', first: A, second: B, ratio: 'x' })).toEqual(row(A, B))
    expect(parseSplitTree({ type: 'split', direction: 'row', first: A, second: B, ratio: 7 })).toEqual(row(A, B, 0.95))
    expect(parseSplitTree({ type: 'split', direction: 'diagonal', first: A, second: B })).toBeNull()
    expect(parseSplitTree({ type: 'leaf', paneId: '' })).toBeNull()
    expect(parseSplitTree('nope')).toBeNull()
    expect(parseSplitTree({ type: 'split', direction: 'column', first: { bad: true }, second: D })).toEqual(D)
  })
  it('compares shapes without ratios', () => {
    expect(sameShape(row(A, B, 0.2), row(A, B, 0.7))).toBe(true)
    expect(sameShape(row(A, B), column(A, B))).toBe(false)
    expect(sameShape(A, B)).toBe(false)
    expect(sameShape(null, null)).toBe(true)
  })
})
