import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendEvent, createJob, initDb, type DbInstance } from '../../../db'
import { createLoopRun, linkDefinitionFork, saveDefinitionRun } from './loop-runs-store'
import type { LoopRunRequest } from './loop-run-manager'
import type { FailureDiagnosis } from '../../recovery'
import { settledLimitProvider, settledProviderSwitch, settledSwitchLimit } from './loop-provider-switch-settled'
import { validateSwitchChoice } from './loop-provider-switch'
import { writeFailureAnalysis } from '../../recovery/adapters/sqlite'

const routes = { architect: { provider: 'claude' }, developer: { provider: 'codex', model: 'gpt-6-sol' }, fixer: { provider: 'codex' }, reviewer: { provider: 'claude' } }
const diagnosis = (patch: Partial<FailureDiagnosis>): FailureDiagnosis => ({ kind: 'crash', confidence: 'high', phase: null, rounds: null, resetAt: null, detail: null, resumablePhase: null, blocker: null, source: 'core', ...patch })

describe('which provider refused a settled run', () => {
  it('reads the diagnosis, the run\'s own refusal lines and the AI analysis, never a spec that talks about limits', () => {
    expect(settledLimitProvider({ diagnosis: diagnosis({ kind: 'provider_limit', provider: 'codex' }), routes })).toBe('codex')
    // An older Core settled the refusal as a crash; its detail names the CLI.
    expect(settledLimitProvider({ diagnosis: diagnosis({ detail: 'codex usage limit reached (5h window, resets 2026-11-21T03:00:00.000Z).' }), routes })).toBe('codex')
    // The log tail carries the provider's own sentence.
    expect(settledLimitProvider({ diagnosis: diagnosis({}), logLines: ['[fixer] codex execution failed (exit 1). ERROR: You\'ve hit your usage limit. Try again in 3 hours.'], routes })).toBe('codex')
    // The AI analysis says provider_limit: the failing step's role names the provider.
    expect(settledLimitProvider({ diagnosis: diagnosis({ phase: 'fixer' }), analysisCategory: 'provider_limit', routes })).toBe('codex')
    // ...else the provider the quota store knows is refusing.
    expect(settledLimitProvider({ diagnosis: diagnosis({}), analysisCategory: 'provider_limit', routes, refusing: id => id === 'claude' })).toBe('claude')
    // No evidence of a limit: no switch.
    expect(settledLimitProvider({ diagnosis: diagnosis({ phase: 'fixer' }), logLines: ['- [ ] 2.1 Show "rate limit exceeded" when the API returns 429'], routes })).toBeNull()
    expect(settledLimitProvider({ diagnosis: null, routes })).toBeNull()
    // Evidence, but nothing says which of two providers: no guess.
    expect(settledLimitProvider({ diagnosis: diagnosis({}), analysisCategory: 'provider_limit', routes })).toBeNull()
  })
})

