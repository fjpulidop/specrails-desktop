import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDb, getJobEvents, type DbInstance } from '../../../db'
import { LoopRunManager, type LoopExecutors, type LoopRunRequest } from './loop-run-manager'
import { readLimitPause } from './loop-limit-pauses'
import type { DefinitionLoopInvocation, DefinitionPrepared, DefinitionRuntimeResult } from './loop-definition-run'
import type { LoopProviderSwitch, LoopRunAdmission } from './loop-run-contract'
import { rememberRoutes, rolesOnProvider, routeOverrideRequest, switchedLine, switchTargetsFor, validateSwitchChoice } from './loop-provider-switch'
import { acceptedRouteOverrides, currentRoleRoutes, frozenRoleRoutes, recordAcceptedRouteOverride } from '../../agent-runtime/runtime/agent-runtime-route-overrides'
import type { RuntimeConfig } from '../../agent-runtime/runtime/agent-runtime-settings'

let db: DbInstance, root: string
beforeEach(() => { db = initDb(':memory:'); root = mkdtempSync(path.join(os.tmpdir(), 'provider switch ')) })
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

/** A prepared Core run directory: the frozen config Core reads (never edited) and the definition's roles. */
function preparedRun(): DefinitionPrepared {
  const directory = path.join(root, 'pipeline', 'r1'); mkdirSync(directory, { recursive: true })
  const contextPath = path.join(directory, 'desktop-context.json')
  writeFileSync(contextPath, '{}')
  writeFileSync(path.join(directory, 'desktop-runtime-config.json'), JSON.stringify({ schemaVersion: 1, providers: [], verification: [],
    agents: { architect: { provider: 'claude', model: 'opus' }, developer: { provider: 'codex', model: 'gpt-6-sol', effort: 'high', maxTurns: 40 }, reviewer: { provider: 'claude' } },
    fixer: { provider: 'codex', model: 'gpt-6-sol' }, roles: { 'loop-decider': { provider: 'claude', access: 'read', artifacts: 'none' } } }))
  writeFileSync(path.join(directory, 'desktop-workflow-definition.json'), JSON.stringify({ roles: ['architect', 'developer', 'reviewer'] }))
  return { contextPath, runtimeDirectory: directory, definitionPath: path.join(directory, 'desktop-workflow-definition.json'), configPath: path.join(directory, 'desktop-runtime-config.json'), definitionHash: 'a'.repeat(64), definition: {}, context: {} }
}

const project: RuntimeConfig = { schemaVersion: 1, enabled: true, providers: [], verification: [],
  agents: { architect: { provider: 'claude', model: 'opus' }, developer: { provider: 'claude', model: 'haiku', effort: 'low', maxTurns: 12 }, reviewer: { provider: 'codex', model: 'gpt-6-sol' } },
  fixer: { provider: 'codex', model: 'gpt-6-sol' } } as RuntimeConfig

