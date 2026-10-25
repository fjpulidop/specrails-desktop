// Multi-select model of the specs board (CD4). Pure: no React, no storage.
//
// The board is two "columns" (the active bucket and the Done bucket), each an
// ordered list of spec ids. A selection is a set of ids plus the anchor the
// last plain toggle set, so Shift-click can extend a range inside ONE column.

export type BoardColumn = 'active' | 'done'

export interface BoardSelection {
  ids: ReadonlySet<number>
  /** The id Shift-click ranges start from (last toggled-on spec). */
  anchor: number | null
}

export type SelectGesture = 'toggle' | 'range'

export const EMPTY_SELECTION: BoardSelection = { ids: new Set<number>(), anchor: null }

export function toggleSelection(sel: BoardSelection, id: number): BoardSelection {
  const ids = new Set(sel.ids)
  if (ids.has(id)) {
    ids.delete(id)
    return { ids, anchor: sel.anchor === id ? null : sel.anchor }
  }
  ids.add(id)
  return { ids, anchor: id }
}

/**
 * Shift-click: select every spec between the anchor and `id` (inclusive) in
 * `column`. Falls back to a plain toggle when there is no anchor or the anchor
 * is not in this column (a range never spans columns).
 */
export function selectRange(sel: BoardSelection, column: readonly number[], id: number): BoardSelection {
  const to = column.indexOf(id)
  const from = sel.anchor === null ? -1 : column.indexOf(sel.anchor)
  if (to === -1) return sel
  if (from === -1) return toggleSelection(sel, id)
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  const ids = new Set(sel.ids)
  for (let i = lo; i <= hi; i += 1) ids.add(column[i])
  return { ids, anchor: sel.anchor }
}

/** ⌘A: add every spec of the column. */
export function selectColumn(sel: BoardSelection, column: readonly number[]): BoardSelection {
  if (column.length === 0) return sel
  const ids = new Set(sel.ids)
  for (const id of column) ids.add(id)
  return { ids, anchor: sel.anchor !== null && ids.has(sel.anchor) ? sel.anchor : column[column.length - 1] }
}

export function applyGesture(sel: BoardSelection, gesture: SelectGesture, column: readonly number[], id: number): BoardSelection {
  return gesture === 'range' ? selectRange(sel, column, id) : toggleSelection(sel, id)
}

/** Keep only specs still visible (a filter, a delete or a move can remove them). */
export function pruneSelection(sel: BoardSelection, visible: ReadonlySet<number>): BoardSelection {
  let changed = false
  const ids = new Set<number>()
  for (const id of sel.ids) {
    if (visible.has(id)) ids.add(id)
    else changed = true
  }
  if (!changed) return sel
  return { ids, anchor: sel.anchor !== null && ids.has(sel.anchor) ? sel.anchor : null }
}

/** Keys that never start a selection gesture: typing targets. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable === true
}

/** The click gesture of a mouse event: ⌘/Ctrl toggles, Shift extends a range. */
export function gestureOfClick(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): SelectGesture | null {
  if (e.metaKey || e.ctrlKey) return 'toggle'
  if (e.shiftKey) return 'range'
  return null
}
