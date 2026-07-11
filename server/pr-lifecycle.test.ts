import { describe, expect, it, vi } from 'vitest'
import { isExactOpenPr, observePrLifecycle, PR_LIFECYCLE_JSON_FIELDS, verifyPushRemoteForPr } from './pr-lifecycle'
import type { Exec } from './pr-publisher'

function execWith(payload: unknown): Exec {
  return {
    run: vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ isCrossRepository: false, ...(payload as Record<string, unknown>) }),
      stderr: '',
    })),
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

  it('rejects a cross-repository PR even when its head/base names match', async () => {
    const result = await observePrLifecycle(execWith({
      state: 'OPEN', isDraft: false, headRefName: 'feat/follow-up', baseRefName: 'main',
      isCrossRepository: true,
      headRefOid: expected, mergeCommit: null, commits: [{ oid: expected }],
    }), '/repo', 'https://github.com/o/r/pull/1', expected)

    expect(result).toMatchObject({ ok: true, isCrossRepository: true })
    expect(isExactOpenPr(result, 'feat/follow-up', 'main')).toBe(false)
  })

  it('fails closed when GitHub omits cross-repository identity evidence', async () => {
    const exec: Exec = {
      run: vi.fn(async () => ({
        code: 0,
        stdout: JSON.stringify({
          state: 'OPEN', isDraft: false, headRefName: 'feat/follow-up', baseRefName: 'main',
          headRefOid: expected, mergeCommit: null, commits: [{ oid: expected }],
        }),
        stderr: '',
      })),
    }
    const result = await observePrLifecycle(exec, '/repo', 'https://github.com/o/r/pull/1', expected)

    expect(result).toMatchObject({ ok: true, isCrossRepository: null })
    expect(isExactOpenPr(result, 'feat/follow-up', 'main')).toBe(false)
  })

  it('does not verify an OPEN PR when the delivery SHA is only an ancestor of a newer head', async () => {
    const result = await observePrLifecycle(execWith({
      state: 'OPEN', isDraft: false, headRefName: 'feat/follow-up', baseRefName: 'main',
      headRefOid: 'd'.repeat(40), mergeCommit: null, commits: [{ oid: expected }, { oid: 'd'.repeat(40) }],
    }), '/repo', 'https://github.com/o/r/pull/1', expected)

    expect(result).toMatchObject({ ok: true, state: 'OPEN', includesExpectedSha: false })
  })
})

describe('PR push remote identity', () => {
  it.each([
    'https://github.com/o/r.git',
    'ssh://git@github.com/o/r.git',
    'git@github.com:o/r.git',
  ])('accepts an exact origin URL for the PR repository: %s', async (remoteUrl) => {
    const exec: Exec = { run: vi.fn(async () => ({ code: 0, stdout: `${remoteUrl}\n`, stderr: '' })) }

    await expect(verifyPushRemoteForPr(exec, '/repo', 'https://github.com/o/r/pull/7'))
      .resolves.toEqual({ ok: true, identity: 'github.com/o/r', pushTarget: remoteUrl })
    expect(exec.run).toHaveBeenCalledWith(
      'git', ['remote', 'get-url', '--push', '--all', 'origin'], '/repo',
    )
  })

  it('rejects multiple push URLs even when the first one owns the PR', async () => {
    const exec: Exec = {
      run: vi.fn(async () => ({
        code: 0,
        stdout: 'https://github.com/o/r.git\nhttps://github.com/attacker/fork.git\n',
        stderr: '',
      })),
    }

    const result = await verifyPushRemoteForPr(exec, '/repo', 'https://github.com/o/r/pull/7')

    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('exactly one URL') })
  })

  it.each([
    'https://ghp_SECRET@github.com/o/r.git',
    'https://user:SECRET@github.com/o/r.git',
    'https://github.com/o/r.git?token=SECRET',
    'https://github.com/o/r.git#SECRET',
    'SECRET@github.com:o/r.git',
    'ssh://SECRET@github.com/o/r.git',
    'git@github.com:o/r.git?token=SECRET',
    'git@github.com:o/r.git#SECRET',
  ])('rejects a push URL that could expose embedded credentials: %s', async (remoteUrl) => {
    const exec: Exec = { run: vi.fn(async () => ({ code: 0, stdout: `${remoteUrl}\n`, stderr: '' })) }

    const result = await verifyPushRemoteForPr(exec, '/repo', 'https://github.com/o/r/pull/7')

    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('rejects an origin fork before any push can target the wrong repository', async () => {
    const exec: Exec = {
      run: vi.fn(async () => ({ code: 0, stdout: 'git@github.com:someone-else/r.git\n', stderr: '' })),
    }

    const result = await verifyPushRemoteForPr(exec, '/repo', 'https://github.com/o/r/pull/7')

    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('does not own') })
  })

  it('fails closed for ambiguous aliases and malformed PR URLs', async () => {
    const exec: Exec = { run: vi.fn(async () => ({ code: 0, stdout: 'git@github-work:o/r.git\n', stderr: '' })) }
    await expect(verifyPushRemoteForPr(exec, '/repo', 'https://github.com/o/r/pull/7'))
      .resolves.toMatchObject({ ok: false })
    await expect(verifyPushRemoteForPr(exec, '/repo', 'not-a-pr-url'))
      .resolves.toMatchObject({ ok: false })
  })
})
