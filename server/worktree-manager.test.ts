import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  worktreeBranch,
  worktreePath,
  createWorktree,
  removeWorktree,
  listWorktrees,
  listLocalBranches,
  commitWorktree,
  commitWorktreeAndVerify,
  defaultGitRunner,
  ensurePrNeverStageExcludes,
  isGitRepo,
  repoIsolationStatus,
  PR_NEVER_STAGE_PATHS,
  type GitRunner,
  type GitResult,
} from './worktree-manager'

function fakeGit(opts: { worktrees?: string[]; branchExists?: boolean; addFails?: boolean; removeFails?: boolean; insideWorktree?: boolean; hasCommits?: boolean; mountedBranch?: string; headFails?: boolean; ancestor?: boolean; dirtyStatus?: string } = {}) {
  const calls: string[][] = []
  const git: GitRunner = {
    async run(args): Promise<GitResult> {
      calls.push(args)
      if (args[0] === 'worktree' && args[1] === 'list') {
        const lines = ['worktree /repo', ...(opts.worktrees ?? []).map((p) => `worktree ${p}`)]
        return { code: 0, stdout: lines.join('\n') + '\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return opts.headFails
          ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
          : { code: 0, stdout: `${opts.mountedBranch ?? ''}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) {
        return opts.insideWorktree === false ? { code: 128, stdout: '', stderr: 'not a git repo' } : { code: 0, stdout: 'true\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--verify') && args.includes('HEAD')) {
        return opts.hasCommits === false ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: 'headsha\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return opts.branchExists ? { code: 0, stdout: 'sha\n', stderr: '' } : { code: 1, stdout: '', stderr: '' }
      }
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        return opts.ancestor === false ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'update-ref' || args[0] === 'merge') {
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return opts.addFails ? { code: 1, stdout: '', stderr: 'fatal: boom' } : { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return opts.removeFails ? { code: 1, stdout: '', stderr: 'fatal: dirty worktree' } : { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'status') {
        return { code: 0, stdout: opts.dirtyStatus ?? '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const addCalls = () => calls.filter((c) => c[0] === 'worktree' && c[1] === 'add')
  return { git, calls, addCalls }
}

const base = { repoDir: '/repo', worktreesRoot: '/wt', slug: 'p', ticketId: 3 }

describe('worktree path/branch helpers', () => {
  it('builds the legacy fallback branch + the stable path', () => {
    expect(worktreeBranch('myproject', 7)).toBe('sr/myproject/ticket-7')
    expect(worktreePath('/home/u/.specrails/projects/myproject/worktrees', 7)).toBe('/home/u/.specrails/projects/myproject/worktrees/ticket-7')
  })
})

describe('createWorktree (resume-aware)', () => {
  it('creates a fresh branch off base when neither worktree nor branch exists', async () => {
    const { git, addCalls } = fakeGit()
    const h = await createWorktree(git, base)
    expect(h).toEqual({ branch: 'sr/p/ticket-3', worktreePath: '/wt/ticket-3', worktreeCreated: true, branchCreated: true })
    expect(addCalls()[0]).toEqual(['worktree', 'add', '-b', 'sr/p/ticket-3', '/wt/ticket-3', 'HEAD'])
  })

  it('honours an explicit baseRef on a fresh create', async () => {
    const { git, addCalls } = fakeGit()
    await createWorktree(git, { ...base, baseRef: 'abc123' })
    expect(addCalls()[0]?.[addCalls()[0].length - 1]).toBe('abc123')
  })

  it('REUSES an existing worktree (resume) without re-adding', async () => {
    const { git, addCalls } = fakeGit({ worktrees: ['/wt/ticket-3'], mountedBranch: 'sr/p/ticket-3' })
    const h = await createWorktree(git, base)
    expect(h).toEqual({ branch: 'sr/p/ticket-3', worktreePath: '/wt/ticket-3', worktreeCreated: false, branchCreated: false })
    expect(addCalls()).toHaveLength(0) // reused, not recreated
  })

  it('REPRO (live #37 wedge): a mounted worktree on a DIFFERENT branch — the handle reports the branch that actually carries the commits, never the preferred name', async () => {
    // A prior auto-discarded run left /wt/ticket-3 mounted on the legacy
    // sr/ branch; a new launch asks for the conventional name. Reporting the
    // preferred name here recorded a branch that never existed → `git push`
    // had no ref → the PR delivery wedged at local-only forever.
    const { git, addCalls } = fakeGit({ worktrees: ['/wt/ticket-3'], mountedBranch: 'sr/p/ticket-3' })
    const h = await createWorktree(git, { ...base, branch: 'feat/3-add-guess-the-number-mini-game' })
    expect(h).toEqual({ branch: 'sr/p/ticket-3', worktreePath: '/wt/ticket-3', worktreeCreated: false, branchCreated: false })
    expect(addCalls()).toHaveLength(0)
  })

  it('a detached-HEAD mounted worktree falls back to the caller branch', async () => {
    const { git } = fakeGit({ worktrees: ['/wt/ticket-3'], mountedBranch: 'HEAD' })
    const h = await createWorktree(git, { ...base, branch: 'feat/3-x' })
    expect(h.branch).toBe('feat/3-x')
  })

  it('a failing HEAD probe on the mounted worktree falls back to the caller branch', async () => {
    const { git } = fakeGit({ worktrees: ['/wt/ticket-3'], headFails: true })
    const h = await createWorktree(git, { ...base, branch: 'feat/3-x' })
    expect(h.branch).toBe('feat/3-x')
  })

  it('RESUMES an existing branch (worktree cleaned, commits kept) — re-checkout, no -b/base', async () => {
    const { git, addCalls } = fakeGit({ branchExists: true })
    await createWorktree(git, base)
    expect(addCalls()[0]).toEqual(['worktree', 'add', '/wt/ticket-3', 'sr/p/ticket-3'])
  })

  it('throws on git failure', async () => {
    const { git } = fakeGit({ addFails: true })
    await expect(createWorktree(git, base)).rejects.toThrow(/boom/)
  })

  it('uses the preferred conventional branch name when provided', async () => {
    const { git, addCalls } = fakeGit()
    const h = await createWorktree(git, { ...base, branch: 'feat/PROJ-3-add-dark-mode' })
    expect(h).toEqual({ branch: 'feat/PROJ-3-add-dark-mode', worktreePath: '/wt/ticket-3', worktreeCreated: true, branchCreated: true })
    expect(addCalls()[0]).toEqual(['worktree', 'add', '-b', 'feat/PROJ-3-add-dark-mode', '/wt/ticket-3', 'HEAD'])
  })

  it('resumes an existing PREFERRED branch (same resume semantics as legacy)', async () => {
    const { git, addCalls } = fakeGit({ branchExists: true })
    const handle = await createWorktree(git, { ...base, branch: 'feat/3-x' })
    expect(addCalls()[0]).toEqual(['worktree', 'add', '/wt/ticket-3', 'feat/3-x'])
    expect(handle).toMatchObject({ worktreeCreated: true, branchCreated: false })
  })

  it('active-PR continuation fast-forwards an existing local branch from the remote PR head when safe', async () => {
    const { git, calls, addCalls } = fakeGit({ branchExists: true })
    await createWorktree(git, {
      ...base,
      branch: 'feat/3-x',
      baseRef: 'origin/feat/3-x',
      refreshFromBaseRef: true,
    })
    expect(calls).toContainEqual(['merge-base', '--is-ancestor', 'refs/heads/feat/3-x', 'origin/feat/3-x'])
    expect(calls).toContainEqual(['update-ref', 'refs/heads/feat/3-x', 'origin/feat/3-x'])
    expect(addCalls()[0]).toEqual(['worktree', 'add', '/wt/ticket-3', 'feat/3-x'])
  })

  it('active-PR continuation never rewrites a diverged or locally-ahead branch', async () => {
    const { git, calls } = fakeGit({ branchExists: true, ancestor: false })
    await createWorktree(git, {
      ...base,
      branch: 'feat/3-x',
      baseRef: 'origin/feat/3-x',
      refreshFromBaseRef: true,
    })
    expect(calls).toContainEqual(['merge-base', '--is-ancestor', 'refs/heads/feat/3-x', 'origin/feat/3-x'])
    expect(calls.some((c) => c[0] === 'update-ref')).toBe(false)
  })
})

describe('listLocalBranches', () => {
  it('parses for-each-ref output into a set', async () => {
    const git: GitRunner = {
      run: async () => ({ code: 0, stdout: 'main\nfeat/1-a\n\n  feat/2-b \n', stderr: '' }),
    }
    expect(await listLocalBranches(git, '/repo')).toEqual(new Set(['main', 'feat/1-a', 'feat/2-b']))
  })
  it('returns an empty set on git failure', async () => {
    const git: GitRunner = { run: async () => ({ code: 128, stdout: '', stderr: 'boom' }) }
    expect(await listLocalBranches(git, '/repo')).toEqual(new Set())
  })
})

describe('commitWorktree', () => {
  const baseAddArgs = ['add', '-A', '--', '.', ...PR_NEVER_STAGE_PATHS.map((p) => `:(exclude)${p}`)]

  it('stages + commits the worktree to its branch while excluding private agent artifacts', async () => {
    const { git, calls } = fakeGit()
    await commitWorktree(git, '/wt/ticket-1', 'wip')
    expect(calls).toContainEqual(baseAddArgs)
    expect(calls).toContainEqual(['commit', '--no-verify', '--only', '-m', 'wip', ...baseAddArgs.slice(2)])
  })
  it('never throws even if git fails', async () => {
    const git: GitRunner = { run: async () => { throw new Error('git gone') } }
    await expect(commitWorktree(git, '/wt/1', 'x')).resolves.toBeUndefined()
  })
  it('excludes overlay-owned paths from the add via literal pathspecs', async () => {
    const { git, calls } = fakeGit()
    await commitWorktree(git, '/wt/ticket-1', 'wip', ['.claude/commands/specrails', '.sr-rail-overlay.json'])
    expect(calls).toContainEqual([
      ...baseAddArgs,
      ':(top,exclude,literal).claude/commands/specrails',
      ':(top,exclude,literal).sr-rail-overlay.json',
    ])
    expect(calls).toContainEqual([
      'commit', '--no-verify', '--only', '-m', 'wip',
      ...baseAddArgs.slice(2),
      ':(top,exclude,literal).claude/commands/specrails',
      ':(top,exclude,literal).sr-rail-overlay.json',
    ])
  })
  it('always excludes agent-memory and explanations from PR commits', async () => {
    const { git, calls } = fakeGit()
    await commitWorktree(git, '/wt/ticket-1', 'wip', [])
    const addCall = calls.find((c) => c[0] === 'add')!
    expect(addCall).toEqual(baseAddArgs)
    expect(addCall).toEqual(expect.arrayContaining([
      ':(exclude).claude/agent-memory',
      ':(exclude).claude/agent-memory/**',
      ':(exclude).claude/agent-memory/explanations',
      ':(exclude).claude/agent-memory/explanations/**',
      ':(exclude).codex/agent-memory',
      ':(exclude).gemini/agent-memory',
    ]))
  })
  it('reports a dirty deliverable worktree after the commit attempt', async () => {
    const { git } = fakeGit({ dirtyStatus: ' M src/app.ts\n?? src/new.ts\n' })
    const result = await commitWorktreeAndVerify(git, '/wt/ticket-1', 'wip', [])
    expect(result.clean).toBe(false)
    expect(result.dirty).toEqual([' M src/app.ts', '?? src/new.ts'])
  })
  it('treats only excluded overlay/private paths as clean after commit', async () => {
    const git: GitRunner = {
      run: async (args) => {
        if (args[0] === 'status') {
          expect(args).toEqual(expect.arrayContaining([
            ':(top,exclude,literal).claude/commands/specrails',
            ':(top,exclude,literal).sr-rail-overlay.json',
          ]))
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const result = await commitWorktreeAndVerify(git, '/wt/ticket-1', 'wip', ['.claude/commands/specrails', '.sr-rail-overlay.json'])
    expect(result.clean).toBe(true)
  })
  it('treats glob metacharacters in an overlay filename literally', async () => {
    const { git, calls } = fakeGit()
    await commitWorktree(git, '/wt/ticket-1', 'wip', ['.claude/rules/user[1]*.md'])
    expect(calls.find((call) => call[0] === 'add')).toContain(
      ':(top,exclude,literal).claude/rules/user[1]*.md',
    )
  })

  it('NUL-safely removes pre-staged private and literal overlay paths before committing allowed files', async () => {
    const before = [
      '.claude/agent-memory/private\nnotes.txt',
      '.codex/agent-memory/key\tmaterial.txt',
      '.overlay[1]*/odd\nname.txt',
      'src/allowed file.ts',
    ]
    const calls: string[][] = []
    let audits = 0
    const git: GitRunner = {
      run: async (args) => {
        calls.push(args)
        if (args[0] === 'diff') {
          audits += 1
          const paths = audits === 1 ? before : ['src/allowed file.ts']
          return { code: 0, stdout: `${paths.join('\0')}\0`, stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    const result = await commitWorktreeAndVerify(git, '/wt/ticket-1', 'safe commit', ['.overlay[1]*'])

    expect(result).toMatchObject({ staged: true, committed: true, clean: true })
    expect(calls.filter((call) => call[0] === 'diff')).toHaveLength(2)
    const reset = calls.find((call) => call[0] === 'reset')
    expect(reset).toEqual(expect.arrayContaining([
      ':(top,literal).claude/agent-memory',
      ':(top,literal).codex/agent-memory',
      ':(top,literal).overlay[1]*',
    ]))
    expect(reset).not.toContain('src/allowed file.ts')
    expect(calls.findIndex((call) => call[0] === 'reset')).toBeLessThan(
      calls.findIndex((call) => call[0] === 'commit'),
    )
  })

  it.each([
    {
      name: 'git failure',
      audit: { code: 128, stdout: '', stderr: 'index unavailable' },
      detail: /index unavailable/,
    },
    {
      name: 'malformed non-NUL output',
      audit: { code: 0, stdout: '.claude/agent-memory/private.txt', stderr: '' },
      detail: /malformed non-NUL-terminated/,
    },
  ])('fails closed without committing when the index audit returns $name', async ({ audit, detail }) => {
    const calls: string[][] = []
    const git: GitRunner = {
      run: async (args) => {
        calls.push(args)
        if (args[0] === 'diff') return audit
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    const result = await commitWorktreeAndVerify(git, '/wt/ticket-1', 'unsafe commit')

    expect(result).toMatchObject({ staged: true, committed: false, clean: false })
    expect(result.error).toMatch(detail)
    expect(calls.some((call) => call[0] === 'commit')).toBe(false)
  })

  it('fails closed when a forbidden path remains staged after the safe reset', async () => {
    const calls: string[][] = []
    const git: GitRunner = {
      run: async (args) => {
        calls.push(args)
        if (args[0] === 'diff') {
          return { code: 0, stdout: '.claude/agent-memory/private.txt\0', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    const result = await commitWorktreeAndVerify(git, '/wt/ticket-1', 'unsafe commit')

    expect(result).toMatchObject({ staged: true, committed: false, clean: false })
    expect(result.error).toContain('forbidden paths remain staged')
    expect(calls.filter((call) => call[0] === 'diff')).toHaveLength(2)
    expect(calls.some((call) => call[0] === 'commit')).toBe(false)
  })

  it('fails closed when Git cannot unstage a forbidden path', async () => {
    const calls: string[][] = []
    const git: GitRunner = {
      run: async (args) => {
        calls.push(args)
        if (args[0] === 'diff') {
          return { code: 0, stdout: '.codex/agent-memory/private.txt\0', stderr: '' }
        }
        if (args[0] === 'reset') {
          return { code: 128, stdout: '', stderr: 'index is locked' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    const result = await commitWorktreeAndVerify(git, '/wt/ticket-1', 'unsafe commit')

    expect(result).toMatchObject({ staged: true, committed: false, clean: false })
    expect(result.error).toContain('index is locked')
    expect(calls.filter((call) => call[0] === 'diff')).toHaveLength(1)
    expect(calls.some((call) => call[0] === 'commit')).toBe(false)
  })

  it('preserves pre-staged forbidden working files while committing only allowed files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-safe-index-'))
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    const files = {
      allowed: 'src/allowed [1].txt',
      claude: '.claude/agent-memory/private.txt',
      codex: '.codex/agent-memory/private.txt',
      overlay: '.claude/rules/custom [1].md',
    }
    try {
      git(['init', '--quiet'])
      git(['config', 'user.email', 'specrails@example.test'])
      git(['config', 'user.name', 'Specrails Test'])
      fs.writeFileSync(path.join(dir, 'README.md'), 'base\n')
      git(['add', 'README.md'])
      git(['commit', '--quiet', '-m', 'base'])
      const hooksDir = path.join(dir, '.git', 'hooks')
      const hookMarker = path.join(dir, 'pre-commit-ran')
      const preCommit = path.join(hooksDir, 'pre-commit')
      fs.writeFileSync(preCommit, [
        '#!/bin/sh',
        `touch ${JSON.stringify(hookMarker)}`,
        `git add -- ${JSON.stringify(files.claude)}`,
      ].join('\n'))
      fs.chmodSync(preCommit, 0o755)
      for (const [name, relative] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true })
        fs.writeFileSync(path.join(dir, relative), `${name}\n`)
      }
      git(['add', '-A'])

      const result = await commitWorktreeAndVerify(
        defaultGitRunner,
        dir,
        'safe delivery',
        ['.claude/rules'],
      )

      expect(result).toMatchObject({ staged: true, committed: true, clean: true })
      const committed = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'])
        .slice(0, -1).split('\0')
      expect(committed).toEqual([files.allowed])
      expect(git(['diff', '--cached', '--name-only', '-z'])).toBe('')
      expect(fs.readFileSync(path.join(dir, files.claude), 'utf8')).toBe('claude\n')
      expect(fs.readFileSync(path.join(dir, files.codex), 'utf8')).toBe('codex\n')
      expect(fs.readFileSync(path.join(dir, files.overlay), 'utf8')).toBe('overlay\n')
      expect(fs.existsSync(hookMarker)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('removeWorktree', () => {
  it('removes the worktree and deletes its branch by default', async () => {
    const { git, calls } = fakeGit()
    await removeWorktree(git, { repoDir: '/repo', worktreePath: '/wt/ticket-1', branch: 'sr/p/ticket-1' })
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '/wt/ticket-1'])
    expect(calls).toContainEqual(['branch', '-D', 'sr/p/ticket-1'])
  })
  it('keeps the branch when deleteBranch is false', async () => {
    const { git, calls } = fakeGit()
    await removeWorktree(git, { repoDir: '/repo', worktreePath: '/wt/ticket-1', branch: 'sr/p/ticket-1', deleteBranch: false })
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '/wt/ticket-1'])
    expect(calls.some((c) => c[0] === 'branch')).toBe(false)
  })
  it('throws when git cannot remove the worktree', async () => {
    const { git, calls } = fakeGit({ removeFails: true })
    await expect(removeWorktree(git, { repoDir: '/repo', worktreePath: '/wt/ticket-1', branch: 'sr/p/ticket-1' })).rejects.toThrow(/dirty worktree/)
    expect(calls.some((c) => c[0] === 'branch')).toBe(false)
  })
})

describe('ensurePrNeverStageExcludes', () => {
  it('installs local git excludes for agent-memory and explanations idempotently', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-pr-exclude-'))
    const excludePath = path.join(dir, '.git', 'info', 'exclude')
    const git: GitRunner = {
      run: async (args) => {
        expect(args).toEqual(['rev-parse', '--git-path', 'info/exclude'])
        return { code: 0, stdout: `${excludePath}\n`, stderr: '' }
      },
    }

    await ensurePrNeverStageExcludes(git, dir)
    await ensurePrNeverStageExcludes(git, dir)

    const text = fs.readFileSync(excludePath, 'utf8')
    expect(text.match(/specrails: never stage private agent artifacts/g)).toHaveLength(2)
    expect(text.match(/\.claude\/agent-memory\/\*\*/g)).toHaveLength(1)
    expect(text).toContain('.claude/agent-memory/explanations/**')
    expect(text).toContain('.codex/agent-memory/**')
    expect(text).toContain('.gemini/agent-memory/**')
  })
})

describe('isGitRepo', () => {
  it('true inside a git work tree', async () => {
    const { git } = fakeGit({ insideWorktree: true })
    expect(await isGitRepo(git, '/repo')).toBe(true)
  })
  it('false when not a git repo', async () => {
    const { git } = fakeGit({ insideWorktree: false })
    expect(await isGitRepo(git, '/tmp/plain')).toBe(false)
  })
})

describe('repoIsolationStatus', () => {
  it('ok for a git repo with commits', async () => {
    const { git } = fakeGit({ insideWorktree: true, hasCommits: true })
    expect(await repoIsolationStatus(git, '/repo')).toBe('ok')
  })
  it('no-git when not a git repo', async () => {
    const { git } = fakeGit({ insideWorktree: false })
    expect(await repoIsolationStatus(git, '/tmp/plain')).toBe('no-git')
  })
  it('no-commits when HEAD is unborn (git init, no commit)', async () => {
    const { git } = fakeGit({ insideWorktree: true, hasCommits: false })
    expect(await repoIsolationStatus(git, '/repo')).toBe('no-commits')
  })
})

describe('removeWorktree', () => {
  it('removes the worktree and deletes the branch by default', async () => {
    const { git, calls } = fakeGit()
    await removeWorktree(git, { repoDir: '/repo', worktreePath: '/wt/ticket-1', branch: 'sr/p/ticket-1' })
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '/wt/ticket-1'])
    expect(calls).toContainEqual(['branch', '-D', 'sr/p/ticket-1'])
  })
  it('keeps the branch when deleteBranch=false (resume/needs-review)', async () => {
    const { git, calls } = fakeGit()
    await removeWorktree(git, { repoDir: '/repo', worktreePath: '/wt/ticket-1', branch: 'sr/p/ticket-1', deleteBranch: false })
    expect(calls.some((c) => c[0] === 'branch')).toBe(false)
  })
})

describe('listWorktrees', () => {
  it('parses porcelain output and excludes the main repo', async () => {
    const { git } = fakeGit({ worktrees: ['/wt/ticket-1', '/wt/ticket-2'] })
    expect(await listWorktrees(git, '/repo')).toEqual(['/wt/ticket-1', '/wt/ticket-2'])
  })
})
