import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultGitRunner } from '../../../../worktree-manager'
import type { HostTaskInvocation, HostTaskRequest } from '../../../agent-runtime/runtime/host-task-dispatcher'
import type { Exec, ExecResult } from '../pr-publisher'
import { boundLog, createPrCiHandlers, redactCiText, summarizeChecks, type PrCiTarget } from './pr-ci-handlers'

const GITHUB = 'https://github.com/acme/app.git'
// Fake credentials are assembled at runtime so the repository holds no secret-shaped literal.
const FAKE_TOKEN = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz123456'].join('')
const FAKE_BEARER = ['abcdefghij', 'klmnopqrstuvwx'].join('')
const PR_URL = 'https://github.com/acme/app/pull/7'
let root: string, remote: string, work: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim()
const commitFile = (cwd: string, file: string, text: string, message: string) => { writeFileSync(path.join(cwd, file), text); git(cwd, 'add', file); git(cwd, 'commit', '-qm', message) }

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pr-ci-'))
  remote = path.join(root, 'remote.git'); work = path.join(root, 'work')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  execFileSync('git', ['clone', '-q', remote, work])
  git(work, 'checkout', '-qb', 'main')
  commitFile(work, 'app.txt', 'base\n', 'base')
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'checkout', '-qb', 'feature')
  commitFile(work, 'feature.txt', 'feature\n', 'feature')
  git(work, 'push', '-q', 'origin', 'feature')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Real git (remote URL mapped to the bare repo), scripted gh. */
function fixture(gh: (args: string[]) => ExecResult = () => ({ code: 0, stdout: view({}), stderr: '' })) {
  const calls: string[][] = []
  const exec: Exec = { async run(cmd, args, cwd) {
    calls.push([cmd, ...args])
    if (cmd === 'gh') return gh(args)
    if (args[0] === 'remote' && args[1] === 'get-url') return { code: 0, stdout: GITHUB + '\n', stderr: '' }
    const mapped = args.map(arg => arg === GITHUB ? remote : arg)
    const result = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...mapped], { cwd, encoding: 'utf8' })
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
  } }
  const target: PrCiTarget = { deliveryId: 'd1', runId: 'run-1', prUrl: PR_URL, prNumber: 7, branch: 'feature', baseBranch: 'main', worktreePath: work, repoDir: work, overlayExcludes: [] }
  let clock = 0
  const handlers = createPrCiHandlers({ exec, git: defaultGitRunner, resolveTarget: id => id === 'run-1' ? target : null, withRepositoryLock: (_dir, fn) => fn(),
    timing: { initialDelayMs: 90_000, pollMinMs: 30_000, pollMaxMs: 120_000, timeoutMs: 600_000 }, now: () => clock, sleep: async ms => { clock += ms } })
  const invoke = (task: string, input: Record<string, unknown> = {}, extra: Partial<HostTaskRequest> = {}) => handlers[task]!({ projectId: 'p', runId: 'run-1', interruptId: 'i', signal: new AbortController().signal, log: () => {},
    request: { task, input, outcomes: [], effect: 'read', candidate: { hash: 'h', verified: true }, ...extra } } as HostTaskInvocation)
  return { invoke, calls, target, tick: () => clock }
}
function view(over: Record<string, unknown>): string {
  return JSON.stringify({ state: 'OPEN', isDraft: true, headRefName: 'feature', baseRefName: 'main', isCrossRepository: false, headRefOid: null, mergeCommit: null, commits: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [], ...over })
}
const headSha = () => git(work, 'rev-parse', 'HEAD')

