/**
 * Opaque offset cursors for optional list paging on REST routes that historically
 * returned everything (tickets, rails). A cursor carries the next offset and the
 * revision it was issued at; a cursor from an older revision still pages (the
 * caller is told it may have shifted) rather than failing.
 *
 * Pure: no I/O.
 */

export interface PageRequest {
  limit: number
  offset: number
  /** The cursor was issued for a different revision; items may have shifted. */
  stale: boolean
}

export class PageCursorError extends Error {
  readonly status = 400
  readonly code = 'invalid_cursor'
}

export function encodePageCursor(offset: number, revision?: string | number | null): string {
  return Buffer.from(JSON.stringify({ o: offset, ...(revision === undefined || revision === null ? {} : { r: revision }) })).toString('base64url')
}

export function decodePageCursor(cursor: string): { offset: number; revision?: string | number } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown; r?: unknown }
    if (typeof value.o !== 'number' || !Number.isSafeInteger(value.o) || value.o < 0) throw new Error('offset')
    return { offset: value.o, ...(typeof value.r === 'string' || typeof value.r === 'number' ? { revision: value.r } : {}) }
  } catch {
    throw new PageCursorError('Invalid cursor; pass the nextCursor of the previous page or omit it.')
  }
}

const firstString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined

/**
 * Parse `limit` / `cursor` / `offset` query parameters. Returns null when the
 * caller asked for no paging (no `limit`), so the route keeps its default,
 * unpaged response.
 */
export function parsePageQuery(query: Record<string, unknown>, options: { max: number; revision?: string | number | null }): PageRequest | null {
  const rawLimit = firstString(query.limit)
  if (rawLimit === undefined) return null
  const limit = Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 0) throw new PageCursorError('limit must be a non-negative integer.')
  const cursor = firstString(query.cursor)
  const rawOffset = firstString(query.offset)
  let offset = 0
  let stale = false
  if (cursor) {
    const decoded = decodePageCursor(cursor)
    offset = decoded.offset
    stale = decoded.revision !== undefined && options.revision !== undefined && options.revision !== null && String(decoded.revision) !== String(options.revision)
  } else if (rawOffset !== undefined) {
    offset = Number(rawOffset)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new PageCursorError('offset must be a non-negative integer.')
  }
  return { limit: Math.min(limit, options.max), offset, stale }
}

/** Slice `items` for a page request and describe the continuation. */
export function pageOf<T>(items: readonly T[], page: PageRequest, revision?: string | number | null): {
  items: T[]; offset: number; limit: number; nextCursor: string | null; nextOffset: number | null; cursorStale?: true
} {
  const slice = items.slice(page.offset, page.offset + page.limit)
  const nextOffset = page.offset + slice.length < items.length && slice.length > 0 ? page.offset + slice.length : null
  return {
    items: slice,
    offset: page.offset,
    limit: page.limit,
    nextOffset,
    nextCursor: nextOffset === null ? null : encodePageCursor(nextOffset, revision),
    ...(page.stale ? { cursorStale: true as const } : {}),
  }
}
