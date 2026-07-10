import { describe, expect, it, vi } from 'vitest'
import { isExactOpenPr, observePrLifecycle, PR_LIFECYCLE_JSON_FIELDS } from './pr-lifecycle'
import type { Exec } from './pr-publisher'

function execWith(payload: unknown): Exec {
  return {
    run: vi.fn(async () => ({ code: 0, stdout: JSON.stringify(payload), stderr: '' })),
  }
}

const expected = 'a'.repeat(40)
const merged = 'b'.repeat(40)

describe('PR lifecycle evidence', () => {
  it('does not treat a post-merge head advance as proof that the merge included that SHA', async () => {
    const exec = execWith({
      state: 'MERGED', isDraft: false, headRefName: 'feat/follow-up', baseRefName: 'main',
      headRefOid: expected,
      mergeCommit: { oid: merged },
      commits: [{ oid: 'c'.repeat(40) }],
    })

    const result = await observePrLifecycle(exec, '/repo', 'https://github.com/o/r/pull/1', expected)

    expect(result).toMatchObject({ ok: true, state: 'MERGED', includesExpectedSha: false })
    expect(exec.run).toHaveBeenCalledWith(
      'gh', ['pr', 'view', 'https://github.com/o/r/pull/1', '--json', PR_LIFECYCLE_JSON_FIELDS], '/repo',
    )
  })

  it('accepts immutable merged commit evidence containing the exact delivery SHA', async () => {
    const result = await observePrLifecycle(execWith({
      state: 'MERGED', isDraft: false, headRefName: 'feat/follow-up', baseRefName: 'main',
      headRefOid: 'd'.repeat(40), mergeCommit: { oid: merged }, commits: [{ oid: expected }],
    }), '/repo', 'https://github.com/o/r/pull/1', expected)

    expect(result).toMatchObject({ ok: true, state: 'MERGED', includesExpectedSha: true })
  })

  it('requires OPEN plus exact head/base identity for continuation admission', async () => {
    const result = await observePrLifecycle(execWith({
      state: 'OPEN', isDraft: true, headRefName: 'feat/follow-up', baseRefName: 'main',
      headRefOid: expected, mergeCommit: null, commits: [{ oid: expected }],
    }), '/repo', 'https://github.com/o/r/pull/1', expected)

    expect(isExactOpenPr(result, 'feat/follow-up', 'main')).toBe(true)
    expect(isExactOpenPr(result, 'feat/other', 'main')).toBe(false)
  })
})
