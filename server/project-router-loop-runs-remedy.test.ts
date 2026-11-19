import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from './db'
import { createLoopRun } from './modules/loops/runtime/loop-runs-store'
import { serializeDiagnosis } from './modules/recovery'
import { registerLoopRunRoutes } from './project-router-loop-runs'
import type { ProjectRoutesDeps } from './project-router-helpers'

const order: string[] = []
const runtime = vi.hoisted(() => ({ probe: vi.fn(), fork: vi.fn(), prepare: vi.fn(), signal: vi.fn() }))
vi.mock('./modules/delivery/runtime/definition-fork', async () => ({ ...await vi.importActual<typeof import('./modules/delivery/runtime/definition-fork')>('./modules/delivery/runtime/definition-fork'), forkDefinitionRun: runtime.fork }))
vi.mock('./modules/loops/runtime/loop-definition-recovery', () => ({ probeDefinitionRun: runtime.probe }))
vi.mock('./modules/delivery/runtime/incomplete-tasks-remedy', async () => ({ ...await vi.importActual<typeof import('./modules/delivery/runtime/incomplete-tasks-remedy')>('./modules/delivery/runtime/incomplete-tasks-remedy'), prepareIncompleteTasksFork: runtime.prepare }))
vi.mock('./modules/agent-runtime/runtime/agent-runtime-controls-router', () => ({ signalDefinitionRun: runtime.signal }))

let db: DbInstance
const begin = vi.fn()
const TASK = '4.1 Manual visual review (desktop and narrow viewport, nearly full board, ghost on) not performed'
beforeEach(() => {
  vi.clearAllMocks()
  order.length = 0
  delete process.env.SPECRAILS_LOOPS_SECTION
  db = initDb(':memory:')
  for (const id of ['run', 'child']) {
    createLoopRun(db, { id, projectId: 'p', loopId: 'loop', loopName: 'Implement', railIndex: null, ticketId: null, provider: 'claude', model: 'sonnet', iterationLimit: 1, startedAt: new Date().toISOString() })
  }
  db.prepare("UPDATE loop_runs SET engine_version = 2, status = 'completed', final_outcome = 'failed', failure_diagnosis = ? WHERE id = 'run'")
    .run(serializeDiagnosis({ kind: 'incomplete_tasks', confidence: 'high', phase: 'tasks', rounds: null, resetAt: null, detail: 'unfinished', resumablePhase: null, source: 'test', remedies: [], incompleteTasks: [TASK] } as never))
  db.prepare("UPDATE loop_runs SET engine_version = 2, status = 'paused', restart_reason = 'fork' WHERE id = 'child'").run()
  runtime.probe.mockResolvedValue({ status: 'paused', resumable: true, lease: null, pendingInterrupts: [], recoverableSteps: [{ attemptId: 'attempt', nodePath: 'developer', scopeId: 'root' }] })
  runtime.prepare.mockReturnValue({ requestId: 'remedy-retry-with-browser-x', fromNodePath: 'developer', scopeId: 'root', visit: 2, state: { $vars: {} } })
  runtime.fork.mockResolvedValue({ loopRunId: 'child', forkOf: 'run', fromNodePath: 'developer', scopeId: 'root', visit: 2 })
  runtime.signal.mockImplementation(async () => { order.push('signal'); return { id: 's1', acceptedAt: new Date().toISOString() } })
  begin.mockImplementation(() => { order.push('resume'); return new Promise(() => {}) })
})
afterEach(() => db.close())

function api() {
  const app = express(), router = express.Router()
  app.use(express.json())
  registerLoopRunRoutes({ router, ctx: () => ({ db, project: { id: 'p', path: '/repo' }, loopRunManager: { beginDefinitionResume: begin, isDefinitionRunActive: () => false, cancelDefinition: vi.fn(), isDisposed: () => false }, onLoopRunFinished: vi.fn() }) } as unknown as ProjectRoutesDeps)
  app.use('/api', router)
  return request(app)
}

