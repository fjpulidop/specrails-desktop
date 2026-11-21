import { V2ToolError } from './envelope'

/**
 * Opaque pagination cursors shared by every v2 list and by the size guard.
 *
 * A cursor is base64url JSON `{ v: 1, o: offset, p?: path, k?: key, i?: inner }`:
 * - `o`: items already returned at `p` (the guard's cut point, or a page end).
 * - `p`: JSON pointer of the array the offset applies to (default `/items`).
 * - `k`: a short query key (tool + filters) so a cursor from another query is refused.
 * - `i`: a domain cursor the tool forwards to its own store (keyset pagination).
 */

export interface CursorState {
  offset: number
  path: string
  key?: string
  inner?: string
}

const DEFAULT_PATH = '/items'

export function encodeCursor(state: CursorState): string {
  const payload: Record<string, unknown> = { v: 1, o: Math.max(0, Math.floor(state.offset)) }
  if (state.path !== DEFAULT_PATH) payload.p = state.path
  if (state.key) payload.k = state.key
  if (state.inner) payload.i = state.inner
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

/**
 * Null for no cursor. A malformed cursor, or one minted for another query
 * (`expectKey`), fails with `invalid_input` and the hint to restart the list.
 */
export function decodeCursor(cursor: unknown, expectKey?: string): CursorState | null {
  if (cursor === undefined || cursor === null || cursor === '') return null
  const bad = (why: string) => new V2ToolError('invalid_input', `Invalid cursor (${why}). Repeat the call without cursor to start again.`)
  if (typeof cursor !== 'string' || cursor.length > 2048) throw bad('not a cursor string')
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { throw bad('unreadable') }
  const value = parsed as Record<string, unknown>
  if (!value || typeof value !== 'object' || value.v !== 1 || typeof value.o !== 'number' || !Number.isInteger(value.o) || value.o < 0) throw bad('unreadable')
  if (value.p !== undefined && (typeof value.p !== 'string' || !value.p.startsWith('/'))) throw bad('bad path')
  if (expectKey !== undefined && value.k !== undefined && value.k !== expectKey) throw bad('it belongs to another query')
  return {
    offset: value.o,
    path: typeof value.p === 'string' ? value.p : DEFAULT_PATH,
    ...(typeof value.k === 'string' ? { key: value.k } : {}),
    ...(typeof value.i === 'string' ? { inner: value.i } : {}),
  }
}

/**
 * In-memory page of an already-loaded list (small lists only; large stores use
 * their own keyset cursor in `inner`). Returns the slice and the page section.
 */
export function pageOf<T>(items: readonly T[], options: { cursor?: unknown; limit?: unknown; key?: string; defaultLimit?: number; maxLimit?: number } = {}): { items: T[]; page: { cursor: string | null; total: number; truncated: boolean } } {
  const state = decodeCursor(options.cursor, options.key)
  const max = options.maxLimit ?? 100
  const requested = typeof options.limit === 'number' && Number.isInteger(options.limit) && options.limit > 0 ? options.limit : options.defaultLimit ?? 25
  const limit = Math.min(requested, max)
  const offset = state?.offset ?? 0
  const slice = items.slice(offset, offset + limit)
  const end = offset + slice.length
  const more = end < items.length
  return {
    items: slice,
    page: { cursor: more ? encodeCursor({ offset: end, path: DEFAULT_PATH, ...(options.key ? { key: options.key } : {}) }) : null, total: items.length, truncated: more },
  }
}