describe('the switch a settled run offers', () => {
  let db: DbInstance, root: string, contextPath: string
  const targets = vi.fn(() => [{ provider: 'claude', model: 'haiku', effort: 'low' }])
  const support = vi.fn(async () => ({ resume: true, fork: true }))
  beforeEach(() => {
    db = initDb(':memory:'); root = mkdtempSync(path.join(os.tmpdir(), 'settled switch ')); targets.mockClear(); support.mockReset(); support.mockResolvedValue({ resume: true, fork: true })
    const directory = path.join(root, 'pipeline', 'run-1'); mkdirSync(directory, { recursive: true })
    contextPath = path.join(directory, 'desktop-context.json'); writeFileSync(contextPath, '{}')
    writeFileSync(path.join(directory, 'desktop-runtime-config.json'), JSON.stringify({ agents: routes, fixer: { provider: 'codex', model: 'gpt-6-sol' } }))
    writeFileSync(path.join(directory, 'desktop-workflow-definition.json'), JSON.stringify({ roles: ['architect', 'developer', 'reviewer'] }))
    createLoopRun(db, { id: 'run-1', projectId: 'p', loopId: 'loop', iterationLimit: 3, startedAt: new Date().toISOString() })
    createJob(db, { id: 'run-1', command: 'loop: implement', owner: 'loop', started_at: new Date().toISOString() })
    saveDefinitionRun(db, 'run-1', { contextPath, request: { runId: 'run-1', projectId: 'p', loopId: 'loop', cwd: root, provider: 'codex', model: 'gpt-6-sol', graph: { nodes: [], edges: [], config: {} } } as LoopRunRequest })
    db.prepare("UPDATE loop_runs SET status='completed', final_outcome='failure' WHERE id='run-1'").run()
  })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const offer = (d: FailureDiagnosis | null) => settledProviderSwitch('run-1', { db, providerSwitch: { targets }, support, diagnosis: d })

  it('moves the roles on the limited provider, through the fork when the retained Core can', async () => {
    expect(await offer(diagnosis({ kind: 'provider_limit', provider: 'codex', phase: 'fixer' }))).toEqual({ providerId: 'codex', roles: ['developer', 'fixer'], targets: [{ provider: 'claude', model: 'haiku', effort: 'low' }], via: 'fork' })
    expect(targets).toHaveBeenLastCalledWith({ fromProvider: 'codex', roles: ['developer', 'fixer'] })
    support.mockResolvedValue({ resume: true, fork: false })
    expect((await offer(diagnosis({ kind: 'provider_limit', provider: 'codex' })))?.via).toBe('resume')
    // A Core that moves no routes: no switch.
    support.mockResolvedValue({ resume: false, fork: false })
    expect(await offer(diagnosis({ kind: 'provider_limit', provider: 'codex' }))).toBeNull()
  })

  it('finds the refusal in the run\'s log or analysis when the diagnosis names none (an older Core\'s crash)', async () => {
    appendEvent(db, 'run-1', 1, { event_type: 'log', source: 'stderr', payload: JSON.stringify({ line: 'codex execution failed (exit 1). You\'ve hit your usage limit. Try again in 2 days.' }) })
    expect(await offer(diagnosis({ phase: 'fixer' }))).toMatchObject({ providerId: 'codex', roles: ['developer', 'fixer'], via: 'fork' })
    db.prepare('DELETE FROM events').run()
    expect(await offer(diagnosis({ phase: 'fixer' }))).toBeNull()
    writeFailureAnalysis(db, 'run-1', { inputHash: 'h', language: 'es', provider: 'claude', model: null, createdAt: new Date().toISOString(),
      analysis: { headline: 'Codex alcanzó su límite', cause: 'x', category: 'provider_limit', failedStep: 'fixer', evidence: [], nextSteps: [] } })
    expect(await offer(diagnosis({ phase: 'fixer' }))).toMatchObject({ providerId: 'codex', roles: ['developer', 'fixer'] })
  })

  it('offers nothing for a delivered run, one already continued, or when no other provider is usable', async () => {
    targets.mockReturnValueOnce([])
    expect(await offer(diagnosis({ kind: 'provider_limit', provider: 'codex' }))).toBeNull()
    expect(await offer(diagnosis({ kind: 'tests_failed', phase: 'verify' }))).toBeNull()
    createLoopRun(db, { id: 'run-2', projectId: 'p', loopId: 'loop', iterationLimit: 3, startedAt: new Date().toISOString() })
    saveDefinitionRun(db, 'run-2', { contextPath, request: { runId: 'run-2', projectId: 'p', loopId: 'loop', cwd: root, provider: 'codex', model: 'gpt-6-sol', graph: { nodes: [], edges: [], config: {} } } as LoopRunRequest })
    linkDefinitionFork(db, 'run-2', { forkOf: 'run-1', forkCut: { fromNodePath: 'fixer', scopeId: 'root', visit: 1, revision: 1 } })
    db.prepare("INSERT INTO definition_fork_operations(project_id,source_run_id,request_id,child_run_id,request_json,adopted) VALUES ('p','run-1','r','run-2','{}',1)").run()
    expect(await offer(diagnosis({ kind: 'provider_limit', provider: 'codex' }))).toBeNull()
    db.prepare("UPDATE loop_runs SET status='completed', final_outcome='success' WHERE id='run-1'").run()
    expect(await offer(diagnosis({ kind: 'provider_limit', provider: 'codex' }))).toBeNull()
  })

  it('refuses the exhausted provider, one the run did not offer, and models or efforts outside the catalog', async () => {
    const limit = settledSwitchLimit((await offer(diagnosis({ kind: 'provider_limit', provider: 'codex' })))!)
    expect(validateSwitchChoice(limit, { provider: 'codex', model: 'gpt-6-sol' })).toMatchObject({ ok: false, error: 'shares_quota' })
    expect(validateSwitchChoice(limit, { provider: 'gemini', model: 'gemini-3.5-flash' })).toMatchObject({ ok: false, error: 'invalid_provider' })
    expect(validateSwitchChoice(limit, { provider: 'claude', model: 'gpt-6-sol' })).toMatchObject({ ok: false, error: 'invalid_model' })
    expect(validateSwitchChoice(limit, { provider: 'claude', model: 'haiku', effort: 'ultra' })).toMatchObject({ ok: false, error: 'invalid_effort' })
    expect(validateSwitchChoice(limit, { provider: 'claude', model: 'haiku', effort: 'low', remember: true })).toEqual({ ok: true, choice: { provider: 'claude', model: 'haiku', effort: 'low', remember: true } })
  })
})
