import { describe, it, expect } from 'vitest'
import {
  worktreeBranch,
  worktreePath,
  createWorktree,
  removeWorktree,
  listWorktrees,
  type GitRunner,
  type GitResult,
} from './worktree-manager'

function fakeGit(handler?: (args: string[]) => Partial<GitResult>) {
  const calls: string[][] = []
  const git: GitRunner = {
    async run(args) {
      calls.push(args)
      const r = handler?.(args) ?? {}
      return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
  }
  return { git, calls }
}

describe('worktree path/branch helpers', () => {
  it('builds the stable branch + path', () => {
    expect(worktreeBranch('myproject', 7)).toBe('sr/myproject/ticket-7')
    expect(worktreePath('/home/u/.specrails/projects/myproject/worktrees', 7)).toBe(
      '/home/u/.specrails/projects/myproject/worktrees/ticket-7'
    )
  })
})

describe('createWorktree', () => {
  it('runs `worktree add -B <branch> <path> <base>` and returns the handle', async () => {
    const { git, calls } = fakeGit()
    const h = await createWorktree(git, { repoDir: '/repo', worktreesRoot: '/wt', slug: 'p', ticketId: 3 })
    expect(h).toEqual({ branch: 'sr/p/ticket-3', worktreePath: '/wt/ticket-3' })
    expect(calls[0]).toEqual(['worktree', 'add', '-B', 'sr/p/ticket-3', '/wt/ticket-3', 'HEAD'])
  })

  it('honours an explicit baseRef', async () => {
    const { git, calls } = fakeGit()
    await createWorktree(git, { repoDir: '/repo', worktreesRoot: '/wt', slug: 'p', ticketId: 1, baseRef: 'abc123' })
    expect(calls[0]?.[calls[0].length - 1]).toBe('abc123')
  })

  it('throws on git failure (so the caller can fall back)', async () => {
    const { git } = fakeGit(() => ({ code: 1, stderr: 'fatal: boom' }))
    await expect(createWorktree(git, { repoDir: '/repo', worktreesRoot: '/wt', slug: 'p', ticketId: 9 })).rejects.toThrow(/boom/)
  })
})

describe('removeWorktree', () => {
  it('removes the worktree and deletes the branch by default', async () => {
    const { git, calls } = fakeGit()
    await removeWorktree(git, { repoDir: '/repo', worktreePath: '/wt/ticket-1', branch: 'sr/p/ticket-1' })
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '/wt/ticket-1'])
    expect(calls).toContainEqual(['branch', '-D', 'sr/p/ticket-1'])
  })

  it('keeps the branch when deleteBranch=false (needs-review)', async () => {
    const { git, calls } = fakeGit()
    await removeWorktree(git, { repoDir: '/repo', worktreePath: '/wt/ticket-1', branch: 'sr/p/ticket-1', deleteBranch: false })
    expect(calls.some((c) => c[0] === 'branch')).toBe(false)
  })
})

describe('listWorktrees', () => {
  it('parses porcelain output and excludes the main repo', async () => {
    const { git } = fakeGit((args) =>
      args[0] === 'worktree' && args[1] === 'list'
        ? { stdout: 'worktree /repo\nHEAD x\n\nworktree /wt/ticket-1\nHEAD y\n\nworktree /wt/ticket-2\nHEAD z\n' }
        : {}
    )
    const list = await listWorktrees(git, '/repo')
    expect(list).toEqual(['/wt/ticket-1', '/wt/ticket-2'])
  })

  it('returns [] on git failure', async () => {
    const { git } = fakeGit(() => ({ code: 1 }))
    expect(await listWorktrees(git, '/repo')).toEqual([])
  })
})
