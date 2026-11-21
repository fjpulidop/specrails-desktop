import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { initDb, type DbInstance } from '../../../db'
import { createLoopRun } from '../../loops/runtime/loop-runs-store'
import { EnvFilesUnavailableError, enableEnvFilesForRun } from './run-env-files'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()

let root: string, db: DbInstance
function repoWithWorktree(name: string, envText: string | null): { repo: string; worktree: string } {
  const repo = path.join(root, name), worktree = path.join(root, `${name}-wt`)
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env*\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'i')
  if (envText !== null) fs.writeFileSync(path.join(repo, '.env'), envText)
  git(repo, 'worktree', 'add', '-q', '-b', `run-${name}`, worktree)
  return { repo, worktree }
}
function seed(request: Record<string, unknown>) {
  createLoopRun(db, { id: 'run', projectId: 'p', loopId: 'loop', loopName: 'Implement', railIndex: null, ticketId: null, provider: 'claude', model: 'sonnet', iterationLimit: 1, startedAt: new Date().toISOString() })
  db.prepare("UPDATE loop_runs SET engine_version = 2, status = 'completed', final_outcome = 'failed', run_request_json = ?, runtime_metadata_json = '{\"source\":\"definition\"}' WHERE id = 'run'")
    .run(JSON.stringify({ runId: 'run', projectId: 'p', loopId: 'loop', cwd: root, ...request }))
}

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run env files '))); db = initDb(':memory:') })
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })

describe('enableEnvFilesForRun', () => {
  it('multi-repository run: each worktree gets the files of its own repository', async () => {
    const api = repoWithWorktree('api', 'API_KEY=api-only-secret-value\n'), web = repoWithWorktree('web', 'WEB_KEY=web-only-secret-value\n')
    const docs = repoWithWorktree('docs', null)
    seed({ executionManifest: { version: 1, repositories: [api, web, docs].map((r, i) => ({ repositoryId: `r${i}`, sourcePath: '/elsewhere', worktreePath: r.worktree })) } })
    const project = { id: 'p', path: api.repo, slug: 'p', repositories: [api, web, docs].map((r, i) => ({ id: `r${i}`, projectId: 'p', name: `r${i}`, path: r.repo, isPrimary: i === 0, kind: 'git' as const, integrationBranch: null, addedAt: '' })) }
    const enable = vi.fn()
    const result = await enableEnvFilesForRun({ db, project: project as never }, 'run', { enable })
    expect(enable).toHaveBeenCalledTimes(1)
    expect(result.copied).toEqual(['.env'])
    expect(fs.readFileSync(path.join(api.worktree, '.env'), 'utf8')).toBe('API_KEY=api-only-secret-value\n')
    expect(fs.readFileSync(path.join(web.worktree, '.env'), 'utf8')).toBe('WEB_KEY=web-only-secret-value\n')
    expect(fs.existsSync(path.join(docs.worktree, '.env'))).toBe(false)
  })

  it('never copies from a repository outside the project, whatever the run request names', async () => {
    const mine = repoWithWorktree('mine', null), foreign = repoWithWorktree('foreign', 'SECRET=not-this-project\n')
    seed({ isolation: { branch: 'x', worktreePath: foreign.worktree } })
    fs.writeFileSync(path.join(mine.repo, '.env'), 'MINE=own-project-value\n')
    const result = await enableEnvFilesForRun({ db, project: { id: 'p', path: mine.repo, slug: 'p' } as never }, 'run', { enable: () => {} })
    expect(result.copied).toEqual([])
    expect(fs.existsSync(path.join(foreign.worktree, '.env'))).toBe(false)
  })

  it('refuses before changing anything when no project repository has an env file', async () => {
    const only = repoWithWorktree('only', null)
    seed({ isolation: { branch: 'x', worktreePath: only.worktree } })
    const enable = vi.fn()
    await expect(enableEnvFilesForRun({ db, project: { id: 'p', path: only.repo, slug: 'p' } as never }, 'run', { enable })).rejects.toBeInstanceOf(EnvFilesUnavailableError)
    expect(enable).not.toHaveBeenCalled()
  })
})
