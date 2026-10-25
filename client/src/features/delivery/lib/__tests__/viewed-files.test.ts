import { beforeEach, describe, expect, it, vi } from 'vitest'
import { changedSinceViewed, countViewed, isViewed, readDiffMode, readViewed, toggleViewed, writeDiffMode } from '../viewed-files'
import type { ChangedFile } from '../changes-model'

const f = (path: string, hash: string): ChangedFile => ({ path, oldPath: null, status: 'modified', additions: 1, deletions: 0, binary: false, hash })

beforeEach(() => { localStorage.clear() })

describe('viewed files', () => {
  it('persists per project and delivery, and survives a reload', () => {
    const a = f('a.ts', 'h1')
    const marked = toggleViewed('p1', 'd1', readViewed('p1', 'd1'), a)
    expect(isViewed(marked, a)).toBe(true)
    expect(isViewed(readViewed('p1', 'd1'), a)).toBe(true)
    expect(readViewed('p1', 'd2')).toEqual({})
    expect(readViewed('p2', 'd1')).toEqual({})
    expect(countViewed(readViewed('p1', 'd1'), [a, f('b.ts', 'x')])).toBe(1)
  })

  it('toggles off, and a changed content hash invalidates the mark', () => {
    const a = f('a.ts', 'h1')
    const marked = toggleViewed('p', 'd', {}, a)
    const revised = f('a.ts', 'h2')
    expect(isViewed(marked, revised)).toBe(false)
    expect(changedSinceViewed(marked, revised)).toBe(true)
    expect(changedSinceViewed(marked, a)).toBe(false)
    expect(toggleViewed('p', 'd', marked, a)).toEqual({})
  })

  it('treats corrupt or unavailable storage as empty and never throws', () => {
    localStorage.setItem('specrails-desktop:review-viewed:p:d', '{not json')
    expect(readViewed('p', 'd')).toEqual({})
    localStorage.setItem('specrails-desktop:review-viewed:p:d', '[1,2]')
    expect(readViewed('p', 'd')).toEqual({})
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => toggleViewed('p', 'd', {}, f('a.ts', 'h'))).not.toThrow()
    expect(() => writeDiffMode('split')).not.toThrow()
    spy.mockRestore()
  })

  it('remembers the diff layout per viewer', () => {
    expect(readDiffMode()).toBe('unified')
    writeDiffMode('split')
    expect(readDiffMode()).toBe('split')
  })
})
