import { describe, expect, it } from 'vitest'
import type { Exec, ExecResult } from '../pr-publisher'
import type { RepositoryProject } from '../../../../project-repositories'
import { classifyGithubFailure, parsePrUrl, PrCiResolveError, remoteIdentity, resolveProjectPrTarget } from './pr-ci-resolver'

const SHA = 'a'.repeat(40)
const project: RepositoryProject = {
  id: 'p1', path: '/work/app', primaryRepositoryId: 'r-app',
  repositories: [
    { id: 'r-app', projectId: 'p1', name: 'app', path: '/work/app', isPrimary: true, kind: 'git', integrationBranch: null, addedAt: '' },
    { id: 'r-api', projectId: 'p1', name: 'api', path: '/work/api', isPrimary: false, kind: 'git', integrationBranch: null, addedAt: '' },
  ],
}
const remotes: Record<string, string> = { '/work/app': 'git@github.com:acme/app.git', '/work/api': 'https://github.com/acme/api.git' }
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' })
const view = (over: Record<string, unknown> = {}) => ok(JSON.stringify({ state: 'OPEN', isDraft: false, headRefName: 'fix/ci', baseRefName: 'main', isCrossRepository: false, headRefOid: SHA, ...over }))

function exec(prView: ExecResult, push: ExecResult = ok('true\n')) {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = []
  const value: Exec = {
    async run(cmd, args, cwd) {
      calls.push({ cmd, args, cwd })
      if (cmd === 'git') return remotes[cwd] ? ok(remotes[cwd] + '\n') : { code: 1, stdout: '', stderr: 'no remote' }
      if (args[0] === 'api') return push
      return prView
    },
  }
  return { value, calls }
}
const failure = async (promise: Promise<unknown>) => { try { await promise } catch (error) { return error as PrCiResolveError } throw new Error('expected rejection') }

