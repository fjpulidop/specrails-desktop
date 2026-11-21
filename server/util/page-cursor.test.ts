import { describe, expect, it } from 'vitest'
import { PageCursorError, decodePageCursor, encodePageCursor, pageOf, parsePageQuery } from './page-cursor'

describe('page cursors', () => {
  it('round-trips offset and revision', () => {
    expect(decodePageCursor(encodePageCursor(40, 7))).toEqual({ offset: 40, revision: 7 })
    expect(decodePageCursor(encodePageCursor(3))).toEqual({ offset: 3 })
  })

  it('returns null without limit so routes keep their default response', () => {
    expect(parsePageQuery({}, { max: 10 })).toBeNull()
  })

  it('parses limit/offset/cursor, clamps limit and flags a stale revision', () => {
    expect(parsePageQuery({ limit: '500', offset: '4' }, { max: 100 })).toEqual({ limit: 100, offset: 4, stale: false })
    expect(parsePageQuery({ limit: '5', cursor: encodePageCursor(10, 1) }, { max: 100, revision: 2 })).toEqual({ limit: 5, offset: 10, stale: true })
    expect(() => parsePageQuery({ limit: 'x' }, { max: 10 })).toThrow(PageCursorError)
    expect(() => parsePageQuery({ limit: '1', cursor: 'bogus' }, { max: 10 })).toThrow(/Invalid cursor/)
  })

  it('slices a page and only issues a cursor while items remain', () => {
    const page = pageOf([1, 2, 3], { limit: 2, offset: 0, stale: false }, 9)
    expect(page.items).toEqual([1, 2])
    expect(decodePageCursor(page.nextCursor!)).toEqual({ offset: 2, revision: 9 })
    expect(pageOf([1, 2, 3], { limit: 2, offset: 2, stale: true }).nextCursor).toBeNull()
    expect(pageOf([1, 2, 3], { limit: 2, offset: 2, stale: true }).cursorStale).toBe(true)
  })
})