describe('continue remedy route', () => {
  it('Continue queues the browser guidance for the restarted developer before the fork resumes', async () => {
    const result = await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'continue' })
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({ loopRunId: 'child', remedy: 'continue', mode: 'fork', fromStep: 'developer', guided: true })
    expect(runtime.signal).toHaveBeenCalledTimes(1)
    const [, runId, text, requestId] = runtime.signal.mock.calls[0]
    expect(runId).toBe('child')
    expect(text).toContain(TASK)
    expect(text).toContain('$SPECRAILS_BROWSE')
    expect(text).toContain('$PORT')
    expect(text).toMatch(/install it/i)
    expect(requestId).toMatch(/^continue-child-/)
    expect(order).toEqual(['signal', 'resume'])
    // The new attempt says how it came to be.
    expect(db.prepare('SELECT run_id, source_run_id, remedy, mode, from_step, cause, automatic FROM run_continuations').all())
      .toEqual([{ run_id: 'child', source_run_id: 'run', remedy: 'continue', mode: 'fork', from_step: 'developer', cause: 'incomplete_tasks', automatic: 0 }])
  })

  it('keeps the older "Retry with the browser" id working as Continue', async () => {
    const result = await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'retry-with-browser' })
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({ loopRunId: 'child', remedy: 'continue', guided: true })
    expect(runtime.prepare).toHaveBeenCalledWith(db, 'run', 'retry-with-browser', expect.anything())
  })

  it('refuses an unknown remedy and an attempt that was already continued', async () => {
    expect((await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'rm -rf' })).status).toBe(400)
    db.prepare("INSERT INTO definition_fork_operations (project_id, source_run_id, request_id, child_run_id, request_json, adopted) VALUES ('p','run','r','child','{}',1)").run()
    const result = await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'continue' })
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ error: 'runtime_fork_owns_worktree', loopRunId: 'child' })
  })

  it('still resumes when the guidance cannot be queued, and says so', async () => {
    runtime.signal.mockRejectedValue(new Error('steering_unsupported'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'continue' })
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({ guided: false })
    expect(begin).toHaveBeenCalled()
  })

  it('continue to review sends no instruction', async () => {
    runtime.prepare.mockReturnValue({ requestId: 'remedy-continue-to-review-x', fromNodePath: 'tasks', scopeId: 'root', visit: 2, state: { $vars: { humanChecks: [TASK] } } })
    const result = await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'continue-to-review' })
    expect(result.status).toBe(201)
    expect(result.body.guided).toBeUndefined()
    expect(runtime.signal).not.toHaveBeenCalled()
  })

  it('serves the attempt chain and whether Continue applies', async () => {
    db.prepare("UPDATE loop_runs SET fork_of = 'run', fork_cut_json = ? WHERE id = 'child'").run(JSON.stringify({ fromNodePath: 'developer', scopeId: 'root', visit: 2 }))
    let result = await api().get('/api/p/loop-runs/run/attempts')
    expect(result.body).toMatchObject({ continuable: true, chain: { runId: 'run', attempt: 1, attempts: [{ runId: 'run', attempt: 1 }, { runId: 'child', attempt: 2, fromStep: 'developer' }] } })
    db.prepare("INSERT INTO definition_fork_operations (project_id, source_run_id, request_id, child_run_id, request_json, adopted) VALUES ('p','run','r','child','{}',1)").run()
    result = await api().get('/api/p/loop-runs/run/attempts')
    expect(result.body.continuable).toBe(false)
    expect((await api().get('/api/p/loop-runs/nope/attempts')).status).toBe(404)
  })
})

