import { describe, expect, it, vi } from 'vitest'
import type { Exec, ExecResult } from '../pr-publisher'
import type { RepositoryProject } from '../../../../project-repositories'
import type { PrCiAdmissionRow, PrCiAdmissionTarget } from './pr-ci-admission'
import { runPrCiOnPr, type PrCiOnDemandDeps, type PrCiOnDemandProject } from './pr-ci-on-demand'

const SHA = 'b'.repeat(40)
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' })
const project = (id: string, path: string): RepositoryProject & { name: string } => ({
  id, name: id.toUpperCase(), path, primaryRepositoryId: `r-${id}`,
  repositories: [{ id: `r-${id}`, projectId: id, name: id, path, isPrimary: true, kind: 'git', integrationBranch: null, addedAt: '' }],
})

function fixture(opts: { remotes: Record<string, string>; push?: string; view?: Record<string, unknown>; start?: 'ok' | 'running' | 'fail' }) {
  const calls: string[] = []
  const exec: Exec = {
    async run(cmd, args, cwd) {
      calls.push(`${cmd} ${args[0]} ${cwd}`)
      if (cmd === 'git') return opts.remotes[cwd] ? ok(opts.remotes[cwd]) : { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'api') return ok(opts.push ?? 'true')
      return ok(JSON.stringify({ state: 'OPEN', headRefName: 'fix/ci', baseRefName: 'main', isCrossRepository: false, headRefOid: SHA, ...opts.view }))
    },
  }
  const admitted: PrCiAdmissionTarget[] = []
  const missions: string[] = []
  const runtime = {
    unavailable: vi.fn(async () => null),
    admit: vi.fn((target: PrCiAdmissionTarget) => {
      admitted.push(target)
      return { ok: true as const, admission: { id: 'adm-1', origin_conversation_id: target.originConversationId } as PrCiAdmissionRow }
    }),
    start: vi.fn(async () => opts.start === 'running' ? { ok: false as const, status: 409, error: 'pr_ci_already_running', detail: 'running', runId: 'run-old' }
      : opts.start === 'fail' ? { ok: false as const, status: 409, error: 'isolation_failed', detail: 'no worktree' }
        : { ok: true as const, admission: {} as PrCiAdmissionRow, runId: 'run-1' }),
  }
  const contexts: PrCiOnDemandProject[] = [{ project: project('web', '/w/web') }, { project: project('api', '/w/api') }]
  const deps: PrCiOnDemandDeps<PrCiOnDemandProject> = {
    exec, contexts: () => contexts, runtimeOf: () => runtime,
    missionFor: (context) => { missions.push(context.project.id); return `conv-${context.project.id}` },
  }
  return { deps, runtime, admitted, missions, calls }
}

const URL = 'https://github.com/acme/api/pull/9'

describe('runPrCiOnPr', () => {
  it('picks the project by the PR repository, opens its mission and starts the built-in run', async () => {
    const f = fixture({ remotes: { '/w/web': 'git@github.com:acme/web.git', '/w/api': 'git@github.com:acme/api.git' } })
    const result = await runPrCiOnPr(f.deps, { prUrl: URL })
    expect(result).toEqual({ ok: true, status: 202, projectId: 'api', conversationId: 'conv-api', admissionId: 'adm-1', runId: 'run-1', alreadyRunning: false })
    expect(f.admitted[0]).toMatchObject({ projectId: 'api', prNumber: 9, headBranch: 'fix/ci', originConversationId: 'conv-api' })
    expect(f.runtime.start).toHaveBeenCalledWith('adm-1')
  })

  it('refuses before creating a mission when the account cannot push', async () => {
    const f = fixture({ remotes: { '/w/api': 'git@github.com:acme/api.git' }, push: 'false' })
    const result = await runPrCiOnPr(f.deps, { prUrl: URL })
    expect(result).toMatchObject({ ok: false, status: 403, error: 'pr_no_push_access' })
    expect(f.missions).toEqual([])
    expect(f.runtime.start).not.toHaveBeenCalled()
  })

  it('refuses a closed or fork PR before creating a mission', async () => {
    for (const view of [{ state: 'MERGED' }, { isCrossRepository: true }]) {
      const f = fixture({ remotes: { '/w/api': 'git@github.com:acme/api.git' }, view })
      expect((await runPrCiOnPr(f.deps, { prUrl: URL })).ok).toBe(false)
      expect(f.missions).toEqual([])
    }
  })

  it('says which repository is missing when no project has it, and asks to choose when several do', async () => {
    const none = fixture({ remotes: { '/w/web': 'git@github.com:acme/web.git' } })
    expect(await runPrCiOnPr(none.deps, { prUrl: URL })).toMatchObject({ status: 404, error: 'pr_repository_not_in_any_project' })
    const both = fixture({ remotes: { '/w/web': 'git@github.com:acme/api.git', '/w/api': 'https://github.com/acme/api.git' } })
    const ambiguous = await runPrCiOnPr(both.deps, { prUrl: URL })
    expect(ambiguous).toMatchObject({ status: 409, error: 'pr_project_ambiguous', projects: [{ id: 'web', name: 'WEB' }, { id: 'api', name: 'API' }] })
    expect(await runPrCiOnPr(both.deps, { prUrl: URL, projectId: 'web' })).toMatchObject({ ok: true, projectId: 'web' })
  })

  it('rejects a malformed URL and an unknown project without calling GitHub', async () => {
    const f = fixture({ remotes: {} })
    expect(await runPrCiOnPr(f.deps, { prUrl: 'acme/api#9' })).toMatchObject({ status: 400, error: 'pr_url_invalid' })
    expect(await runPrCiOnPr(f.deps, { prUrl: URL, projectId: 'nope' })).toMatchObject({ status: 404, error: 'project_not_found' })
    expect(f.calls.filter(call => call.startsWith('gh'))).toEqual([])
  })

  it('stops on an unavailable engine before touching GitHub for the PR', async () => {
    const f = fixture({ remotes: { '/w/api': 'git@github.com:acme/api.git' } })
    f.runtime.unavailable.mockResolvedValueOnce({ ok: false, status: 409, error: 'engine_unsupported', detail: 'Update Core' } as never)
    expect(await runPrCiOnPr(f.deps, { prUrl: URL })).toMatchObject({ status: 409, error: 'engine_unsupported' })
    expect(f.calls.filter(call => call.startsWith('gh'))).toEqual([])
  })

  it('opens the running repair instead of starting a second one, and reports a failed start with its mission', async () => {
    const running = fixture({ remotes: { '/w/api': 'git@github.com:acme/api.git' }, start: 'running' })
    expect(await runPrCiOnPr(running.deps, { prUrl: URL })).toMatchObject({ ok: true, status: 200, runId: 'run-old', alreadyRunning: true, conversationId: 'conv-api' })
    const failed = fixture({ remotes: { '/w/api': 'git@github.com:acme/api.git' }, start: 'fail' })
    expect(await runPrCiOnPr(failed.deps, { prUrl: URL })).toMatchObject({ ok: false, error: 'isolation_failed', conversationId: 'conv-api', projectId: 'api' })
  })
})
