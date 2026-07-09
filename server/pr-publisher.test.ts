import { describe, it, expect } from 'vitest'
import { publishDraftPr, parsePrUrl, pushBranch, type Exec, type ExecResult } from './pr-publisher'

function fakeExec(handlers: {
  push?: ExecResult
  pr?: ExecResult
} = {}): { exec: Exec; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const ok: ExecResult = { code: 0, stdout: '', stderr: '' }
  const exec: Exec = {
    async run(cmd, args) {
      calls.push({ cmd, args })
      if (cmd === 'git' && args[0] === 'push') return handlers.push ?? ok
      if (cmd === 'gh' && args[0] === 'pr') return handlers.pr ?? ok
      return ok
    },
  }
  return { exec, calls }
}

const input = {
  repoDir: '/wt/ticket-1',
  branch: 'sr/p/ticket-1',
  baseBranch: 'main',
  title: 'T',
  body: 'B',
}

describe('parsePrUrl', () => {
  it('extracts a github pull URL', () => {
    expect(parsePrUrl('Creating pull request...\nhttps://github.com/o/r/pull/42\n')).toBe('https://github.com/o/r/pull/42')
  })
  it('returns undefined when absent', () => {
    expect(parsePrUrl('no url here')).toBeUndefined()
  })
})

describe('publishDraftPr degradation ladder', () => {
  it('pr-created: pushes then opens a draft PR and returns the URL', async () => {
    const { exec, calls } = fakeExec({ pr: { code: 0, stdout: 'https://github.com/o/r/pull/7\n', stderr: '' } })
    const r = await publishDraftPr(exec, input)
    expect(r).toEqual({ state: 'pr-created', branch: 'sr/p/ticket-1', prUrl: 'https://github.com/o/r/pull/7' })
    expect(calls[0]).toEqual({ cmd: 'git', args: ['push', '-u', 'origin', 'sr/p/ticket-1'] })
    expect(calls[1].args).toEqual(['pr', 'create', '--draft', '--base', 'main', '--head', 'sr/p/ticket-1', '--title', 'T', '--body', 'B'])
  })

  it('pushed: push ok but gh fails → degrades to pushed (never throws)', async () => {
    const { exec } = fakeExec({ pr: { code: 1, stdout: '', stderr: 'gh: not authenticated\n' } })
    const r = await publishDraftPr(exec, input)
    expect(r).toEqual({ state: 'pushed', branch: 'sr/p/ticket-1', reason: 'gh: not authenticated' })
  })

  it('pushed: gh exits 0 but prints no URL → pushed with no-url reason', async () => {
    const { exec } = fakeExec({ pr: { code: 0, stdout: 'done\n', stderr: '' } })
    const r = await publishDraftPr(exec, input)
    expect(r).toEqual({ state: 'pushed', branch: 'sr/p/ticket-1', reason: 'pr-created-no-url' })
  })

  it('local-only: push fails → local-only, gh is never called', async () => {
    const { exec, calls } = fakeExec({ push: { code: 128, stdout: '', stderr: 'fatal: No configured push destination\n' } })
    const r = await publishDraftPr(exec, input)
    expect(r).toEqual({ state: 'local-only', branch: 'sr/p/ticket-1', reason: 'fatal: No configured push destination' })
    expect(calls.some((c) => c.cmd === 'gh')).toBe(false)
  })

  it('honours a custom remote', async () => {
    const { exec, calls } = fakeExec({ pr: { code: 0, stdout: 'https://github.com/o/r/pull/9', stderr: '' } })
    await publishDraftPr(exec, { ...input, remote: 'upstream' })
    expect(calls[0].args).toEqual(['push', '-u', 'upstream', 'sr/p/ticket-1'])
  })
})

describe('pushBranch verified source', () => {
  it('pushes the exact verified commit to the named PR ref without resolving a mutable local branch', async () => {
    const { exec, calls } = fakeExec()
    const sha = 'b'.repeat(40)

    const result = await pushBranch(exec, { ...input, sourceSha: sha })

    expect(result).toEqual({ state: 'pushed', branch: input.branch })
    expect(calls).toEqual([{
      cmd: 'git',
      args: ['push', 'origin', `${sha}:refs/heads/${input.branch}`],
    }])
  })

  it('rejects an invalid source object id without invoking git', async () => {
    const { exec, calls } = fakeExec()
    const result = await pushBranch(exec, { ...input, sourceSha: 'HEAD:refs/heads/main' })
    expect(result).toEqual({ state: 'local-only', branch: input.branch, reason: 'invalid verified source commit' })
    expect(calls).toEqual([])
  })
})

describe('publishDraftPr — HTTPS credential fallback via gh', () => {
  // The exact failure observed in the wild: the machine's credential helper
  // (osxkeychain) is not on the app's PATH, so the HTTPS push can't authenticate.
  const credFail: ExecResult = {
    code: 128,
    stdout: '',
    stderr:
      "git: 'credential-osxkeychain' is not a git command.\n" +
      "fatal: could not read Username for 'https://github.com': Device not configured\n",
  }
  const GH_HELPER_RETRY = [
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!gh auth git-credential',
    'push',
    '-u',
    'origin',
    'sr/p/ticket-1',
  ]
  function isRetry(cmd: string, args: string[]): boolean {
    return cmd === 'git' && args.includes('credential.helper=!gh auth git-credential')
  }

  it('retries the push borrowing gh credentials when HTTPS auth fails, then opens the PR', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const exec: Exec = {
      async run(cmd, args) {
        calls.push({ cmd, args })
        if (isRetry(cmd, args)) return { code: 0, stdout: '', stderr: '' }
        if (cmd === 'git' && args[0] === 'push') return credFail
        if (cmd === 'gh' && args[0] === 'pr') return { code: 0, stdout: 'https://github.com/o/r/pull/5\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const r = await publishDraftPr(exec, input)
    expect(r).toEqual({ state: 'pr-created', branch: 'sr/p/ticket-1', prUrl: 'https://github.com/o/r/pull/5' })
    // The retry reset the inherited (broken) helper, then used gh — same refspec.
    const retry = calls.find((c) => isRetry(c.cmd, c.args))
    expect(retry?.args).toEqual(GH_HELPER_RETRY)
  })

  it('stays local-only when the gh-credential retry also fails (gh never asked to open a PR)', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const exec: Exec = {
      async run(cmd, args) {
        calls.push({ cmd, args })
        if (cmd === 'git') return credFail // both the initial push and the -c retry fail
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const r = await publishDraftPr(exec, input)
    expect(r.state).toBe('local-only')
    expect(calls.some((c) => c.cmd === 'gh')).toBe(false)
  })

  it('does NOT retry on a non-credential push failure', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const exec: Exec = {
      async run(cmd, args) {
        calls.push({ cmd, args })
        if (cmd === 'git' && args[0] === 'push') return { code: 128, stdout: '', stderr: 'fatal: No configured push destination\n' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const r = await publishDraftPr(exec, input)
    expect(r.state).toBe('local-only')
    expect(calls.filter((c) => c.cmd === 'git').length).toBe(1) // no gh-helper retry
  })
})
