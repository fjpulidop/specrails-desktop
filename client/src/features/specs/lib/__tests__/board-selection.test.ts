import { describe, it, expect } from 'vitest'
import {
  EMPTY_SELECTION,
  applyGesture,
  gestureOfClick,
  isTypingTarget,
  pruneSelection,
  selectColumn,
  selectRange,
  toggleSelection,
} from '../board-selection'

const col = [10, 11, 12, 13, 14]
const ids = (s: { ids: ReadonlySet<number> }) => [...s.ids].sort((a, b) => a - b)

describe('board selection model', () => {
  it('toggles a spec on and off and tracks the anchor', () => {
    const on = toggleSelection(EMPTY_SELECTION, 11)
    expect(ids(on)).toEqual([11])
    expect(on.anchor).toBe(11)
    const off = toggleSelection(on, 11)
    expect(ids(off)).toEqual([])
    expect(off.anchor).toBeNull()
  })

  it('shift-click selects the range from the anchor, in either direction', () => {
    const a = toggleSelection(EMPTY_SELECTION, 11)
    expect(ids(selectRange(a, col, 13))).toEqual([11, 12, 13])
    const b = toggleSelection(EMPTY_SELECTION, 13)
    expect(ids(selectRange(b, col, 11))).toEqual([11, 12, 13])
  })

  it('a range keeps what was already selected and the anchor', () => {
    let s = toggleSelection(EMPTY_SELECTION, 10)
    s = toggleSelection(s, 13)
    s = selectRange(s, col, 14)
    expect(ids(s)).toEqual([10, 13, 14])
    expect(s.anchor).toBe(13)
  })

  it('a range without an anchor in this column degrades to a toggle', () => {
    expect(ids(selectRange(EMPTY_SELECTION, col, 12))).toEqual([12])
    const other = toggleSelection(EMPTY_SELECTION, 99)
    expect(ids(selectRange(other, col, 12))).toEqual([12, 99])
  })

  it('selects the whole column', () => {
    const s = selectColumn(toggleSelection(EMPTY_SELECTION, 99), col)
    expect(ids(s)).toEqual([10, 11, 12, 13, 14, 99])
    expect(selectColumn(EMPTY_SELECTION, [])).toBe(EMPTY_SELECTION)
  })

  it('prunes specs that are no longer visible (and keeps identity when nothing changes)', () => {
    const s = selectColumn(EMPTY_SELECTION, col)
    expect(pruneSelection(s, new Set(col))).toBe(s)
    const pruned = pruneSelection(s, new Set([10, 11]))
    expect(ids(pruned)).toEqual([10, 11])
    expect(pruned.anchor === null || pruned.ids.has(pruned.anchor)).toBe(true)
  })

  it('maps a click to a gesture', () => {
    expect(gestureOfClick({ metaKey: true, ctrlKey: false, shiftKey: false })).toBe('toggle')
    expect(gestureOfClick({ metaKey: false, ctrlKey: true, shiftKey: false })).toBe('toggle')
    expect(gestureOfClick({ metaKey: false, ctrlKey: false, shiftKey: true })).toBe('range')
    expect(gestureOfClick({ metaKey: false, ctrlKey: false, shiftKey: false })).toBeNull()
    expect(ids(applyGesture(EMPTY_SELECTION, 'toggle', col, 12))).toEqual([12])
  })

  it('recognises typing targets', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true)
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true)
    expect(isTypingTarget(document.createElement('div'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
