import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunExecutionManifest } from './multi-repo-execution-store'
import type { RuntimeConfig } from './agent-runtime-settings'

const fixture = vi.hoisted(() => ({ cli: null as string | null, legacy: vi.fn(), framework: vi.fn() }))
vi.mock('./agent-runtime-loader', () => ({ findCoreAgentRuntimeCli: () => fixture.cli }))
vi.mock('./path-resolver', async () => ({ ...await vi.importActual<typeof import('./path-resolver')>('./path-resolver'), resolveBundledNodeExe: () => process.execPath }))
vi.mock('./spawn-lifecycle', () => ({ runAiCliInvocation: fixture.legacy }))
vi.mock('./workspace-manager', () => ({ ensureFrameworkAgents: fixture.framework, ensureFrameworkCommandSubtrees: fixture.framework }))
vi.mock('./claude-trust', () => ({ ensureClaudeTrusted: vi.fn() }))
vi.mock('./core-update-state', () => ({ assertWorkspaceCoreReady: vi.fn() }))

import { createLoopExecutors } from './loop-executors'
import { LoopRunManager } from './loop-run-manager'
import { getFactoryLoop } from './loop-factory'
import { initDb, type DbInstance } from './db'

let root: string, workspace: string, worktree: string, secondWorktree: string, configPath: string
const databases: DbInstance[] = []
const runId = 'runtime-integration-run'
function config(enabled = true): RuntimeConfig {
  return { schemaVersion: 1, enabled, providers: [
    { id: 'claude', kind: 'cli', cli: 'claude' }, { id: 'codex', kind: 'cli', cli: 'codex' },
    { id: 'gemini', kind: 'cli', cli: 'gemini' }, { id: 'kimi', kind: 'cli', cli: 'kimi' },
    { id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' },
  ], agents: { architect: { provider: 'gemini', model: 'architect-model' }, developer: { provider: 'local', model: 'local-model' }, reviewer: { provider: 'kimi', model: 'k3' } }, verification: [] }
}
function writeConfig(enabled = true): void { writeFileSync(configPath, JSON.stringify(config(enabled))) }
function control(value: Record<string, unknown>): void { writeFileSync(join(root, 'control.json'), JSON.stringify(value)) }
function invocations(): Record<string, unknown>[] {
  const log = join(root, 'calls.jsonl')
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
function env(): NodeJS.ProcessEnv { return { ...process.env, SPECRAILS_TICKETS_PATH: join(workspace, '.specrails', 'local-tickets.json'), SPECRAILS_WORKSPACE_DIR: workspace, SPECRAILS_STATE_DIR: join(workspace, '.specrails'), SPECRAILS_PROFILE_PATH: 'stale-inherited-profile.json', TEST_PROVIDER_SECRET: 'not-for-checkpoints' } }
function executors(options: { profilePathFor?: (provider: string, name?: string | null) => string | null } = {}) {
  return createLoopExecutors({ env, pluginScope: () => ({ stateRoot: workspace, legacyProviderId: 'claude' }), ...options })
}
function step(overrides: Record<string, unknown> = {}) {
  return { coreRun: { runId, implementation: true, repositoryId: 'core', spec: { id: 42, title: 'Build runtime', description: 'Acceptance criteria', repositoryIds: ['core'] } }, prompt: 'The explicit operation determines routing.', provider: 'claude', model: 'legacy-model', cwd: worktree, repoDir: worktree, aiStepTimeoutMs: 5000, ...overrides }
}
function manifest(): RunExecutionManifest {
  return { version: 1, groupId: 'group', projectId: 'project', primaryRepositoryId: 'core', artifactRepositoryId: 'desktop', selectedRepositoryIds: ['core', 'desktop'], repositories: [
    { repositoryId: 'core', name: 'Core', sourcePath: join(root, 'source-core'), gitCommonDir: join(root, 'source-core', '.git'), baseBranch: 'main', baseSha: 'a'.repeat(40), worktreePath: worktree, branch: 'codex/core', worktreeId: 'core-wt' },
    { repositoryId: 'desktop', name: 'Desktop', sourcePath: join(root, 'source-desktop'), gitCommonDir: join(root, 'source-desktop', '.git'), baseBranch: 'main', baseSha: 'b'.repeat(40), worktreePath: secondWorktree, branch: 'codex/desktop', worktreeId: 'desktop-wt' },
  ] }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime integration spaces '))
  workspace = join(root, 'project state'); worktree = join(root, 'Core worktree'); secondWorktree = join(root, 'Desktop worktree')
  for (const directory of [join(workspace, '.specrails'), worktree, secondWorktree]) mkdirSync(directory, { recursive: true })
  configPath = join(workspace, '.specrails', 'agent-runtime.json')
  fixture.cli = join(root, 'cli.mjs')
  writeConfig(); control({})
  // A real Node subprocess implements the public Core CLI wire contract. There
  // is no provider executable or network model behind this fixture.
  writeFileSync(fixture.cli, `import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const base=path.dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
const context=JSON.parse(fs.readFileSync(value('--context'),'utf8')),control=JSON.parse(fs.readFileSync(path.join(base,'control.json'),'utf8'));
fs.appendFileSync(path.join(base,'calls.jsonl'),JSON.stringify({args,cwd:process.cwd(),context,env:{profile:process.env.SPECRAILS_PROFILE_PATH,repo:process.env.SPECRAILS_REPO_DIR,gitAuto:process.env.SPECRAILS_GIT_AUTO,tickets:process.env.SPECRAILS_TICKETS_PATH,hasProviderSecret:!!process.env.TEST_PROVIDER_SECRET}})+'\\n');
if(args[0]==='status'){
 const pipeline={schemaVersion:1,runId:control.receiptRunId??context.runId,phases:Object.fromEntries(['architect','developer','reviewer','archive'].map(role=>[role,{status:role==='reviewer'&&control.incompleteReview?'pending':'done'}])),verification:{valid:control.validReceipt!==false,receipt:{kind:control.scopedReceipt?'scoped':'full',commands:[{exitCode:control.checkExitCode??0}]}}};
 console.log(JSON.stringify({state:{status:control.stateStatus??'succeeded'},pipeline}));
}else{
 fs.writeFileSync(path.join(path.dirname(value('--context')),'agent-runtime-request.json'),JSON.stringify({schemaVersion:1,runId:context.runId}));
 console.log(JSON.stringify({type:'workflow-event',event:{type:'step_started',stepId:'architect'}}));
 console.log(JSON.stringify({type:'agent-event',role:'developer',event:{kind:'text',text:'Implementation complete'}}));
 console.log(JSON.stringify({type:'runtime-result',runId:control.resultRunId??context.runId,status:control.resultStatus??'succeeded',invocationUsage:{inputTokens:12,outputTokens:3,costUsd:null}}));
 process.exitCode=control.exitCode??0;
}`)
  fixture.legacy.mockReset().mockImplementation(async (options: { onEvent?: (event: unknown) => void }) => {
    options.onEvent?.({ kind: 'text-delta', text: 'Legacy implementation' })
    return { spawnFailed: false, timedOut: false, code: 0, stderrTail: '', sessionId: 'legacy-session', events: [{ kind: 'result', payload: { type: 'result', subtype: 'success', usage: { input_tokens: 4, output_tokens: 2 }, total_cost_usd: 0.1 } }] }
  })
  fixture.framework.mockReset()
  vi.stubEnv('SPECRAILS_INTERACTIVE_JOBS', 'true')
  vi.stubEnv('SPECRAILS_RAIL_DELIVER_PR', 'true')
})
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllEnvs(); fixture.cli = null; rmSync(root, { recursive: true, force: true }) })