describe('"Copy this project\'s .env into runs" remedy', () => {
  const fsMod = () => import('fs')
  const ENV_BLOCKER = { kind: 'environment', confidence: 'high', phase: 'baseline', rounds: null, resetAt: null, detail: 'The tests need APP_KEY', resumablePhase: null, source: 'core',
    blocker: { kind: 'environment', reason: 'No application encryption key has been specified (APP_KEY).', command: 'php', args: ['artisan', 'test'], cwd: '.', requiredAction: 'cp .env.example .env in this worktree' } }

  async function fixture() {
    const fs = await fsMod(), os = await import('os'), path = await import('path'), { execFileSync } = await import('child_process')
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim()
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remedy env ')))
    const repo = path.join(root, 'repo'), worktree = path.join(root, 'wt')
    fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'i')
    fs.writeFileSync(path.join(repo, '.env'), 'APP_KEY=base64:FAKEFAKEFAKEFAKE=\n')
    git(repo, 'worktree', 'add', '-q', '-b', 'run', worktree)
    return { fs, path, root, repo, worktree }
  }
  function seedRun(repo: string, worktree: string) {
    db.prepare('UPDATE loop_runs SET failure_diagnosis = ?, run_request_json = ?, runtime_metadata_json = ? WHERE id = \'run\'').run(
      serializeDiagnosis(ENV_BLOCKER as never),
      JSON.stringify({ runId: 'run', projectId: 'p', loopId: 'loop', cwd: worktree, repoDir: worktree, isolation: { branch: 'run', worktreePath: worktree } }),
      JSON.stringify({ source: 'definition' }))
    void repo
  }
  function apiAt(repo: string) {
    const app = express(), router = express.Router()
    app.use(express.json())
    registerLoopRunRoutes({ router, ctx: () => ({ db, project: { id: 'p', path: repo, slug: 'p' }, loopRunManager: { beginDefinitionResume: begin, isDefinitionRunActive: () => false, cancelDefinition: vi.fn(), isDisposed: () => false }, onLoopRunFinished: vi.fn() }) } as unknown as ProjectRoutesDeps)
    app.use('/api', router)
    return request(app)
  }

  it('is offered on an env-file blocker while the setting is off, and gone once it is on', async () => {
    const { readRunDiagnosis } = await import('./modules/recovery/adapters/sqlite')
    seedRun('/repo', '/wt')
    expect(readRunDiagnosis(db, 'run')?.remedies[0]).toBe('copy-env-files')
    db.prepare("INSERT INTO queue_state (key, value) VALUES ('config.worktree_env_files', 'true')").run()
    expect(readRunDiagnosis(db, 'run')?.remedies).not.toContain('copy-env-files')
  })

  it('turns the project setting on, copies .env into the run worktree and continues with guidance naming it', async () => {
    const { fs, path, root, repo, worktree } = await fixture()
    try {
      seedRun(repo, worktree)
      runtime.probe.mockResolvedValue({ status: 'completed', resumable: true, lease: null, pendingInterrupts: [], recoverableSteps: [], scopes: [{ scopeId: 'root', nodePath: 'baseline', visits: 1, status: 'failed' }] })
      const result = await apiAt(repo).post('/api/p/loop-runs/run/remedy').send({ remedy: 'copy-env-files' })
      expect(result.status).toBe(201)
      expect(result.body).toMatchObject({ remedy: 'continue', envFilesEnabled: true, envFilesCopied: ['.env'] })
      expect((db.prepare("SELECT value FROM queue_state WHERE key = 'config.worktree_env_files'").get() as { value: string }).value).toBe('true')
      expect(fs.readFileSync(path.join(worktree, '.env'), 'utf8')).toBe('APP_KEY=base64:FAKEFAKEFAKEFAKE=\n')
      expect(fs.statSync(path.join(worktree, '.env')).mode & 0o777).toBe(0o600)
      const text = runtime.signal.mock.calls[0]?.[2] as string
      expect(text).toContain('copied the project\'s environment files into this worktree: .env')
      expect(text).not.toContain('FAKEFAKE')
      expect(begin).toHaveBeenCalled()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('changes nothing when the project has no .env to copy', async () => {
    const { fs, path, root, repo, worktree } = await fixture()
    try {
      fs.rmSync(path.join(repo, '.env'))
      seedRun(repo, worktree)
      const result = await apiAt(repo).post('/api/p/loop-runs/run/remedy').send({ remedy: 'copy-env-files' })
      expect(result.status).toBe(409)
      expect(result.body.error).toBe('env_files_unavailable')
      expect(db.prepare("SELECT value FROM queue_state WHERE key = 'config.worktree_env_files'").get()).toBeUndefined()
      expect(begin).not.toHaveBeenCalled()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
