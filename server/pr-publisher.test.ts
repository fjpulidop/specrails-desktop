import { describe, it, expect } from 'vitest'
import { publishDraftPr, parsePrUrl, type Exec, type ExecResult } from './pr-publisher'

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