describe('Desktop implementation routing into the Core agent runtime', () => {
  it.each(['claude', 'codex', 'gemini', 'kimi'])('routes enabled %s rails through Core with frozen scope and no platform invocation', async provider => {
    const onLine = vi.fn(), onSpawn = vi.fn()
    const result = await executors().runAiStep({ ...step(), provider, onLine, onSpawn })
    expect(result).toMatchObject({ provider: 'agent-runtime', model: 'per-role', failed: false, cost: undefined, tokens: 15 })
    expect(fixture.legacy).not.toHaveBeenCalled(); expect(fixture.framework).not.toHaveBeenCalled()
    expect(onSpawn).toHaveBeenCalledOnce(); expect(onLine).toHaveBeenCalledWith('[runtime] step_started: architect\n')
    const call = invocations()[0]
    expect(call.args).toContain(configPath)
    expect(call.context).toMatchObject({ runId, artifactRoot: realpathSync(worktree), backlogRoot: realpathSync(workspace), ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, repositories: [{ id: 'core', path: realpathSync(worktree) }], specs: [{ id: 42, title: 'Build runtime' }] })
    const host = readFileSync(join(workspace, '.specrails', 'pipeline', runId, 'desktop-runtime-host.json'), 'utf8')
    expect(host).not.toContain('not-for-checkpoints')
  })
  it('uses artifact-root configuration while preserving every registered worktree and frozen ticket target', async () => {
    const executionManifest = manifest()
    await executors().runAiStep({ ...step(), executionManifest })
    expect(invocations()[0].context).toMatchObject({ artifactRoot: realpathSync(secondWorktree), artifactRepositoryId: 'desktop', repositories: [
      { id: 'core', path: realpathSync(worktree), baseSha: 'a'.repeat(40) }, { id: 'desktop', path: realpathSync(secondWorktree), baseSha: 'b'.repeat(40) },
    ], specs: [{ repositoryIds: ['core'] }] })
    const changed = { ...executionManifest, artifactRepositoryId: 'core' }
    await expect(executors().runAiStep({ ...step(), executionManifest: changed })).rejects.toThrow('context changed')
    expect(invocations()).toHaveLength(1)
  })
  it('preserves legacy execution only when runtime is disabled or implementation was not selected', async () => {
    writeConfig(false)
    expect((await executors().runAiStep(step())).provider).toBe('claude')
    expect(fixture.legacy).toHaveBeenCalledOnce(); expect(invocations()).toEqual([])
    writeConfig(true)
    await executors().runAiStep({ ...step(), coreRun: { ...step().coreRun, implementation: false } })
    expect(fixture.legacy).toHaveBeenCalledTimes(2); expect(invocations()).toEqual([])
  })
  it('disables resident whole-pipeline sessions and ignores obsolete legacy profile selection for runtime roles', async () => {
    const profilePathFor = vi.fn(() => { throw new Error('Obsolete legacy profile must not be loaded') })
    const ex = executors({ profilePathFor })
    expect(ex.planInteractiveAiStep?.({ ...step(), profileName: 'deleted-profile' })).toBeNull()
    expect((await ex.runAiStep({ ...step(), profileName: 'deleted-profile' })).failed).toBe(false)
    expect(ex.validateCoreCompletion?.({ ...step(), profileName: 'deleted-profile' })).toEqual({ valid: true })
    expect(profilePathFor).not.toHaveBeenCalled()
    expect(invocations()[0].env).toMatchObject({ repo: worktree, gitAuto: 'false', tickets: join(workspace, '.specrails', 'local-tickets.json'), hasProviderSecret: true })
    expect((invocations()[0].env as Record<string, unknown>).profile).toBeUndefined()
  })
  it('resumes admitted runtime ownership even after project configuration is disabled', async () => {
    const ex = executors()
    await ex.runAiStep(step()); writeConfig(false)
    expect(ex.planInteractiveAiStep?.(step())).toBeNull()
    expect((await ex.runAiStep(step())).failed).toBe(false)
    expect((invocations()[1].args as string[])[0]).toBe('resume')
    expect(invocations()[1].args).not.toContain('--config')
    expect(fixture.legacy).not.toHaveBeenCalled()
  })
  it.each([
    { resultStatus: 'paused' }, { resultRunId: 'another-run' }, { exitCode: 3 },
  ])('does not accept incomplete or mismatched Core process outcomes: %j', async state => {
    control(state)
    expect((await executors().runAiStep(step())).failed).toBe(true)
    expect(fixture.legacy).not.toHaveBeenCalled()
    expect(existsSync(join(workspace, '.specrails', 'pipeline', runId, 'agent-runtime-request.json'))).toBe(true)
  })
  it.each([
    { stateStatus: 'paused' }, { receiptRunId: 'wrong-run' }, { validReceipt: false },
    { scopedReceipt: true }, { checkExitCode: 1 }, { incompleteReview: true },
  ])('revalidates Core receipts before accepting implementation or verification: %j', async state => {
    const ex = executors(); await ex.runAiStep(step()); control(state)
    expect(ex.validateCoreCompletion?.(step()).valid).toBe(false)
    const result = await ex.runAiStep({ ...step(), coreRun: { ...step().coreRun, implementation: false, verificationStep: true } })
    expect(result).toMatchObject({ provider: 'agent-runtime', model: 'deterministic-verification', failed: true })
    expect(fixture.legacy).not.toHaveBeenCalled()
  })
  it('fails visibly rather than falling back when the requested Core runtime is unavailable', async () => {
    fixture.cli = null
    await expect(executors().runAiStep(step())).rejects.toThrow('unavailable')
    expect(fixture.legacy).not.toHaveBeenCalled()
  })
  it('dispatches an explicit factory operation through the real loop manager even without a command token', async () => {
    const db = initDb(':memory:'); databases.push(db)
    const graph = structuredClone(getFactoryLoop('factory:implement')!.graph)
    const main = graph.nodes.find(node => node.id === 'main-1')!
    expect(main.data?.operation).toBe('core-implementation')
    main.data!.prompt = 'Execute the selected spec using its runtime configuration.'
    const manager = new LoopRunManager(db, () => {}, executors())
    const result = await manager.run({ runId, loopId: 'factory:implement', loopName: 'Implement', graph, projectId: 'project', cwd: worktree, repoDir: worktree, provider: 'claude', model: 'sonnet', repositoryId: 'core', spec: { id: 42, title: 'Build runtime', description: 'Acceptance criteria', repositoryIds: ['core'] } })
    expect(result.outcome).toBe('success')
    expect(invocations().map(call => (call.args as string[])[0])).toEqual(['run', 'status'])
    expect(fixture.legacy).not.toHaveBeenCalled()
  })
})
