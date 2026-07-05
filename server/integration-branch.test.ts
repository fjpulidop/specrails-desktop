import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveIntegrationBranch,
  repoDefaultBranch,
  currentBranch,
  isValidBranchName,
  fetchOrigin,
  resolveWorktreeBaseRef,
  __resetFetchOriginCache,
  FETCH_ORIGIN_TTL_MS,
  type ResolvedIntegrationBranch,
} from './integration-branch'
import type { GitRunner, GitResult } from './worktree-manager'

function fakeGit(opts: { originHead?: string | null; abbrevHead?: string | null } = {}): GitRunner {
  return {
    async run(args): Promise<GitResult> {
      if (args[0] === 'symbolic-ref' && args.includes('refs/remotes/origin/HEAD')) {
        return opts.originHead
          ? { code: 0, stdout: `refs/remotes/origin/${opts.originHead}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref' }
      }
      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) {
        return opts.abbrevHead
          ? { code: 0, stdout: `${opts.abbrevHead}\n`, stderr: '' }
          : { code: 0, stdout: 'HEAD\n', stderr: '' } // detached
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

describe('repoDefaultBranch', () => {
  it('strips the origin/ prefix', async () => {
    expect(await repoDefaultBranch(fakeGit({ originHead: 'main' }), '/r')).toBe('main')
    expect(await repoDefaultBranch(fakeGit({ originHead: 'develop' }), '/r')).toBe('develop')
  })
  it('returns null when origin/HEAD is unset', async () => {
    expect(await repoDefaultBranch(fakeGit({ originHead: null }), '/r')).toBeNull()
  })
})

describe('currentBranch', () => {
  it('returns the checked-out branch', async () => {
    expect(await currentBranch(fakeGit({ abbrevHead: 'feature-x' }), '/r')).toBe('feature-x')
  })
  it('returns null when detached (HEAD)', async () => {
    expect(await currentBranch(fakeGit({ abbrevHead: null }), '/r')).toBeNull()
  })
})

describe('isValidBranchName (input-boundary guard)', () => {
  it('accepts normal branch names', () => {
    for (const ok of ['main', 'develop', 'release/1.2', 'feature/foo-bar', 'v2.20.1', 'a_b.c']) {
      expect(isValidBranchName(ok)).toBe(true)
    }
  })
  it('rejects argument-injection and malformed refs', () => {
    for (const bad of ['--upload-pack=x', '-x', 'a b', 'foo..bar', 'a//b', 'ends/', '/starts', 'x.lock', 'tab\tname', '', '   ', 'na$me', 'a;rm -rf']) {
      expect(isValidBranchName(bad)).toBe(false)
    }
  })
})

describe('resolveIntegrationBranch precedence', () => {
  it('explicit wins over everything', async () => {
    const r = await resolveIntegrationBranch(fakeGit({ originHead: 'main' }), {
      repoDir: '/r',
      explicit: 'release/1.2',
      projectSetting: 'develop',
    })
    expect(r).toEqual({ branch: 'release/1.2', source: 'explicit' })
  })

  it('project setting wins over repo default', async () => {
    const r = await resolveIntegrationBranch(fakeGit({ originHead: 'main' }), {
      repoDir: '/r',
      projectSetting: 'develop',
    })
    expect(r).toEqual({ branch: 'develop', source: 'project-setting' })
  })

  it('falls to repo default when no explicit/setting', async () => {
    const r = await resolveIntegrationBranch(fakeGit({ originHead: 'main' }), { repoDir: '/r' })
    expect(r).toEqual({ branch: 'main', source: 'repo-default' })
  })

  it('falls to current branch when no origin/HEAD', async () => {
    const r = await resolveIntegrationBranch(fakeGit({ originHead: null, abbrevHead: 'work' }), { repoDir: '/r' })
    expect(r).toEqual({ branch: 'work', source: 'head-fallback' })
  })

  it('falls to literal HEAD when detached and no remote (legacy-identical)', async () => {
    const r = await resolveIntegrationBranch(fakeGit({ originHead: null, abbrevHead: null }), { repoDir: '/r' })
    expect(r).toEqual({ branch: 'HEAD', source: 'head-fallback' })
  })

  it('treats blank explicit/setting as unset (whitespace trimmed)', async () => {
    const r = await resolveIntegrationBranch(fakeGit({ originHead: 'main' }), {
      repoDir: '/r',
      explicit: '   ',
      projectSetting: '  ',
    })
    expect(r).toEqual({ branch: 'main', source: 'repo-default' })
  })
})

describe('fetchOrigin', () => {
  beforeEach(() => { __resetFetchOriginCache() })

  it('success → { ok: true }, git invoked with [fetch, origin] against the right repoDir', async () => {
    const calls: { args: string[]; cwd: string }[] = []
    const git: GitRunner = {
      run: async (args, cwd) => {
        calls.push({ args, cwd })
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const result = await fetchOrigin(git, '/repo')
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{ args: ['fetch', 'origin'], cwd: '/repo' }])
  })

  it('failure (non-zero exit) → { ok: false, error } from the first non-empty stderr line', async () => {
    const git: GitRunner = {
      run: async () => ({ code: 1, stdout: '', stderr: "fatal: 'origin' does not appear to be a git repository\n" }),
    }
    const result = await fetchOrigin(git, '/repo')
    expect(result).toEqual({ ok: false, error: "fatal: 'origin' does not appear to be a git repository" })
  })

  it('a runner rejection also resolves to { ok: false, error } — never throws', async () => {
    const git: GitRunner = { run: async () => { throw new Error('ENOENT: spawn git') } }
    const result = await fetchOrigin(git, '/repo')
    expect(result).toEqual({ ok: false, error: 'ENOENT: spawn git' })
  })

  it('a non-Error rejection is stringified rather than crashing on .message', async () => {
    const git: GitRunner = { run: async () => { throw 'spawn git ENOENT' } } // eslint-disable-line @typescript-eslint/only-throw-error
    const result = await fetchOrigin(git, '/repo')
    expect(result).toEqual({ ok: false, error: 'spawn git ENOENT' })
  })

  it('two calls for the SAME repoDir within the TTL window share ONE underlying fetch', async () => {
    let calls = 0
    const git: GitRunner = { run: async () => { calls++; return { code: 0, stdout: '', stderr: '' } } }
    let now = 1_000
    const clock = () => now
    const r1 = await fetchOrigin(git, '/repo', clock)
    now += 5_000 // still within FETCH_ORIGIN_TTL_MS
    const r2 = await fetchOrigin(git, '/repo', clock)
    expect(calls).toBe(1)
    expect(r1).toEqual({ ok: true })
    expect(r2).toEqual({ ok: true })
  })

  it('a call for the same repoDir AFTER the TTL has elapsed triggers a fresh fetch', async () => {
    let calls = 0
    const git: GitRunner = { run: async () => { calls++; return { code: 0, stdout: '', stderr: '' } } }
    let now = 1_000
    const clock = () => now
    await fetchOrigin(git, '/repo', clock)
    now += FETCH_ORIGIN_TTL_MS + 1
    await fetchOrigin(git, '/repo', clock)
    expect(calls).toBe(2)
  })

  it('two calls for DIFFERENT repoDirs within the same window each get their own fetch (no cross-repo bleed)', async () => {
    let calls = 0
    const git: GitRunner = { run: async () => { calls++; return { code: 0, stdout: '', stderr: '' } } }
    const clock = () => 1_000
    await fetchOrigin(git, '/repo-a', clock)
    await fetchOrigin(git, '/repo-b', clock)
    await fetchOrigin(git, '/repo-a', clock)
    expect(calls).toBe(2) // one per distinct repo, the second /repo-a call was cached
  })

  it('a cached FAILURE is also reused within the TTL (not retried per call)', async () => {
    let calls = 0
    const git: GitRunner = { run: async () => { calls++; return { code: 1, stdout: '', stderr: 'fatal: no remote' } } }
    const clock = () => 1_000
    const r1 = await fetchOrigin(git, '/repo', clock)
    const r2 = await fetchOrigin(git, '/repo', clock)
    expect(calls).toBe(1)
    expect(r1).toEqual({ ok: false, error: 'fatal: no remote' })
    expect(r2).toEqual({ ok: false, error: 'fatal: no remote' })
  })
})

describe('resolveWorktreeBaseRef', () => {
  const integration = (
    source: ResolvedIntegrationBranch['source'],
    branch = 'develop',
  ): ResolvedIntegrationBranch => ({ branch, source })

  it('repo-default + fetchOk + remote branch exists → origin/<branch>, usedRemote: true', async () => {
    const git: GitRunner = { run: async () => ({ code: 0, stdout: '', stderr: '' }) }
    const r = await resolveWorktreeBaseRef(git, { repoDir: '/repo', integration: integration('repo-default'), fetchOk: true })
    expect(r).toEqual({ baseRef: 'origin/develop', usedRemote: true })
  })

  it('project-setting + fetchOk + remote branch exists → same behavior', async () => {
    const git: GitRunner = { run: async () => ({ code: 0, stdout: '', stderr: '' }) }
    const r = await resolveWorktreeBaseRef(git, { repoDir: '/repo', integration: integration('project-setting'), fetchOk: true })
    expect(r).toEqual({ baseRef: 'origin/develop', usedRemote: true })
  })

  it('explicit → bare branch name, usedRemote: false, and never pays the rev-parse --verify existence-check cost', async () => {
    const calls: string[][] = []
    const git: GitRunner = {
      run: async (args) => {
        calls.push(args)
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const r = await resolveWorktreeBaseRef(git, { repoDir: '/repo', integration: integration('explicit'), fetchOk: true })
    expect(r).toEqual({ baseRef: 'develop', usedRemote: false })
    expect(calls).toEqual([]) // no git call at all for explicit
  })

  it('fetchOk: false for a repo-default source → bare branch name, usedRemote: false, warning present', async () => {
    const git: GitRunner = { run: async () => ({ code: 0, stdout: '', stderr: '' }) }
    const r = await resolveWorktreeBaseRef(git, { repoDir: '/repo', integration: integration('repo-default'), fetchOk: false })
    expect(r).toEqual({ baseRef: 'develop', usedRemote: false, warning: 'git fetch origin failed; using local ref' })
  })

  it('fetchOk: true but origin/<branch> does not exist (e.g. unpushed project-setting branch) → bare branch, warning present', async () => {
    const git: GitRunner = { run: async () => ({ code: 1, stdout: '', stderr: '' }) }
    const r = await resolveWorktreeBaseRef(git, { repoDir: '/repo', integration: integration('project-setting'), fetchOk: true })
    expect(r).toEqual({ baseRef: 'develop', usedRemote: false, warning: 'origin/develop not found; using local ref' })
  })

  it('head-fallback behaves like repo-default/project-setting (not like explicit)', async () => {
    const git: GitRunner = { run: async () => ({ code: 0, stdout: '', stderr: '' }) }
    const r = await resolveWorktreeBaseRef(git, { repoDir: '/repo', integration: integration('head-fallback'), fetchOk: true })
    expect(r).toEqual({ baseRef: 'origin/develop', usedRemote: true })
  })
})
