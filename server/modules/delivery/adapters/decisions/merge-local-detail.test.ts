import { describe, expect, it } from 'vitest'
import { mergeFailureDetail } from './merge-local'

describe('merge-local failure detail', () => {
  it('names the conflicting files instead of Git\'s first "Auto-merging" line', () => {
    // The one-objective benchmark: two rails edited src/cart.js; the card read "Auto-merging src/cart.js".
    const stdout = 'Auto-merging src/cart.js\nCONFLICT (content): Merge conflict in src/cart.js\nAuto-merging test/cart.test.js\nCONFLICT (content): Merge conflict in test/cart.test.js\nAutomatic merge failed; fix conflicts and then commit the result.\n'
    expect(mergeFailureDetail({ code: 1, stdout, stderr: '' })).toBe('conflicts with the base in src/cart.js, test/cart.test.js: integrate the other delivery first, then launch this spec again on the updated base')
    expect(mergeFailureDetail({ code: 1, stdout: 'CONFLICT (modify/delete): docs/a.md deleted in HEAD and modified in x.\n', stderr: '' })).toMatch(/in docs\/a\.md deleted in HEAD/)
  })

  it('keeps other failures readable', () => {
    expect(mergeFailureDetail({ code: 128, stdout: '', stderr: 'fatal: refusing to merge unrelated histories\n' })).toBe('fatal: refusing to merge unrelated histories')
    expect(mergeFailureDetail({ code: 2, stdout: 'Auto-merging a.js\n', stderr: '' })).toBe('Auto-merging a.js')
    expect(mergeFailureDetail({ code: 3, stdout: '', stderr: '' })).toBe('exit 3')
  })
})
