import { describe, expect, it } from 'vitest'
import { gitInvocationEnv, gitSubcommand, isGitCommand, isReadOnlyGitInvocation } from './git-invocation'

describe('gitSubcommand', () => {
  it('skips global options and their values', () => {
    expect(gitSubcommand(['-c', 'core.quotepath=off', '-C', '/repo', '--literal-pathspecs', 'status'])?.name).toBe('status')
    expect(gitSubcommand(['--git-dir', '/x/.git', '--work-tree=/x', 'diff', '--stat'])).toEqual({ name: 'diff', rest: ['--stat'] })
    expect(gitSubcommand(['--no-optional-locks', '-P', 'log'])?.name).toBe('log')
  })

  it('returns null without a subcommand', () => {
    expect(gitSubcommand([])).toBeNull()
    expect(gitSubcommand(['-c', 'a=b'])).toBeNull()
  })
})

describe('isReadOnlyGitInvocation', () => {
  it.each([
    [['status', '--porcelain']], [['-c', 'core.quotepath=false', 'diff', '--numstat', 'a', 'b']], [['rev-parse', 'HEAD']],
    [['log', '-1']], [['merge-base', '--is-ancestor', 'a', 'b']], [['cat-file', '-e', 'x']], [['ls-files', '-z']],
    [['for-each-ref', 'refs/heads']], [['merge-tree', '--write-tree', 'a', 'b']], [['worktree', 'list', '--porcelain']],
    [['branch', '--format=%(refname)']], [['branch', '-vv']], [['branch', '--list', 'feat/*']], [['branch', '--show-current']],
    [['branch', '--contains', 'abc']], [['config', '--get', 'checkout.workers']], [['config', 'user.name']], [['config', 'get', 'user.name']],
    [['stash', 'create']], [['stash', 'list']], [['remote']], [['remote', 'get-url', 'origin']], [['symbolic-ref', 'HEAD']],
    [['symbolic-ref', '-q', '--short', 'HEAD']], [['tag', '-l']], [['check-ignore', '--stdin', '-z']],
  ])('reads: %j', (args) => {
    expect(isReadOnlyGitInvocation(args)).toBe(true)
  })

  it.each([
    [['add', '-A']], [['commit', '-m', 'x']], [['checkout', 'main']], [['worktree', 'add', '/p', 'main']], [['worktree', 'remove', '/p']],
    [['branch', 'new-branch']], [['branch', '-D', 'x']], [['branch', '-m', 'a', 'b']], [['config', 'user.name', 'Me']],
    [['config', '--unset', 'x']], [['symbolic-ref', 'HEAD', 'refs/heads/x']], [['stash', 'push']], [['stash']],
    [['remote', 'add', 'o', 'u']], [['fetch', 'origin']], [['merge', '--no-ff', 'b']], [['reset', '--hard']], [['update-ref', '-d', 'r', 's']],
    [['tag', 'v1']], [['unknown-subcommand']], [[]], [['-c', 'a=b']],
  ])('writes (or unknown): %j', (args) => {
    expect(isReadOnlyGitInvocation(args)).toBe(false)
  })
})

describe('gitInvocationEnv', () => {
  it('adds GIT_OPTIONAL_LOCKS=0 for reads without mutating the base', () => {
    const base = { PATH: '/bin' }
    const env = gitInvocationEnv(base, ['status'])
    expect(env).toEqual({ PATH: '/bin', GIT_OPTIONAL_LOCKS: '0' })
    expect(base).toEqual({ PATH: '/bin' })
  })

  it('keeps the base env (identity) for writes, including inherit', () => {
    const base = { PATH: '/bin' }
    expect(gitInvocationEnv(base, ['commit', '-m', 'x'])).toBe(base)
    expect(gitInvocationEnv(undefined, ['commit'])).toBeUndefined()
  })

  it('copies process.env when a read inherits', () => {
    const env = gitInvocationEnv(undefined, ['diff'])
    expect(env?.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(env).not.toBe(process.env)
  })
})

describe('isGitCommand', () => {
  it('matches git binaries only', () => {
    expect(isGitCommand('git')).toBe(true)
    expect(isGitCommand('/usr/bin/git')).toBe(true)
    expect(isGitCommand('C:/Git/cmd/GIT.EXE')).toBe(true)
    expect(isGitCommand('gh')).toBe(false)
    expect(isGitCommand('git-lfs')).toBe(false)
  })
})
