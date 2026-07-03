import { describe, it, expect } from 'vitest'
import {
  resolveIntegrationBranch,
  repoDefaultBranch,
  currentBranch,
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