describe('PR URL and remote parsing', () => {
  it('accepts a full pull request URL and rejects anything else', () => {
    expect(parsePrUrl('https://github.com/Acme/App/pull/12/')).toMatchObject({ slug: 'acme/app', prNumber: 12, url: 'https://github.com/Acme/App/pull/12' })
    for (const bad of ['12', 'https://github.com/acme/app/issues/3', 'http://github.com/acme/app/pull/1', 'https://github.com/acme/app/pull/0'])
      expect(() => parsePrUrl(bad)).toThrow(PrCiResolveError)
  })
  it('normalizes https, ssh and scp remotes to the same identity', () => {
    const expected = 'github.com/acme/app'
    for (const remote of ['https://github.com/acme/app.git', 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app', 'https://user@github.com/acme/app/'])
      expect(remoteIdentity(remote)).toBe(expected)
  })
})

describe('resolveProjectPrTarget', () => {
  it('[spec:mission-pr-ci-repair/mission-prepares-a-ci-repair-offer-from-a-project-pr-url] freezes the secondary repository identity and queries only that repository', async () => {
    const e = exec(view())
    const target = await resolveProjectPrTarget({ exec: e.value, project, prUrl: 'https://github.com/acme/api/pull/7', originConversationId: 'c1' })
    expect(target).toMatchObject({ projectId: 'p1', repositoryId: 'r-api', repositoryPath: '/work/api', prNumber: 7, headBranch: 'fix/ci', baseBranch: 'main', headSha: SHA, originConversationId: 'c1' })
    expect(e.calls.filter(call => call.cmd === 'gh').map(call => call.cwd)).toEqual(['/work/api', '/work/api'])
  })
  it('[spec:mission-pr-ci-repair/pr-validation-reports-a-specific-reason-before-any-agent-starts] refuses a repository outside the project before calling GitHub', async () => {
    const e = exec(view())
    const error = await failure(resolveProjectPrTarget({ exec: e.value, project, prUrl: 'https://github.com/other/thing/pull/1' }))
    expect(error.code).toBe('pr_repository_not_in_project')
    expect(e.calls.some(call => call.cmd === 'gh')).toBe(false)
  })
  it('[spec:mission-pr-ci-repair/pr-validation-reports-a-specific-reason-before-any-agent-starts] refuses an ambiguous origin match', async () => {
    const e = exec(view())
    remotes['/work/api'] = 'https://github.com/acme/app.git'
    try { expect((await failure(resolveProjectPrTarget({ exec: e.value, project, prUrl: 'https://github.com/acme/app/pull/1' }))).code).toBe('pr_repository_ambiguous') }
    finally { remotes['/work/api'] = 'https://github.com/acme/api.git' }
  })
  it.each([['CLOSED', 'closed'], ['MERGED', 'merged']])('names a %s pull request', async (state, word) => {
    const error = await failure(resolveProjectPrTarget({ exec: exec(view({ state })).value, project, prUrl: 'https://github.com/acme/app/pull/1' }))
    expect(error).toMatchObject({ code: 'pr_not_open' })
    expect(error.message).toContain(word)
  })
  it('[spec:mission-pr-ci-repair/fork-prs-are-rejected-with-the-concrete-limitation] rejects a fork PR with the concrete limitation', async () => {
    const error = await failure(resolveProjectPrTarget({ exec: exec(view({ isCrossRepository: true })).value, project, prUrl: 'https://github.com/acme/app/pull/1' }))
    expect(error.code).toBe('pr_fork_unsupported')
    expect(error.message).toMatch(/fork branches are not writable/)
  })
  it('[spec:mission-pr-ci-repair/pr-validation-reports-a-specific-reason-before-any-agent-starts] rejects unusable refs', async () => {
    const error = await failure(resolveProjectPrTarget({ exec: exec(view({ headRefName: 'main' })).value, project, prUrl: 'https://github.com/acme/app/pull/1' }))
    expect(error.code).toBe('target_pr_invalid')
  })
  it('[spec:mission-pr-ci-repair/pr-validation-reports-a-specific-reason-before-any-agent-starts] reports an authentication failure as unavailable, never as a missing PR', async () => {
    const e = exec({ code: 1, stdout: '', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login' })
    expect((await failure(resolveProjectPrTarget({ exec: e.value, project, prUrl: 'https://github.com/acme/app/pull/1' }))).code).toBe('pr_github_unavailable')
  })
  it('[spec:mission-pr-ci-repair/pr-validation-reports-a-specific-reason-before-any-agent-starts] reports a missing PR as not found', async () => {
    const e = exec({ code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 9.' })
    expect((await failure(resolveProjectPrTarget({ exec: e.value, project, prUrl: 'https://github.com/acme/app/pull/9' }))).code).toBe('target_pr_not_found')
  })
})

describe('classifyGithubFailure', () => {
  it.each(['dial tcp: lookup api.github.com: no such host', 'HTTP 401: Bad credentials', 'timeout'])('treats "%s" as unavailable', detail => {
    expect(classifyGithubFailure(detail).code).toBe('pr_github_unavailable')
  })
})

describe('push access', () => {
  const prUrl = 'https://github.com/acme/app/pull/1'
  it('asks GitHub for the repository permission from the matched repository and proceeds on push=true', async () => {
    const e = exec(view())
    await resolveProjectPrTarget({ exec: e.value, project, prUrl })
    expect(e.calls).toContainEqual({ cmd: 'gh', args: ['api', 'repos/acme/app', '--jq', '.permissions.push'], cwd: '/work/app' })
  })
  it('refuses with pr_no_push_access (403) when the account cannot push, before anything starts', async () => {
    for (const answer of ['false\n', 'null\n', ''] ) {
      const error = await failure(resolveProjectPrTarget({ exec: exec(view(), ok(answer)).value, project, prUrl }))
      expect(error).toMatchObject({ code: 'pr_no_push_access', status: 403 })
    }
  })
  it('treats a failed or unreadable permission answer as GitHub unavailable, never as access', async () => {
    expect(await failure(resolveProjectPrTarget({ exec: exec(view(), { code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' }).value, project, prUrl }))).toMatchObject({ code: 'pr_github_unavailable' })
    expect(await failure(resolveProjectPrTarget({ exec: exec(view(), ok('maybe')).value, project, prUrl }))).toMatchObject({ code: 'pr_github_unavailable' })
  })
  it('names the host for GitHub Enterprise', async () => {
    const enterprise: RepositoryProject = { ...project, repositories: [{ ...project.repositories![0], path: '/work/ghe' }] , path: '/work/ghe' }
    remotes['/work/ghe'] = 'git@ghe.acme.io:acme/app.git'
    const e = exec(view())
    await resolveProjectPrTarget({ exec: e.value, project: enterprise, prUrl: 'https://ghe.acme.io/acme/app/pull/3' })
    expect(e.calls.find(call => call.args[0] === 'api')?.args).toEqual(['api', '--hostname', 'ghe.acme.io', 'repos/acme/app', '--jq', '.permissions.push'])
  })
})