describe('pr.update-base', () => {
  it('is clean when the PR already contains its base', async () => {
    expect(await fixture().invoke('pr.update-base', { reason: 'start' })).toMatchObject({ outcome: 'clean' })
  })

  it('leaves a merge prepared and unconfirmed on conflicts, and reports it again on replay', async () => {
    git(work, 'checkout', '-q', 'main'); commitFile(work, 'app.txt', 'main side\n', 'main'); git(work, 'push', '-q', 'origin', 'main')
    git(work, 'checkout', '-q', 'feature'); commitFile(work, 'app.txt', 'feature side\n', 'feature edit'); git(work, 'push', '-q', 'origin', 'feature')
    git(work, 'reset', '-q', '--hard', 'HEAD')
    const f = fixture()
    expect(await f.invoke('pr.update-base', { reason: 'conflict' })).toEqual({ outcome: 'conflicts', output: { paths: ['app.txt'], base: 'main' } })
    expect(existsSync(path.join(work, '.git', 'MERGE_HEAD'))).toBe(true)
    expect(await f.invoke('pr.update-base', { reason: 'conflict' })).toMatchObject({ outcome: 'conflicts' })
    expect(f.calls.some(call => call.includes('rebase'))).toBe(false)
  })

  it('keeps a conflict-free base merge only when GitHub reported a conflict', async () => {
    git(work, 'checkout', '-q', 'main'); commitFile(work, 'other.txt', 'x\n', 'main'); git(work, 'push', '-q', 'origin', 'main'); git(work, 'checkout', '-q', 'feature')
    expect(await fixture().invoke('pr.update-base', { reason: 'start' })).toMatchObject({ outcome: 'clean' })
    expect(existsSync(path.join(work, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(await fixture().invoke('pr.update-base', { reason: 'conflict' })).toMatchObject({ outcome: 'merged' })
    expect(existsSync(path.join(work, '.git', 'MERGE_HEAD'))).toBe(true)
  })

  it('merges a PR branch that moved on GitHub before anything else', async () => {
    const other = path.join(root, 'other'); execFileSync('git', ['clone', '-q', '-b', 'feature', remote, other])
    commitFile(other, 'remote.txt', 'r\n', 'remote change'); git(other, 'push', '-q', 'origin', 'feature')
    expect(await fixture().invoke('pr.update-base', {})).toMatchObject({ outcome: 'merged' })
    expect(readFileSync(path.join(work, 'remote.txt'), 'utf8')).toBe('r\n')
    expect(git(work, 'log', '-1', '--format=%s')).toContain('(run run-1)')
  })

  it('ends at closed for a closed PR, refuses a fork and an unresolved target', async () => {
    expect(await fixture(() => ({ code: 0, stdout: view({ state: 'MERGED' }), stderr: '' })).invoke('pr.update-base')).toMatchObject({ outcome: 'closed', output: { state: 'MERGED' } })
    expect(await fixture(() => ({ code: 0, stdout: view({ isCrossRepository: true }), stderr: '' })).invoke('pr.update-base')).toMatchObject({ outcome: 'failed', output: { detail: expect.stringContaining('fork') } })
    const handlers = createPrCiHandlers({ exec: { run: async () => ({ code: 0, stdout: '', stderr: '' }) }, git: defaultGitRunner, resolveTarget: () => null, withRepositoryLock: (_d, fn) => fn() })
    expect(await handlers['pr.update-base']!({ projectId: 'p', runId: 'unknown', interruptId: 'i', signal: new AbortController().signal, log: () => {},
      request: { task: 'pr.update-base', input: {}, outcomes: [], effect: 'write', candidate: { hash: null, verified: false } } })).toMatchObject({ outcome: 'failed', output: { detail: expect.stringContaining('could not be resolved') } })
  })
})

describe('pr.sync', () => {
  it('commits the verified candidate with the run marker and pushes it without force', async () => {
    writeFileSync(path.join(work, 'fix.txt'), 'fixed\n')
    const f = fixture()
    const result = await f.invoke('pr.sync', { summary: 'Fix CI: repair the test' })
    expect(result).toMatchObject({ outcome: 'pushed', output: { sha: headSha(), committed: true } })
    expect(git(work, 'log', '-1', '--format=%s')).toBe('Fix CI: repair the test (run run-1)')
    expect(git(remote, 'rev-parse', 'refs/heads/feature')).toBe(headSha())
    const push = f.calls.find(call => call[1] === 'push')!
    expect(push.some(arg => arg.startsWith('+') || arg === '--force' || arg === '-f')).toBe(false)
  })

  it('closes a prepared merge in the same commit', async () => {
    git(work, 'checkout', '-q', 'main'); commitFile(work, 'app.txt', 'main side\n', 'main'); git(work, 'push', '-q', 'origin', 'main'); git(work, 'checkout', '-q', 'feature')
    commitFile(work, 'app.txt', 'feature side\n', 'feature edit'); git(work, 'push', '-q', 'origin', 'feature')
    const f = fixture()
    await f.invoke('pr.update-base', { reason: 'conflict' })
    writeFileSync(path.join(work, 'app.txt'), 'main side\nfeature side\n')
    expect(await f.invoke('pr.sync', { summary: 'Merge the base branch' })).toMatchObject({ outcome: 'pushed' })
    expect(git(work, 'rev-list', '--parents', '-n1', 'HEAD').split(' ')).toHaveLength(3)
    expect(existsSync(path.join(work, '.git', 'MERGE_HEAD'))).toBe(false)
  })

  it('is idempotent when the remote already has the commit', async () => {
    const f = fixture()
    expect(await f.invoke('pr.sync', {})).toMatchObject({ outcome: 'pushed', output: { committed: false } })
    expect(await f.invoke('pr.sync', {})).toMatchObject({ outcome: 'pushed' })
  })

  it('reports diverged when the PR branch moved, and never pushes an unverified candidate', async () => {
    const other = path.join(root, 'other'); execFileSync('git', ['clone', '-q', '-b', 'feature', remote, other])
    commitFile(other, 'remote.txt', 'r\n', 'remote change'); git(other, 'push', '-q', 'origin', 'feature')
    writeFileSync(path.join(work, 'fix.txt'), 'fixed\n')
    const f = fixture()
    expect(await f.invoke('pr.sync', {})).toMatchObject({ outcome: 'diverged' })
    const unverified = fixture()
    expect(await unverified.invoke('pr.sync', {}, { candidate: { hash: 'h', verified: false } })).toMatchObject({ outcome: 'rejected' })
    expect(unverified.calls.some(call => call[1] === 'push')).toBe(false)
  })

  it('refuses a closed PR and a mismatched push remote', async () => {
    expect(await fixture(() => ({ code: 0, stdout: view({ state: 'CLOSED' }), stderr: '' })).invoke('pr.sync')).toMatchObject({ outcome: 'closed' })
  })
})

describe('pr.checks', () => {
  const rollup = (items: unknown[], over: Record<string, unknown> = {}) => ({ code: 0, stdout: view({ headRefOid: headSha(), statusCheckRollup: items, ...over }), stderr: '' })
  it('waits for pending checks and reports green', async () => {
    let calls = 0
    const f = fixture(args => args[0] === 'pr' ? rollup(++calls < 3 ? [{ name: 'test', status: 'IN_PROGRESS', conclusion: null }] : [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }]) : { code: 1, stdout: '', stderr: '' })
    expect(await f.invoke('pr.checks')).toMatchObject({ outcome: 'green', output: { checks: 1 } })
    expect(calls).toBe(3)
  })

  it('reports red with bounded, redacted failed-job logs', async () => {
    const url = 'https://github.com/acme/app/actions/runs/111/job/222'
    const f = fixture(args => args[0] === 'run'
      ? { code: 0, stdout: 'x'.repeat(40_000) + '\nError: token=' + FAKE_TOKEN + ' expected 1 got 2', stderr: '' }
      : rollup([{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: url }, { context: 'ci/external', state: 'ERROR', targetUrl: 'https://ci.example/1', description: 'boom' }]))
    const result = await f.invoke('pr.checks') as { outcome: string; output: { failures: Array<Record<string, unknown>> } }
    expect(result.outcome).toBe('red')
    const [job, external] = result.output.failures
    expect(job).toMatchObject({ name: 'test', conclusion: 'FAILURE', url })
    expect(Buffer.byteLength(String(job.log))).toBeLessThanOrEqual(32 * 1024 + 32)
    expect(String(job.log)).toContain('expected 1 got 2')
    expect(String(job.log)).not.toContain(FAKE_TOKEN)
    expect(external).toMatchObject({ name: 'ci/external', external: true, summary: 'boom' })
    expect(f.calls.find(call => call[1] === 'run')).toEqual(['gh', 'run', 'view', '111', '--job', '222', '--log-failed'])
  })

  it('reports none after the grace period, timeout, conflict and closed', async () => {
    expect(await fixture(() => rollup([])).invoke('pr.checks')).toMatchObject({ outcome: 'none' })
    const slow = fixture(() => rollup([{ name: 'test', status: 'QUEUED', conclusion: null }]))
    expect(await slow.invoke('pr.checks', {}, { timeoutMs: 120_000 })).toMatchObject({ outcome: 'timeout' })
    expect(slow.tick()).toBeGreaterThanOrEqual(120_000)
    expect(await fixture(() => rollup([], { mergeable: 'CONFLICTING' })).invoke('pr.checks')).toMatchObject({ outcome: 'conflict' })
    expect(await fixture(() => rollup([], { state: 'MERGED' })).invoke('pr.checks')).toMatchObject({ outcome: 'closed' })
    expect(await fixture(() => rollup([], { headRefOid: 'f'.repeat(40) })).invoke('pr.checks')).toMatchObject({ outcome: 'conflict', output: { detail: expect.stringContaining('moved') } })
  })
})

describe('pr.rerun-failed', () => {
  it('re-runs the failed Actions runs of the current checks', async () => {
    const f = fixture(args => args[0] === 'pr'
      ? { code: 0, stdout: view({ statusCheckRollup: [{ name: 'a', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/5/job/6' }] }), stderr: '' }
      : { code: 0, stdout: '', stderr: '' })
    expect(await f.invoke('pr.rerun-failed')).toEqual({ outcome: 'ok', output: { rerun: ['5'] } })
    expect(f.calls).toContainEqual(['gh', 'run', 'rerun', '5', '--failed'])
  })
})

describe('evidence helpers', () => {
  it('redacts credentials and keeps the end of a long log', () => {
    expect(redactCiText(`Authorization: Bearer ${FAKE_BEARER} and https://${['u', 'p'].join(':')}@host/x ${['API', 'KEY'].join('_')}=${'sec' + 'ret'}`)).not.toMatch(/abcdefghijklmnop|u:p@|=secret/)
    expect(boundLog('a'.repeat(100) + 'END', 10)).toMatch(/END$/)
    expect(summarizeChecks([{ name: 'x', status: 'COMPLETED', conclusion: 'SKIPPED' }])).toEqual({ total: 1, pending: 0, failures: [] })
    expect(summarizeChecks('nope')).toEqual({ total: 0, pending: 0, failures: [] })
  })
})
