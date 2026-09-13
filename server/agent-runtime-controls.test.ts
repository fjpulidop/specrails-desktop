import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import express from 'express'
import request from 'supertest'
import { createJob, initDb, type DbInstance } from './db'
import { createLoopRun, listLoopStepRecoveries } from './loop-runs-store'
import { AgentRuntimeControls, readAgentRuntimeStatus, RuntimeControlError, validateRuntimeResumeInput } from './agent-runtime-controls'
import { registerAgentRuntimeControlRoutes, shutdownAgentRuntimeControls } from './agent-runtime-controls-router'
import type { ProjectContext } from './project-registry'
import type { AiStepResult } from './loop-run-manager'
import { recoverOrphanLoopStepAccounting } from './loop-run-manager'

const loader = vi.hoisted(() => ({ cli: null as string | null }))
vi.mock('./agent-runtime-loader', () => ({ findCoreAgentRuntimeCli: () => loader.cli }))
vi.mock('./path-resolver', () => ({ resolveBundledNodeExe: () => process.execPath }))
vi.mock('./workspace-resolution', () => ({ resolveProjectExecution: (project: { path: string }) => ({ specrailsDir: path.join(project.path, '.specrails') }), resolveLoopBaseEnv: () => ({ ...process.env, SPECRAILS_GIT_AUTO: 'true', SPECRAILS_REPO_MAP_PATH: 'new-map', SPECRAILS_PROFILE_PATH: 'legacy-profile.json' }) }))

let directory: string, runDirectory: string, contextPath: string, db: DbInstance, ctx: ProjectContext
let service: AgentRuntimeControls
let finish: (result: AiStepResult) => void
const state = () => ({ runId: 'run-1', status: 'paused', nextStep: 'archive', steps: { archive: { status: 'paused' } }, pendingApproval: { stepId: 'archive', reason: 'Review candidate' } })
const status = vi.fn(), execute = vi.fn(), kill = vi.fn()
beforeEach(() => {
  vi.clearAllMocks(); loader.cli = null
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-controls-')))
  runDirectory = path.join(directory, '.specrails', 'pipeline', 'run-1'); fs.mkdirSync(runDirectory, { recursive: true })
  contextPath = path.join(runDirectory, 'desktop-context.json')
  fs.writeFileSync(contextPath, JSON.stringify({ runId: 'run-1', backlogRoot: directory, artifactRoot: directory, repositories: [{ id: 'primary', name: 'App', path: directory }] }))
  fs.writeFileSync(path.join(runDirectory, 'desktop-runtime-host.json'), JSON.stringify({ schemaVersion: 1, cwd: directory, env: { SPECRAILS_GIT_AUTO: 'false', SPECRAILS_REPO_DIR: directory } }))
  fs.writeFileSync(path.join(runDirectory, 'agent-runtime-request.json'), '{}')
  db = initDb(':memory:')
  createJob(db, { id: 'run-1', command: 'loop:factory:implement', started_at: new Date().toISOString(), provider: 'claude', owner: 'loop' })
  createLoopRun(db, { id: 'run-1', projectId: 'p1', loopId: 'factory:implement', iterationLimit: 1, startedAt: new Date().toISOString() })
  db.prepare("UPDATE loop_runs SET status = 'completed' WHERE id = 'run-1'").run()
  ctx = { project: { id: 'p1', path: directory, slug: 'p1' }, db, broadcast: vi.fn(), railLoopRuns: new Map(), railJobs: new Map() } as unknown as ProjectContext
  status.mockResolvedValue(state())
  execute.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  service = new AgentRuntimeControls(ctx, { status, execute, kill })
})
afterEach(() => { service.shutdown(); vi.restoreAllMocks(); db.close(); fs.rmSync(directory, { recursive: true, force: true }) })

