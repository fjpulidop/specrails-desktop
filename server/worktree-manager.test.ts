import { describe, it, expect } from 'vitest'
import {
  worktreeBranch,
  worktreePath,
  createWorktree,
  removeWorktree,
  listWorktrees,
  commitWorktree,
  isGitRepo,
  type GitRunner,
  type GitResult,
} from './worktree-manager'

function fakeGit(opts: { worktrees?: string[]; branchExists?: boolean; addFails?: boolean; insideWorktree?: boolean } = {}) {
  const calls: string[][] = []
  const git: GitRunner = {
    async run(args): Promise<GitResult> {
      calls.push(args)
      if (args[0] === 'worktree' && args[1] === 'list') {
        const lines = ['worktree /repo', ...(opts.worktrees ?? []).map((p) => `worktree ${p}`)]
        return { code: 0, stdout: lines.join('\n') + '\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) {
        return opts.insideWorktree === false ? { code: 128, stdout: '', stderr: 'not a git repo' } : { code: 0, stdout: 'true\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return opts.branchExists ? { code: 0, stdout: 'sha\n', stderr: '' } : { code: 1, stdout: '', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return opts.addFails ? { code: 1, stdout: '', stderr: 'fatal: boom' } : { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const addCalls = () => calls.filter((c) => c[0] === 'worktree' && c[1] === 'add')
  return { git, calls, addCalls }
}

const base = { repoDir: '/repo', worktreesRoot: '/wt', slug: 'p', ticketId: 3 }

describe('worktree path/branch helpers', () => {
  it('builds the stable branch + path', () => {
    expect(worktreeBranch('myproject', 7)).toBe('sr/myproject/ticket-7')
    expect(worktreePath('/home/u/.specrails/projects/myproject/worktrees', 7)).toBe('/home/u/.specrails/projects/myproject/worktrees/ticket-7')
  })
})

describe('createWorktree (resume-aware)', () => {
  it('creates a fresh branch off base when neither worktree nor branch exists', async () => {
    const { git, addCalls } = fakeGit()
    const h = await createWorktree(git, base)
    expect(h).toEqual({ branch: 'sr/p/ticket-3', worktreePath: '/wt/ticket-3' })
    expect(addCalls()[0]).toEqual(['worktree', 'add', '-b', 'sr/p/ticket-3', '/wt/ticket-3', 'HEAD'])
  })

  it('honours an explicit baseRef on a fresh create', async () => {
    const { git, addCalls } = fakeGit()
    await createWorktree(git, { ...base, baseRef: 'abc123' })
    expect(addCalls()[0]?.[addCalls()[0].length - 1]).toBe('abc123')
  })

  it('REUSES an existing worktree (resume) without re-adding', async () => {
    const { git, addCalls } = fakeGit({ worktrees: ['/wt/ticket-3'] })
    const h = await createWorktree(git, base)
    expect(h.worktreePath).toBe('/wt/ticket-3')
    expect(addCalls()).toHaveLength(0) // reused, not recreated
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
})

describe('commitWorktree', () => {
  it('stages + commits the worktree to its branch', async () => {
    const { git, calls } = fakeGit()
    await commitWorktree(git, '/wt/ticket-1', 'wip')
    expect(calls).toContainEqual(['add', '-A'])
    expect(calls).toContainEqual(['commit', '-m', 'wip'])
  })
  it('never throws even if git fails', async () => {
    const git: GitRunner = { run: async () => { throw new Error('git gone') } }
    await expect(commitWorktree(git, '/wt/1', 'x')).resolves.toBeUndefined()
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
