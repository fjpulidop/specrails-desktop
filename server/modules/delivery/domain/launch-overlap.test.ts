import { describe, expect, it } from 'vitest'
import { mentionedPaths, overlapLogLine, predictOverlaps, worktreeRelative } from './launch-overlap'

describe('launch overlap', () => {
  it('reads the files a spec names', () => {
    expect(mentionedPaths('Add `applyTax(total, rate)` to src/cart.js. Unit tests in test/cart.test.js. `npm test` must pass; see README.md and ./docs/api.md (v1.2.3).'))
      .toEqual(['README.md', 'docs/api.md', 'src/cart.js', 'test/cart.test.js'])
    expect(mentionedPaths('Edit /etc/hosts and ../secret.js')).toEqual([])
  })

  it('maps agent writes to repository paths of its worktree only', () => {
    expect(worktreeRelative('/w/run-1/ticket-1/src/cart.js', '/w/run-1/ticket-1')).toBe('src/cart.js')
    expect(worktreeRelative('/w/run-2/ticket-1/src/cart.js', '/w/run-1/ticket-1')).toBeNull()
  })

  it('names the rails sharing files, ignoring lockfiles and OpenSpec artifacts', () => {
    const overlaps = predictOverlaps(['src/cart.js', 'test/cart.test.js', 'package-lock.json'], [
      { railIndex: 2, state: 'pending', title: 'Tax', paths: ['src/cart.js', 'openspec/changes/x/tasks.md'] },
      { railIndex: 0, state: 'running', title: 'Discount', paths: ['test/cart.test.js', 'src/cart.js'] },
      { railIndex: 1, state: 'running', title: 'Money', paths: ['src/format.js', 'package-lock.json'] },
    ])
    expect(overlaps).toEqual([
      { railIndex: 0, state: 'running', title: 'Discount', files: ['src/cart.js', 'test/cart.test.js'] },
      { railIndex: 2, state: 'pending', title: 'Tax', files: ['src/cart.js'] },
    ])
    expect(overlapLogLine(overlaps)).toBe('⚠ Likely overlap with rail 1 ("Discount"), running: src/cart.js, test/cart.test.js; rail 3 ("Tax"), waiting to merge: src/cart.js. Merge these one after the other; the later one may need a rebase and a new verification.')
    expect(overlapLogLine([])).toBeNull()
  })
})