describe('provider switch pieces', () => {
  it('moves only the roles on the limited provider and keeps the frozen files untouched', () => {
    const prepared = preparedRun(), frozen = readFileSync(prepared.configPath, 'utf8')
    const routes = frozenRoleRoutes(prepared.contextPath)
    // The decider is not a role of this definition.
    expect(Object.keys(routes).sort()).toEqual(['architect', 'developer', 'fixer', 'reviewer'])
    expect(rolesOnProvider(routes, 'codex')).toEqual(['developer', 'fixer'])
    recordAcceptedRouteOverride(prepared.contextPath, routeOverrideRequest({ runId: 'r1', sequence: 1, fromProvider: 'codex', roles: ['developer', 'fixer'], choice: { provider: 'claude', model: 'haiku', effort: 'low' } }))
    recordAcceptedRouteOverride(prepared.contextPath, routeOverrideRequest({ runId: 'r1', sequence: 1, fromProvider: 'codex', roles: ['developer'], choice: { provider: 'gemini', model: 'x' } }))
    expect(acceptedRouteOverrides(prepared.contextPath)).toHaveLength(1)
    expect(currentRoleRoutes(prepared.contextPath).developer).toEqual({ provider: 'claude', model: 'haiku', effort: 'low', maxTurns: 40 })
    // A second limit, now on claude, moves every role on claude (the original architect/reviewer and the moved ones).
    expect(rolesOnProvider(currentRoleRoutes(prepared.contextPath), 'claude')).toEqual(['developer', 'fixer', 'architect', 'reviewer'])
    expect(readFileSync(prepared.configPath, 'utf8')).toBe(frozen)
  })

  it('offers the other installed providers that do not share the quota, starting at the project route for those roles', () => {
    const targets = switchTargetsFor({ installed: ['claude', 'codex', 'gemini'], fromProvider: 'codex', roles: ['developer', 'fixer'], config: project, refusing: id => id === 'gemini' })
    // Never the exhausted provider; gemini is refusing on its own limit.
    expect(targets).toEqual([{ provider: 'claude', model: 'haiku', effort: 'low' }])
    // No project route on that provider: the provider defaults.
    expect(switchTargetsFor({ installed: ['claude', 'codex'], fromProvider: 'claude', roles: ['developer'], config: project })).toEqual([{ provider: 'codex', model: 'gpt-6.2-sol', effort: 'medium' }])
    expect(switchTargetsFor({ installed: ['codex'], fromProvider: 'codex', roles: ['developer'], config: null })).toEqual([])
  })

  it('validates the choice against the offer and the catalogs', () => {
    const limit = { providerId: 'codex', resumeAt: null, autoResume: false, message: '', pausedAt: 't', switchable: true, switchRoles: ['developer'], switchTargets: [{ provider: 'claude', model: 'sonnet', effort: 'medium' }] }
    expect(validateSwitchChoice(limit, { provider: 'codex' })).toMatchObject({ ok: false, error: 'shares_quota' })
    expect(validateSwitchChoice(limit, { provider: 'gemini' })).toMatchObject({ ok: false, error: 'invalid_provider' })
    expect(validateSwitchChoice(limit, { provider: 'claude', model: 'gpt-6-sol' })).toMatchObject({ ok: false, error: 'invalid_model' })
    expect(validateSwitchChoice(limit, { provider: 'claude', model: 'haiku', effort: 'minimal' })).toMatchObject({ ok: false, error: 'invalid_effort' })
    expect(validateSwitchChoice({ ...limit, switchable: false }, { provider: 'claude' })).toMatchObject({ ok: false, error: 'switch_unavailable' })
    expect(validateSwitchChoice(limit, { provider: 'claude', model: 'haiku', effort: 'low', remember: true })).toEqual({ ok: true, choice: { provider: 'claude', model: 'haiku', effort: 'low', remember: true } })
  })

  it('builds the Core request, the log line and the remembered project routes', () => {
    expect(routeOverrideRequest({ runId: 'r1', sequence: 2, fromProvider: 'codex', roles: ['developer', 'fixer'], choice: { provider: 'claude', model: 'haiku', effort: 'low' } })).toEqual({
      schemaVersion: 1, requestId: 'desktop-switch:r1:2', reason: 'provider-limit', fromProvider: 'codex',
      routes: { developer: { provider: 'claude', model: 'haiku', effort: 'low' }, fixer: { provider: 'claude', model: 'haiku', effort: 'low' } },
      providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }] })
    expect(switchedLine('codex', { provider: 'claude', model: 'haiku', effort: 'low' })).toBe("Switched to Claude/haiku (low) after Codex's usage limit")
    expect(switchedLine('claude', { provider: 'gemini', model: 'gemini-3.5-flash' })).toBe("Switched to Gemini/gemini-3.5-flash after Claude's usage limit")
    const remembered = rememberRoutes(project, { reviewer: { provider: 'claude', model: 'sonnet', effort: 'high' }, fixer: { provider: 'claude', model: 'haiku' }, ghost: { provider: 'claude', model: 'x' } })
    expect(remembered.agents.reviewer).toEqual({ provider: 'claude', model: 'sonnet', effort: 'high' })
    expect(remembered.fixer).toEqual({ provider: 'claude', model: 'haiku' })
    expect(remembered.agents.developer).toEqual(project.agents.developer)
    expect(remembered.roles).toBeUndefined()
  })
})