describe('agent runtime lifecycle', () => {
  it('forwards optional metrics without altering admission or trusting unknown fields', async () => {
    const total = { attempts: 1, measuredAttempts: 1, durationMs: 10, agentDurationMs: 8, providerCalls: 1, toolCalls: 1, inputTokens: 20, outputTokens: 5, costUsd: null, uncachedInputTokens: null, cacheReadInputTokens: null, cacheWriteInputTokens: null }
    const metrics = { schemaVersion: 1, total, phases: [{ ...total, stepId: 'developer', providers: ['local'], models: [] }] }
    status.mockResolvedValue({ ...state(), metrics: { ...metrics, transcript: 'do not forward' } })
    expect(await service.summary('run-1')).toMatchObject({ metrics, canResume: true })
    expect(JSON.stringify(await service.summary('run-1'))).not.toContain('do not forward')
    status.mockResolvedValue(state())
    expect((await service.summary('run-1')).metrics).toBeUndefined()
  })
  it('lists admitted runs and restores the original cwd/environment without starting providers for status', async () => {
    expect(await service.list()).toEqual([expect.objectContaining({ runId: 'run-1', status: 'paused', canResume: true, canCancel: false, pendingApproval: { stepId: 'archive', reason: 'Review candidate' } })])
    expect(status).toHaveBeenCalledWith(contextPath, directory, expect.objectContaining({ SPECRAILS_GIT_AUTO: 'false', SPECRAILS_EXECUTION_CONTEXT: contextPath }))
    expect(status.mock.calls[0][2]).not.toHaveProperty('SPECRAILS_REPO_MAP_PATH')
    expect(status.mock.calls[0][2]).not.toHaveProperty('SPECRAILS_PROFILE_PATH')
    expect(execute).not.toHaveBeenCalled()
    fs.rmSync(path.join(directory, '.specrails', 'pipeline'), { recursive: true })
    expect(await service.list()).toEqual([])
  })

  it('reuses Core status for unchanged checkpoints while checking scope and parent liveness each time', async () => {
    const checkpoint = path.join(runDirectory, 'agent-workflow', 'run-1', 'checkpoint.json')
    fs.mkdirSync(path.dirname(checkpoint), { recursive: true }); fs.writeFileSync(checkpoint, 'revision1')
    await service.summary('run-1'); await service.summary('run-1')
    expect(status).toHaveBeenCalledTimes(1)
    fs.writeFileSync(checkpoint, 'revision222')
    await service.summary('run-1'); expect(status).toHaveBeenCalledTimes(2)
    db.prepare("UPDATE loop_runs SET status = 'running' WHERE id = 'run-1'").run()
    expect((await service.summary('run-1')).canResume).toBe(false)
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('resumes exactly once, blocks duplicate requests, propagates cancellation and records invocation usage once', async () => {
    db.prepare('UPDATE loop_runs SET rail_index = 2 WHERE id = ?').run('run-1')
    await service.resume('run-1', { approve: ['archive'] })
    expect(ctx.railLoopRuns.get('run-1')?.railIndex).toBe(2)
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'runtime.continuation', jobId: 'run-1', active: true }))
    execute.mock.calls[0][0].onLine('Developer resumed\n')
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'log', processId: 'run-1', line: 'Developer resumed\n' }))
    execute.mock.calls[0][0].onRawLine(JSON.stringify({ type: 'workflow-event', event: { type: 'step_started', stepId: 'developer' } }))
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'event', jobId: 'run-1', event_type: 'workflow-event' }))
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ contextPath, cwd: directory, resume: true, approve: ['archive'] }))
    expect(execute.mock.calls[0][0]).not.toHaveProperty('configPath')
    await expect(service.resume('run-1', {})).rejects.toMatchObject({ statusCode: 409 })
    expect((await service.summary('run-1')).canCancel).toBe(true)
    execute.mock.calls[0][0].onSpawn({ pid: 456 } as ChildProcess)
    service.cancel('run-1'); expect(kill).toHaveBeenCalledWith(456, 'SIGTERM')
    finish({ provider: 'agent-runtime', cost: 0.2, tokensIn: 20, tokensOut: 5, durationMs: 120, text: 'paused', failed: true, errorText: 'Cancelled' })
    await vi.waitFor(() => expect(db.prepare('SELECT * FROM ai_invocations').all()).toHaveLength(1))
    expect(db.prepare('SELECT provider,status,total_cost_usd,tokens_in,tokens_out FROM ai_invocations').get()).toEqual({ provider: 'agent-runtime', status: 'failed', total_cost_usd: 0.2, tokens_in: 20, tokens_out: 5 })
    expect(listLoopStepRecoveries(db)).toEqual([])
    expect(ctx.railLoopRuns.has('run-1')).toBe(false)
    expect(ctx.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'runtime.continuation', jobId: 'run-1', active: false }))
    expect((await service.summary('run-1')).error).toBe('Cancelled')
    expect(() => service.cancel('run-1')).toThrow('Only a continuation')
  })

  it('reserves admission while status is pending and cancels children that spawn after shutdown', async () => {
    let resolveStatus!: (value: ReturnType<typeof state>) => void
    status.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve }))
    const admission = service.resume('run-1', {})
    await expect(service.resume('run-1', {})).rejects.toMatchObject({ statusCode: 409 })
    resolveStatus(state()); await admission
    service.shutdown()
    execute.mock.calls[0][0].onSpawn({ pid: 42 } as ChildProcess)
    expect(kill).toHaveBeenCalledWith(42, 'SIGKILL')
    finish({ text: 'stopped' })
    await Promise.resolve(); await Promise.resolve()
    expect(db.prepare('SELECT * FROM ai_invocations').all()).toEqual([])
    await expect(service.resume('run-1', {})).rejects.toMatchObject({ statusCode: 503 })
  })

  it('identifies interrupted phases, reports execution failures, and preserves unknown cost', async () => {
    status.mockResolvedValue({ ...state(), status: 'running', pendingApproval: undefined, nextStep: 'developer', steps: { developer: { status: 'running' } } })
    expect(await service.summary('run-1')).toMatchObject({ status: 'interrupted', recoverableSteps: ['developer'] })
    execute.mockRejectedValueOnce(new Error('provider failed'))
    await service.resume('run-1', { recover: ['developer'] })
    await vi.waitFor(async () => expect((await service.summary('run-1')).error).toContain('continuation failed'))
    await service.resume('run-1', {})
    finish({ text: 'done' })
    await vi.waitFor(() => expect(db.prepare("SELECT total_cost_usd,status FROM ai_invocations WHERE status = 'success'").get()).toEqual({ total_cost_usd: null, status: 'success' }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_invocations').get()).toEqual({ count: 2 })
  })

  it('recovers a continuation after shutdown from its staged raw Core events exactly once', async () => {
    await service.resume('run-1', { recover: ['developer'] })
    expect(listLoopStepRecoveries(db)).toHaveLength(1)
    const emit = execute.mock.calls[0][0].onRawLine
    emit(JSON.stringify({ type: 'workflow-event', event: { id: 'started', type: 'step_started', attemptId: 'a1' } }))
    emit(JSON.stringify({ type: 'workflow-event', event: { id: 'ended', type: 'step_succeeded', attemptId: 'a1', usage: { costUsd: 0.5, inputTokens: 20, outputTokens: 10 } } }))
    // The readable continuation banner shares the job log with the raw Core events.
    expect(db.prepare('SELECT seq,event_type FROM events ORDER BY seq').all()).toEqual([{ seq: 0, event_type: 'log' }, { seq: 1, event_type: 'workflow-event' }, { seq: 2, event_type: 'workflow-event' }])
    expect(JSON.parse((db.prepare('SELECT payload FROM events WHERE seq = 0').get() as { payload: string }).payload).line).toContain('continuation started from phase')
    service.shutdown()
    emit(JSON.stringify({ type: 'agent-event' }))
    finish({ text: 'closed after app shutdown', cost: 999 })
    await Promise.resolve(); await Promise.resolve()
    expect(db.prepare('SELECT * FROM ai_invocations').all()).toEqual([])
    expect(recoverOrphanLoopStepAccounting(db, new Date().toISOString(), 'run-1')).toBe(1)
    expect(db.prepare('SELECT provider,total_cost_usd,tokens_in,tokens_out FROM ai_invocations').get()).toEqual({ provider: 'agent-runtime', total_cost_usd: 0.5, tokens_in: 20, tokens_out: 10 })
    expect(recoverOrphanLoopStepAccounting(db, new Date().toISOString(), 'run-1')).toBe(0)
    expect(listLoopStepRecoveries(db)).toEqual([])
  })

  it('retains unknown usage after a crash before any Core output and never reuses previous raw events', async () => {
    await service.resume('run-1', {})
    execute.mock.calls[0][0].onRawLine(JSON.stringify({ type: 'runtime-result', status: 'succeeded', invocationUsage: { costUsd: 1, inputTokens: 100, outputTokens: 50 } }))
    finish({ text: 'done', cost: 1, tokensIn: 100, tokensOut: 50 })
    await vi.waitFor(() => expect(listLoopStepRecoveries(db)).toHaveLength(0))
    await service.resume('run-1', {})
    service.shutdown()
    finish({ text: 'never committed' })
    await Promise.resolve(); await Promise.resolve()
    expect(recoverOrphanLoopStepAccounting(db, new Date().toISOString(), 'run-1')).toBe(1)
    const amounts = db.prepare('SELECT total_cost_usd,tokens_in FROM ai_invocations ORDER BY rowid').all()
    expect(amounts).toEqual([{ total_cost_usd: 1, tokens_in: 100 }, { total_cost_usd: null, tokens_in: null }])
    expect(db.prepare('SELECT total_cost_usd,tokens_in FROM jobs WHERE id = ?').get('run-1')).toEqual({ total_cost_usd: null, tokens_in: null })
  })

  it('escalates ignored cancellation without leaving a timer after settlement', async () => {
    await service.resume('run-1', {})
    execute.mock.calls[0][0].onSpawn({ pid: 12 } as ChildProcess)
    vi.useFakeTimers()
    try {
      service.cancel('run-1')
      await vi.advanceTimersByTimeAsync(3000)
      expect(kill).toHaveBeenCalledWith(12, 'SIGKILL')
      finish({ text: 'cancelled', failed: true })
      await vi.advanceTimersByTimeAsync(1)
    } finally { vi.useRealTimers() }
  })

  it('rejects live parents, completed workflows and missing contexts without execution', async () => {
    db.prepare("UPDATE loop_runs SET status = 'running' WHERE id = 'run-1'").run()
    expect((await service.summary('run-1')).canResume).toBe(false)
    await expect(service.resume('run-1', {})).rejects.toMatchObject({ code: 'runtime_run_active' })
    db.prepare("UPDATE loop_runs SET status = 'completed' WHERE id = 'run-1'").run()
    status.mockResolvedValueOnce({ ...state(), status: 'succeeded' })
    await expect(service.resume('run-1', {})).rejects.toMatchObject({ code: 'runtime_not_resumable' })
    fs.unlinkSync(contextPath)
    await expect(service.resume('run-1', {})).rejects.toMatchObject({ statusCode: 404 })
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong identity', () => { const json = JSON.parse(fs.readFileSync(contextPath, 'utf8')); json.runId = 'another'; fs.writeFileSync(contextPath, JSON.stringify(json)) }],
    ['missing original worktree', () => { const json = JSON.parse(fs.readFileSync(contextPath, 'utf8')); json.repositories[0].path = '/does-not-exist'; fs.writeFileSync(contextPath, JSON.stringify(json)) }],
    ['changed backlog', () => { const json = JSON.parse(fs.readFileSync(contextPath, 'utf8')); json.backlogRoot = os.tmpdir(); fs.writeFileSync(contextPath, JSON.stringify(json)) }],
    ['missing host snapshot', () => fs.unlinkSync(path.join(runDirectory, 'desktop-runtime-host.json'))],
    ['unsafe host environment', () => fs.writeFileSync(path.join(runDirectory, 'desktop-runtime-host.json'), JSON.stringify({ schemaVersion: 1, cwd: directory, env: { API_KEY: 'secret' } }))],
    ['changed manifest', () => db.prepare('UPDATE loop_runs SET execution_manifest = ? WHERE id = ?').run(JSON.stringify({ version: 1, projectId: 'p2', selectedRepositoryIds: ['primary'], repositories: [] }), 'run-1')],
  ])('fails closed for %s', async (_label, mutate) => {
    mutate()
    expect(await service.summary('run-1')).toMatchObject({ status: 'unavailable', canResume: false })
    await expect(service.resume('run-1', {})).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects context symlinks escaping the owned run directory and malformed status', async () => {
    const moved = path.join(directory, 'moved.json')
    if (process.platform === 'win32') {
      // Creating file symlinks requires extra privileges on some Windows
      // machines; model only realpath's escaped-target result for this guard.
      const original = fs.realpathSync
      const resolved = vi.spyOn(fs, 'realpathSync').mockImplementation((input, ...options) => input === contextPath ? moved : original(input, ...options))
      try { await expect(service.resume('run-1', {})).rejects.toMatchObject({ code: 'runtime_scope_changed' }) }
      finally { resolved.mockRestore() }
    } else {
      fs.renameSync(contextPath, moved); fs.symlinkSync(moved, contextPath)
      await expect(service.resume('run-1', {})).rejects.toMatchObject({ code: 'runtime_scope_changed' })
      fs.unlinkSync(contextPath); fs.renameSync(moved, contextPath)
    }
    status.mockResolvedValueOnce(null)
    expect(await service.summary('run-1')).toMatchObject({ status: 'unavailable', canResume: false })
    expect(await service.summary('../escape')).toMatchObject({ status: 'unavailable' })
  })

  it.each([null, [], { contextPath: '/other' }, { approve: 'archive' }, { recover: ['../other'] }, { invalidate: ['verify', 'verify'] }, { answer: '' }, { answer: '   ' }, { answer: 42 }, { answer: ['text'] }, { answer: 'x'.repeat(20_001) }])('rejects arbitrary resume inputs %j', (input) => {
    expect(() => validateRuntimeResumeInput(input)).toThrow(RuntimeControlError)
  })
  it('accepts only phase control arrays and a bounded answer', () => {
    expect(validateRuntimeResumeInput({ approve: ['archive'], recover: ['developer'], invalidate: ['verify'] })).toEqual({ approve: ['archive'], recover: ['developer'], invalidate: ['verify'] })
    expect(validateRuntimeResumeInput({ answer: 'x'.repeat(20_000) })).toEqual({ answer: 'x'.repeat(20_000) })
  })

  it('exposes an open architect question, requires its answer to resume and forwards the answer to Core', async () => {
    const question = { stepId: 'architect', requestedAt: '2026-09-12T00:00:00.000Z', question: 'Which database should the cache use?' }
    status.mockResolvedValue({ ...state(), traceId: 'trace-1', nextStep: 'architect', pendingApproval: undefined, pendingQuestion: question, steps: { architect: { status: 'paused', visits: 2 } } })
    expect(await service.summary('run-1')).toMatchObject({ status: 'paused', canResume: true, traceId: 'trace-1', pendingQuestion: question })
    await expect(service.resume('run-1', {})).rejects.toMatchObject({ statusCode: 400, code: 'answer_required' })
    await expect(service.resume('run-1', { approve: ['archive'] })).rejects.toMatchObject({ code: 'answer_required' })
    expect(execute).not.toHaveBeenCalled()
    expect((await service.summary('run-1')).canCancel).toBe(false)
    await service.resume('run-1', { answer: 'Use Redis' })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ resume: true, answer: 'Use Redis' }))
    expect(JSON.parse((db.prepare('SELECT payload FROM events WHERE seq = 0').get() as { payload: string }).payload).line).toContain('answered question')
    finish({ text: 'continued' })
    await vi.waitFor(() => expect(db.prepare('SELECT COUNT(*) AS count FROM ai_invocations').get()).toEqual({ count: 1 }))
    // An answered question is history, not an open prompt.
    status.mockResolvedValue({ ...state(), pendingApproval: undefined, pendingQuestion: { ...question, answeredAt: '2026-09-12T00:01:00.000Z', answer: 'Use Redis' } })
    expect((await service.summary('run-1')).pendingQuestion).toBeUndefined()
    await service.resume('run-1', {})
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('runs the offline status CLI with structured argv and rejects missing/malformed Core output', async () => {
    await expect(readAgentRuntimeStatus(contextPath, directory, process.env)).rejects.toMatchObject({ statusCode: 503 })
    loader.cli = path.join(directory, 'fake status.cjs')
    fs.writeFileSync(loader.cli, 'if (!process.argv.includes("--compact")) process.exit(1); process.stdout.write(JSON.stringify({type:"runtime-status",state:null}))')
    expect(await readAgentRuntimeStatus(contextPath, directory, process.env)).toBeNull()
    fs.writeFileSync(loader.cli, 'process.stdout.write(JSON.stringify({type:"other"}))')
    await expect(readAgentRuntimeStatus(contextPath, directory, process.env)).rejects.toThrow('invalid runtime status')
  })

  it('mounts lifecycle routes with validation/status codes and disposes project controllers', async () => {
    const app = express(); app.use(express.json()); const router = express.Router()
    registerAgentRuntimeControlRoutes({ router, ctx: () => ctx }); app.use('/api/projects', router)
    const list = vi.spyOn(AgentRuntimeControls.prototype, 'list').mockResolvedValue([])
    const resume = vi.spyOn(AgentRuntimeControls.prototype, 'resume').mockResolvedValue()
    const cancel = vi.spyOn(AgentRuntimeControls.prototype, 'cancel').mockReturnValue()
    const stop = vi.spyOn(AgentRuntimeControls.prototype, 'shutdown').mockReturnValue()
    const base = '/api/projects/p1/agent-runtime/runs'
    const summary = vi.spyOn(AgentRuntimeControls.prototype, 'summary').mockResolvedValue({ runId: 'run-1', status: 'failed', nextStep: 'developer', recoverableSteps: [], active: false, canResume: true, canCancel: false })
    await request(app).get(base + '/run-1').expect(200).expect(res => expect(res.body.runs[0].runId).toBe('run-1'))
    await request(app).get(base + '/legacy-job').expect(200, { runs: [] })
    db.prepare('UPDATE loop_runs SET rail_index = 2 WHERE id = ?').run('run-1')
    await request(app).get(base + '?railIndex=2').expect(200).expect(res => expect(res.body.runs[0].runId).toBe('run-1'))
    await request(app).get(base + '?railIndex=3').expect(200, { runs: [] })
    await request(app).get(base + '?railIndex=-1').expect(400)
    expect(summary).toHaveBeenCalledWith('run-1')
    await request(app).get(base).expect(200, { runs: [] })
    await request(app).post(base + '/run-1/resume').send({ approve: ['archive'] }).expect(202)
    expect(resume).toHaveBeenCalledWith('run-1', { approve: ['archive'] })
    await request(app).post(base + '/run-1/resume').send({ cwd: '/bad' }).expect(400)
    await request(app).post(base + '/run-1/resume').send({ answer: 'Use Redis' }).expect(202)
    expect(resume).toHaveBeenCalledWith('run-1', { answer: 'Use Redis' })
    await request(app).post(base + '/run-1/resume').send({ answer: '' }).expect(400)
    resume.mockRejectedValueOnce(new RuntimeControlError(400, 'answer_required', 'Answer first'))
    await request(app).post(base + '/run-1/resume').send({}).expect(400, { error: 'answer_required', message: 'Answer first' })
    await request(app).post(base + '/run-1/cancel').expect(202)
    expect(cancel).toHaveBeenCalledWith('run-1')
    resume.mockRejectedValueOnce(new RuntimeControlError(409, 'active', 'Still active'))
    await request(app).post(base + '/run-1/resume').send({}).expect(409)
    resume.mockRejectedValueOnce(new Error('private error'))
    await request(app).post(base + '/run-1/resume').send({}).expect(500)
    list.mockRejectedValueOnce(new Error('private error'))
    await request(app).get(base).expect(500)
    cancel.mockImplementationOnce(() => { throw new RuntimeControlError(409, 'inactive', 'Not active') })
    await request(app).post(base + '/run-1/cancel').expect(409)
    cancel.mockImplementationOnce(() => { throw new Error('private error') })
    await request(app).post(base + '/run-1/cancel').expect(500)
    shutdownAgentRuntimeControls(ctx); expect(stop).toHaveBeenCalledOnce()
    shutdownAgentRuntimeControls({})
  })
})
