import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, pageOf } from './cursor'

describe('cursors', () => {
  it('round-trips offset, path, key and inner cursor', () => {
    const cursor = encodeCursor({ offset: 25, path: '/items', key: 'runs:list', inner: 'k123' })
    expect(decodeCursor(cursor, 'runs:list')).toEqual({ offset: 25, path: '/items', key: 'runs:list', inner: 'k123' })
    expect(decodeCursor(encodeCursor({ offset: 3, path: '/groups/0/specs' }))).toEqual({ offset: 3, path: '/groups/0/specs' })
  })

  it('treats an absent cursor as the first page', () => {
    expect(decodeCursor(undefined)).toBeNull()
    expect(decodeCursor('')).toBeNull()
  })

  it('refuses malformed cursors and cursors of another query', () => {
    expect(() => decodeCursor('not base64 json')).toThrow(/Invalid cursor/)
    expect(() => decodeCursor(Buffer.from('{"v":1,"o":-1}').toString('base64url'))).toThrow(/Invalid cursor/)
    expect(() => decodeCursor(42)).toThrow(/Invalid cursor/)
    expect(() => decodeCursor(encodeCursor({ offset: 1, path: '/items', key: 'a' }), 'b')).toThrow(/another query/)
  })

  it('pages an in-memory list with a capped limit', () => {
    const items = Array.from({ length: 60 }, (_, index) => index)
    const first = pageOf(items, { limit: 25 })
    expect(first.items).toEqual(items.slice(0, 25))
    expect(first.page).toMatchObject({ total: 60, truncated: true })
    const second = pageOf(items, { limit: 25, cursor: first.page.cursor })
    expect(second.items[0]).toBe(25)
    const last = pageOf(items, { limit: 500, cursor: second.page.cursor })
    expect(last.items).toEqual(items.slice(50))
    expect(last.page).toEqual({ cursor: null, total: 60, truncated: false })
  })
})