describe('a Core run paused at a usage limit continues on another provider', () => {
  const request = (): LoopRunRequest => ({ runId: 'r1', loopId: 'implement', projectId: 'p1', cwd: '/repo', provider: 'codex', model: 'gpt-6-sol', graph: { nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 } }, { id: 'a', type: 'core', position: { x: 0, y: 100 }, data: { kind: 'prompt', params: { text: 'Read', access: 'read', engine: { provider: 'codex' } } } },
    { id: 'end', type: 'core', position: { x: 0, y: 200 }, data: { kind: 'end', params: { outcome: 'success' } } }], edges: [{ id: 's', source: 'start', target: 'a' }, { id: 'e', source: 'a', target: 'end', label: 'next' }], config: { maxIterations: 3, timeoutMinutes: 0 } } })
  const limited: DefinitionRuntimeResult = { text: '', runtimeStatus: 'failed', failed: true, errorText: 'codex usage limit reached (five_hour window, resets 2099-01-01T00:00:00.000Z).',
    failure: { kind: 'provider_limit', confidence: 'high', resetsAt: '2099-01-01T00:00:00.000Z', provider: 'codex' } }
  const done: DefinitionRuntimeResult = { text: 'done', runtimeStatus: 'succeeded', completion: { ok: true, verified: true, reasons: [] } }

  function harness(supports: boolean, first: DefinitionRuntimeResult = limited) {
    const prepared = preparedRun()
    const run = vi.fn<(input: DefinitionLoopInvocation) => Promise<DefinitionRuntimeResult>>()
      .mockImplementationOnce(async input => { input.onPrepared?.(prepared); return first })
      .mockResolvedValueOnce(done)
    const executors: LoopExecutors = { runDefinition: run, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn(), supportsRouteOverrides: vi.fn(async () => supports) }
    const remember = vi.fn()
    const providerSwitch: LoopProviderSwitch = { targets: vi.fn(() => [{ provider: 'claude', model: 'sonnet', effort: 'medium' }]), remember }
    const reassign = vi.fn()
    const admission: LoopRunAdmission = { acquire: vi.fn(async () => () => {}), waiting: () => null, reassign }
    const manager = new LoopRunManager(db, () => {}, executors, undefined, { providerSwitch: () => providerSwitch, admission: () => admission })
    return { prepared, run, manager, remember, reassign, providerSwitch, admission }
  }
  const paused = async (manager: LoopRunManager) => { for (let i = 0; i < 400 && !manager.limitPause('r1'); i++) await new Promise(resolve => setTimeout(resolve, 5)) }

  it('offers the roles on the limited provider and the targets, resumes Core with the override, logs the switch and cancels the automatic resume', async () => {
    const h = harness(true)
    const running = h.manager.run(request())
    await paused(h.manager)
    expect(h.manager.limitPause('r1')).toMatchObject({ providerId: 'codex', autoResume: true, switchable: true, switchRoles: ['developer', 'fixer'], switchTargets: [{ provider: 'claude', model: 'sonnet', effort: 'medium' }] })
    expect(h.providerSwitch.targets).toHaveBeenCalledWith({ fromProvider: 'codex', roles: ['developer', 'fixer'] })
    expect(readLimitPause(db, 'r1')).toMatchObject({ switchRoles: ['developer', 'fixer'] })
    // Never the exhausted provider, never one the card did not offer.
    expect(h.manager.resolveLimitPause('r1', { action: 'switch', provider: 'codex', model: 'gpt-6-sol' })).toBe(false)
    expect(h.manager.resolveLimitPause('r1', { action: 'switch', provider: 'gemini', model: 'gemini-3.5-flash' })).toBe(false)
    expect(h.manager.resolveLimitPause('r1', { action: 'switch', provider: 'claude', model: 'haiku', effort: 'low', remember: true })).toBe(true)
    expect((await running).outcome).toBe('success')
    expect(h.run).toHaveBeenCalledTimes(2)
    expect(h.run.mock.calls[1]![0]).toMatchObject({ resume: true, routeOverrides: { schemaVersion: 1, requestId: 'desktop-switch:r1:1', reason: 'provider-limit', fromProvider: 'codex',
      routes: { developer: { provider: 'claude', model: 'haiku', effort: 'low' }, fixer: { provider: 'claude', model: 'haiku', effort: 'low' } } } })
    // The switch answered the pause: nothing is left to resume by itself at the old provider's reset.
    expect(h.manager.limitPause('r1')).toBeNull()
    expect(readLimitPause(db, 'r1')).toBeNull()
    expect(h.reassign).toHaveBeenCalledWith('r1', 'claude')
    expect(h.remember).toHaveBeenCalledWith({ developer: { provider: 'claude', model: 'haiku', effort: 'low' }, fixer: { provider: 'claude', model: 'haiku', effort: 'low' } })
    const events = getJobEvents(db, 'r1')
    const log = events.filter(event => event.event_type === 'log').map(event => String(event.payload)).join('\n')
    expect(log).toContain("Switched to Claude/haiku (low) after Codex's usage limit")
    expect(events.find(event => event.event_type === 'provider_switched')?.payload).toContain('"roles":["developer","fixer"]')
  })

  it('an older Core without routeOverrides keeps the plain card: no switch is offered or accepted', async () => {
    const h = harness(false)
    const running = h.manager.run(request())
    await paused(h.manager)
    expect(h.manager.limitPause('r1')).toMatchObject({ switchable: false })
    expect(h.manager.limitPause('r1')?.switchTargets).toBeUndefined()
    expect(h.manager.resolveLimitPause('r1', { action: 'switch', provider: 'claude', model: 'haiku' })).toBe(false)
    expect(h.manager.resolveLimitPause('r1', { action: 'resume' })).toBe(true)
    expect((await running).outcome).toBe('success')
    expect(h.run.mock.calls[1]![0].routeOverrides).toBeUndefined()
  })

  it('names the refusing CLI from its execution failure, not the run\'s own provider', async () => {
    // A run launched on claude whose codex roles refused: Core's untyped execution failure carries Codex's own sentence.
    const h = harness(true, { text: '', runtimeStatus: 'failed', failed: true, errorText: "codex execution failed (exit 1). ERROR: You've hit your usage limit. Try again in 1 minute.", failure: { kind: 'provider_limit', confidence: 'high' } })
    const running = h.manager.run({ ...request(), provider: 'claude', model: 'haiku' })
    await paused(h.manager)
    expect(h.manager.limitPause('r1')).toMatchObject({ providerId: 'codex', switchRoles: ['developer', 'fixer'] })
    expect(h.manager.resolveLimitPause('r1', { action: 'resume' })).toBe(true)
    expect((await running).outcome).toBe('success')
  })
})
