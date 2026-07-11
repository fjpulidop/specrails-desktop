import { describe, expect, it, vi } from 'vitest'
import type { GitRunner } from './worktree-manager'
import {
  advanceRecoveryCommitProtection,
  commitCarriesRunMarker,
  discoverRunMarkedCommit,
  listRecoveryCommitProtections,
  protectRecoveryCommit,
  recoveryRefForDelivery,
  releaseRecoveryCommit,
  scanUnreachableRecoveryCommits,
} from './rail-pr-recovery-git'

const ok = { code: 0, stdout: '', stderr: '' }
const sha = (digit: string) => digit.repeat(40)

function scriptedGit(
  handler: (args: string[], cwd: string) => Promise<typeof ok> | typeof ok,
): { git: GitRunner; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = []
  return {
    calls,
    git: {
      async run(args, cwd) {
        calls.push({ args, cwd })
        return handler(args, cwd)
      },
    },
  }
}

describe('rail PR recovery Git evidence', () => {
  it('parses only complete bounded unreachable commit evidence and deduplicates it', async () => {
    const commit = sha('a')
    const { git } = scriptedGit((args) => args[0] === 'fsck'
      ? {
          code: 0,
          stdout: [
            `unreachable blob ${sha('b')}`,
            `unreachable tree ${sha('c')}`,
            `unreachable tag ${sha('d')}`,
            `unreachable commit ${commit.toUpperCase()}`,
            `unreachable commit ${commit}`,
            '',
          ].join('\n'),
          stderr: '',
        }
      : ok)

    await expect(scanUnreachableRecoveryCommits(git, '/repo')).resolves.toEqual({
      ok: true,
      commits: [commit],
    })
  })

  it.each([
    {
      name: 'a command failure',
      result: { code: 1, stdout: '', stderr: 'fsck failed' },
      detail: 'Git could not enumerate unreachable recovery objects',
    },
    {
      name: 'malformed output',
      result: { code: 0, stdout: 'unreachable commit not-a-sha\n', stderr: '' },
      detail: 'Git returned malformed unreachable-object evidence',
    },
    {
      name: 'an excessive candidate universe',
      result: {
        code: 0,
        stdout: Array.from(
          { length: 513 },
          (_, index) => `unreachable commit ${index.toString(16).padStart(40, '0')}`,
        ).join('\n'),
        stderr: '',
      },
      detail: 'Git exposed too many unreachable commits for safe recovery',
    },
  ])('fails closed on $name', async ({ result, detail }) => {
    const { git } = scriptedGit((args) => args[0] === 'fsck' ? result : ok)

    await expect(scanUnreachableRecoveryCommits(git, '/repo')).resolves.toEqual({ ok: false, detail })
  })

  it('finds one exact run-marked subject across deduplicated refs, reflogs, and unreachable objects', async () => {
    const commit = sha('a')
    const unmarked = sha('b')
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === 'fsck') {
        return { code: 0, stdout: `unreachable commit ${commit}\nunreachable commit ${unmarked}\n`, stderr: '' }
      }
      if (args[0] === 'log') return { code: 0, stdout: `${commit}\n`, stderr: '' }
      if (args[0] === 'show') {
        return {
          code: 0,
          stdout: args[3] === commit
            ? 'specrails: follow-up (run run-123)\n'
            : 'unrelated commit\n',
          stderr: '',
        }
      }
      return ok
    })

    await expect(discoverRunMarkedCommit(git, '/repo', 'run-123')).resolves.toEqual({
      kind: 'unique',
      sha: commit,
    })
    expect(calls.filter(({ args }) => args[0] === 'show')).toHaveLength(2)
    expect(calls).toContainEqual({
      args: ['log', '--all', '--reflog', '--fixed-strings', '--grep=(run run-123)', '--format=%H'],
      cwd: '/repo',
    })
  })

  it('distinguishes no marked commit from ambiguous marked commits', async () => {
    const first = sha('a')
    const second = sha('b')
    const makeGit = (marked: Set<string>) => scriptedGit((args) => {
      if (args[0] === 'fsck') {
        return { code: 0, stdout: `unreachable commit ${first}\nunreachable commit ${second}\n`, stderr: '' }
      }
      if (args[0] === 'log') return ok
      if (args[0] === 'show') {
        return { code: 0, stdout: marked.has(args[3]) ? 'settle (run run-1)\n' : 'unrelated\n', stderr: '' }
      }
      return ok
    }).git

    await expect(discoverRunMarkedCommit(makeGit(new Set()), '/repo', 'run-1')).resolves.toEqual({ kind: 'none' })
    await expect(discoverRunMarkedCommit(
      makeGit(new Set([first, second])),
      '/repo',
      'run-1',
    )).resolves.toEqual({ kind: 'ambiguous', count: 2 })
  })

  it.each([
    {
      name: 'refs/reflog enumeration failure',
      handler: (args: string[]) => args[0] === 'fsck'
        ? ok
        : args[0] === 'log'
          ? { code: 1, stdout: '', stderr: 'log failed' }
          : ok,
      detail: 'Git could not enumerate recovery refs and reflogs',
    },
    {
      name: 'malformed refs/reflog evidence',
      handler: (args: string[]) => args[0] === 'fsck'
        ? ok
        : args[0] === 'log'
          ? { code: 0, stdout: 'not-a-sha\n', stderr: '' }
          : ok,
      detail: 'Git returned malformed recovery commit evidence',
    },
    {
      name: 'subject inspection failure',
      handler: (args: string[]) => args[0] === 'fsck'
        ? { code: 0, stdout: `unreachable commit ${sha('a')}\n`, stderr: '' }
        : args[0] === 'log'
          ? ok
          : args[0] === 'show'
            ? { code: 1, stdout: '', stderr: 'missing object' }
            : ok,
      detail: 'Git could not inspect every recovery commit subject',
    },
  ])('fails closed on $name instead of manufacturing uniqueness', async ({ handler, detail }) => {
    const { git } = scriptedGit(handler)

    await expect(discoverRunMarkedCommit(git, '/repo', 'run-1')).resolves.toEqual({
      kind: 'scan_failed',
      detail,
    })
  })

  it('caps the combined refs/reflogs and unreachable candidate set', async () => {
    const unreachable = Array.from(
      { length: 512 },
      (_, index) => `unreachable commit ${index.toString(16).padStart(40, '0')}`,
    ).join('\n')
    const extra = 'f'.repeat(40)
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === 'fsck') return { code: 0, stdout: unreachable, stderr: '' }
      if (args[0] === 'log') return { code: 0, stdout: `${extra}\n`, stderr: '' }
      return ok
    })

    await expect(discoverRunMarkedCommit(git, '/repo', 'run-1')).resolves.toEqual({
      kind: 'scan_failed',
      detail: 'Git exposed too many commits for safe recovery',
    })
    expect(calls.some(({ args }) => args[0] === 'show')).toBe(false)
  })

  it('rejects unsafe run identifiers before invoking Git', async () => {
    const { git, calls } = scriptedGit(() => ok)

    await expect(discoverRunMarkedCommit(git, '/repo', 'unsafe\nrun')).resolves.toMatchObject({
      kind: 'scan_failed',
    })
    expect(calls).toEqual([])
  })

  it('inspects only a commit subject when checking a candidate marker', async () => {
    const commit = sha('a')
    const { git, calls } = scriptedGit((args) => args[0] === 'show'
      ? { code: 0, stdout: 'settle (run run-1)\n', stderr: '' }
      : ok)

    await expect(commitCarriesRunMarker(git, '/repo', commit, 'run-1')).resolves.toBe(true)
    expect(calls).toEqual([{ args: ['show', '-s', '--format=%s', commit], cwd: '/repo' }])
  })

  it('pins one delivery-specific commit idempotently and releases only the exact protected object', async () => {
    const commit = sha('a')
    const other = sha('b')
    const deliveryId = 'delivery-1'
    const ref = recoveryRefForDelivery(deliveryId)
    const refs = new Map<string, string>()
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === 'update-ref' && args[1] === '-d') {
        const [, , targetRef, expected] = args
        if (!refs.has(targetRef)) return ok
        if (expected && refs.get(targetRef) !== expected) return { code: 1, stdout: '', stderr: 'mismatch' }
        refs.delete(targetRef)
        return ok
      }
      if (args[0] === 'update-ref') {
        const [, targetRef, targetSha, expected] = args
        if (expected && refs.has(targetRef)) return { code: 1, stdout: '', stderr: 'exists' }
        refs.set(targetRef, targetSha)
        return ok
      }
      if (args[0] === 'rev-parse') {
        const targetRef = args[2]
        const value = refs.get(targetRef)
        return value
          ? { code: 0, stdout: `${value}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: 'missing' }
      }
      return ok
    })

    await expect(protectRecoveryCommit(git, '/repo', deliveryId, commit)).resolves.toEqual({ ok: true, ref })
    await expect(protectRecoveryCommit(git, '/repo', deliveryId, commit)).resolves.toEqual({ ok: true, ref })
    expect(refs.get(ref)).toBe(commit)

    await expect(releaseRecoveryCommit(git, '/repo', deliveryId, other)).resolves.toBe(false)
    expect(refs.get(ref)).toBe(commit)
    await expect(releaseRecoveryCommit(git, '/repo', deliveryId, commit)).resolves.toBe(true)
    expect(refs.has(ref)).toBe(false)
    expect(calls.filter(({ args }) => args[0] === 'update-ref' && args[1] === ref)).toHaveLength(2)
  })

  it('refuses to replace another commit already protected for the same delivery', async () => {
    const existing = sha('a')
    const candidate = sha('b')
    const ref = recoveryRefForDelivery('delivery-1')
    const git: GitRunner = {
      run: vi.fn(async (args) => {
        if (args[0] === 'update-ref') return { code: 1, stdout: '', stderr: 'exists' }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${existing}\n`, stderr: '' }
        return ok
      }),
    }

    await expect(protectRecoveryCommit(git, '/repo', 'delivery-1', candidate)).resolves.toEqual({
      ok: false,
      detail: 'A different commit already owns this delivery recovery ref',
    })
    expect(git.run).toHaveBeenCalledWith(['update-ref', ref, candidate, '0'.repeat(40)], '/repo')
  })

  it('advances an owned recovery ref with an exact compare-and-set', async () => {
    const previous = sha('a')
    const next = sha('b')
    const ref = recoveryRefForDelivery('delivery-1')
    let protectedSha = previous
    const { git, calls } = scriptedGit((args) => {
      if (args[0] === 'update-ref') {
        expect(args).toEqual(['update-ref', ref, next, previous])
        if (protectedSha !== args[3]) return { code: 1, stdout: '', stderr: 'mismatch' }
        protectedSha = args[2]
        return ok
      }
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${protectedSha}\n`, stderr: '' }
      return ok
    })

    await expect(advanceRecoveryCommitProtection(
      git,
      '/repo',
      'delivery-1',
      previous,
      next,
    )).resolves.toEqual({ ok: true, ref })
    expect(protectedSha).toBe(next)
    expect(calls).toEqual([
      { args: ['update-ref', ref, next, previous], cwd: '/repo' },
      { args: ['rev-parse', '--verify', ref], cwd: '/repo' },
    ])
  })

  it('fails closed when the recovery ref changed before an advance CAS', async () => {
    const previous = sha('a')
    const next = sha('b')
    const substituted = sha('c')
    const ref = recoveryRefForDelivery('delivery-1')
    const { git, calls } = scriptedGit((args) => args[0] === 'update-ref'
      ? { code: 1, stdout: '', stderr: 'old value mismatch' }
      : { code: 0, stdout: `${substituted}\n`, stderr: '' })

    await expect(advanceRecoveryCommitProtection(
      git,
      '/repo',
      'delivery-1',
      previous,
      next,
    )).resolves.toEqual({
      ok: false,
      detail: 'The delivery recovery ref changed before the new commit could be protected',
    })
    expect(calls).toEqual([{ args: ['update-ref', ref, next, previous], cwd: '/repo' }])
  })

  it('preserves the protected ref when no exact expected SHA is available for release', async () => {
    const commit = sha('a')
    const ref = recoveryRefForDelivery('delivery-1')
    const git: GitRunner = {
      run: vi.fn(async (args) => {
        if (args[0] === 'update-ref' && args[1] === '-d') {
          return { code: 0, stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${commit}\n`, stderr: '' }
        return ok
      }),
    }

    await expect(releaseRecoveryCommit(git, '/repo', 'delivery-1', null)).resolves.toBe(false)
    expect(git.run).not.toHaveBeenCalledWith(['update-ref', '-d', ref], '/repo')
  })

  it('enumerates a bounded exact internal-ref surface for startup cleanup', async () => {
    const firstRef = recoveryRefForDelivery('delivery-1')
    const secondRef = recoveryRefForDelivery('delivery-2')
    const first = sha('a')
    const second = sha('b')
    const { git } = scriptedGit((args) => args[0] === 'for-each-ref'
      ? { code: 0, stdout: `${firstRef}\t${first}\n${secondRef}\t${second}\n`, stderr: '' }
      : ok)

    const scan = await listRecoveryCommitProtections(git, '/repo')
    expect(scan.ok).toBe(true)
    if (scan.ok) {
      expect([...scan.protections]).toEqual([[firstRef, first], [secondRef, second]])
    }
  })

  it.each([
    { stdout: 'malformed\n', code: 0, detail: 'Git returned malformed delivery recovery refs' },
    { stdout: '', code: 1, detail: 'Git could not enumerate delivery recovery refs' },
  ])('fails closed while enumerating internal refs: $detail', async ({ stdout, code, detail }) => {
    const { git } = scriptedGit((args) => args[0] === 'for-each-ref'
      ? { code, stdout, stderr: 'failed' }
      : ok)

    await expect(listRecoveryCommitProtections(git, '/repo')).resolves.toEqual({ ok: false, detail })
  })
})
