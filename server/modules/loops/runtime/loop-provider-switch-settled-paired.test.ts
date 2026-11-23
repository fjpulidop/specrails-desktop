import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { retainedRuntimeRouteOverrideSupport, runAgentRuntimeControl, runAgentRuntimeInvocation } from '../../agent-runtime/runtime/agent-runtime-bridge'
import { resetCoreAgentRuntimeApiCache } from '../../agent-runtime/runtime/agent-runtime-loader'
import { acceptedRouteOverrides, currentRoleRoutes } from '../../agent-runtime/runtime/agent-runtime-route-overrides'
import { getFactoryLoop } from './loop-factory'
import { compileLoopToDefinition } from './loop-definition'
import { rolesOnProvider, routeOverrideRequest } from './loop-provider-switch'
import { settledLimitProvider } from './loop-provider-switch-settled'
import { stoppedStep } from '../../delivery/runtime/run-continuation'
import type { DefinitionRunProbe } from './loop-definition-recovery'

// Continue a run that SETTLED on a usage limit on another provider, through the REAL bridge and a
// built Core with `forkRouteOverrides`: every Implement role starts on codex, which refuses; the run
// is never re-opened, so its next attempt is a fork from the refused step that carries the codex
// roles' move to claude/haiku. Core records the move on the fork itself: a plain resume of the fork
// runs the refused step and every later one on claude/haiku and delivers. Only the provider
// executor is a fixture.
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
vi.mock('../../agent-runtime/runtime/agent-runtime-package', async importOriginal => {
  const original = await importOriginal<typeof import('../../agent-runtime/runtime/agent-runtime-package')>()
  const selected = new Map<string, string>()
  return { ...original,
    prepareRetainedAgentRuntime: async () => {},
    retainAgentRuntime: (cli: string, contextPath: string) => { selected.set(contextPath, cli); return cli },
    // A fork's child keeps its source's retained runtime (the frozen package file is copied).
    resolveRetainedAgentRuntime: async (contextPath: string) => { const cli = selected.get(contextPath) ?? [...selected.values()][0]; if (!cli) throw new Error('Fixture runtime was never retained'); return cli },
  }
})

const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
const coreForkRouteOverrides = (() => {
  if (!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js'))) return false
  const api = spawnSync(process.execPath, [path.join(core, 'dist/agent-runtime/cli.js'), 'api'], { encoding: 'utf8' })
  try { return (JSON.parse(api.stdout.trim().split('\n').at(-1) ?? '{}') as { capabilities?: Record<string, number> }).capabilities?.forkRouteOverrides === 1 } catch { return false }
})()

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'provider switch pairing ')))
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'))
  if (core) vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', path.join(core, 'dist/agent-runtime/index.js'))
  resetCoreAgentRuntimeApiCache()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

it.skipIf(!coreForkRouteOverrides)('a run that settled on codex\'s limit continues as a fork on claude/haiku and delivers', async () => {
  const id = 'switch-settled', repository = path.join(root, id), backlog = path.join(root, id + '-backlog')
  mkdirSync(repository); mkdirSync(backlog)
  expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
  writeFileSync(path.join(repository, 'code.cjs'), 'module.exports = 1\n')
  expect(spawnSync('git', ['-C', repository, 'add', '.']).status).toBe(0)
  expect(spawnSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']).status).toBe(0)
  const runtime = path.join(backlog, '.specrails/pipeline', id); mkdirSync(runtime, { recursive: true })
  const contextPath = path.join(runtime, 'desktop-context.json'), configPath = path.join(root, id + '-config.json')
  const specs = [{ id: 1, title: 'Return two', description: 'code.cjs returns two', repositoryIds: ['repo'], acceptanceCriteria: ['Function returns 2'] }]
  writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId: id, backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs }))
  // Only codex is configured: the fork brings the claude connection along with the move.
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, enabled: true, providers: [{ id: 'codex', kind: 'cli', cli: 'codex' }],
    agents: { architect: { provider: 'codex' }, developer: { provider: 'codex' }, reviewer: { provider: 'codex' } },
    verification: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9);console.log("actual value verified")'] }] }))
  const callsFile = path.join(root, 'factory-calls.jsonl'), switchCalls = path.join(root, 'switch-calls.jsonl'), lines: string[] = []
  const factory = getFactoryLoop('factory:implement', { engineV2: 1, workflowDefinitions: 1, implementationSteps: 1 })!
  const preload = (file: string) => `--import=${pathToFileURL(path.join(process.cwd(), 'server/modules/loops/runtime/__fixtures__', file)).href}`
  const env = { ...process.env, SPECRAILS_GIT_AUTO: 'false', SPECRAILS_FACTORY_CORE: core, SPECRAILS_FACTORY_CALLS: callsFile, SPECRAILS_SWITCH_CALLS: switchCalls, SPECRAILS_FACTORY_STALL: '0', SPECRAILS_FACTORY_BLOCK: '', SPECRAILS_FACTORY_ADDENDA: '[]',
    NODE_OPTIONS: `${preload('factory-executor-preload.mjs')} ${preload('route-override-executor-preload.mjs')}` }
  const change = 'paired-change'
  const refused = await runAgentRuntimeInvocation({ contextPath, configPath, cwd: repository, change, env, defaultProvider: 'codex',
    loopConfig: factory.graph.config.agents, engineVersion: 2,
    prepareDefinition: config => compileLoopToDefinition(factory.graph, { id: factory.id, title: factory.name, provider: 'codex', constants: {}, spec: specs[0], roles: config.roles, loopAgents: config, repositoryCount: 1, changeId: change }),
    onLine: line => lines.push(line), timeoutMs: 150_000 })
  expect(refused).toMatchObject({ failed: true })
  // Desktop reads the refusal as a provider limit on codex and moves every role on codex.
  // The step Continue goes on from, read from Core's own status the way Desktop's planner reads it.
  const status = spawnSync(process.execPath, [path.join(core!, 'dist/agent-runtime/cli.js'), 'status', '--context', contextPath], { encoding: 'utf8', env })
  const scopes = (JSON.parse(status.stdout.trim().split('\n').at(-1) ?? '{}') as { state?: { scopes?: DefinitionRunProbe['scopes'] } }).state?.scopes ?? []
  const step = stoppedStep({ runId: id, engineVersion: 2, status: 'failed', resumable: false, lease: null, recoverableSteps: [], pendingInterrupts: [], completion: null, scopes, coreRevision: null, eventCursor: null, probedAt: '' }, null)
  expect(step, status.stdout.slice(-2000)).not.toBeNull()
  const routes = currentRoleRoutes(contextPath)
  expect(settledLimitProvider({ diagnosis: { kind: 'crash', detail: refused.errorText ?? null, phase: step!.nodePath, provider: null }, routes })).toBe('codex')
  const roles = rolesOnProvider(routes, 'codex')
  const host = { runId: id, contextPath, cwd: repository, env }
  expect(await retainedRuntimeRouteOverrideSupport(host)).toEqual({ resume: true, fork: true })
  const routeOverrides = routeOverrideRequest({ runId: id, sequence: 1, fromProvider: 'codex', roles, choice: { provider: 'claude', model: 'haiku' } })
  // The retained package record (the fixture retains the runtime in memory) is copied to the fork.
  if (!existsSync(path.join(runtime, 'desktop-runtime-package.json'))) writeFileSync(path.join(runtime, 'desktop-runtime-package.json'), '{}')
  const childRunId = 'switch-settled-next', frozen = readFileSync(path.join(runtime, 'desktop-runtime-config.json'), 'utf8')
  const fork = await runAgentRuntimeControl({ kind: 'fork', ...host, childRunId, fromNodePath: step!.nodePath, scopeId: 'root', visit: step!.visit, requestId: 'remedy-switch-fixture', routeOverrides })
  expect(fork.routesOverridden).toMatchObject({ requestId: routeOverrides.requestId, fromProvider: 'codex' })
  // Desktop keeps the child's record beside its frozen context; the source's files are untouched.
  expect(acceptedRouteOverrides(fork.contextPath)).toEqual([expect.objectContaining({ requestId: routeOverrides.requestId })])
  expect(currentRoleRoutes(fork.contextPath)[roles[0]!]).toMatchObject({ provider: 'claude', model: 'haiku' })
  expect(acceptedRouteOverrides(contextPath)).toEqual([])
  expect(readFileSync(path.join(runtime, 'desktop-runtime-config.json'), 'utf8')).toBe(frozen)
  // A plain resume of the fork (no override on it): the fork's own record moves the roles.
  const resumed = await runAgentRuntimeInvocation({ contextPath: fork.contextPath, cwd: repository, env, engineVersion: 2, resume: true, onLine: line => lines.push(line), timeoutMs: 150_000 })
  expect(resumed, JSON.stringify(resumed).slice(0, 2000)).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
  expect(readFileSync(path.join(repository, 'code.cjs'), 'utf8')).toBe('module.exports = 2\n')
  const calls = readFileSync(switchCalls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { provider: string; role: string; model: string | null })
  // The refused step ran once on codex; the fork ran it and every later step on claude/haiku.
  expect(calls.filter(call => call.provider === 'codex')).toHaveLength(1)
  expect(calls.slice(1).length).toBeGreaterThan(1)
  expect(calls.slice(1).every(call => call.provider === 'claude' && call.model === 'haiku')).toBe(true)
  expect(calls[1]!.role).toBe(calls[0]!.role)
  // A route Core cannot admit is refused before anything is published.
  const refusedFork = runAgentRuntimeControl({ kind: 'fork', ...host, childRunId: 'switch-settled-bad', fromNodePath: step!.nodePath, scopeId: 'root', visit: step!.visit, requestId: 'remedy-switch-bad',
    routeOverrides: { ...routeOverrides, requestId: 'desktop-switch:bad:1', routes: { ghost: { provider: 'claude' } } } })
  await expect(refusedFork).rejects.toThrow(/invalid_route_override|ghost/)
  expect(existsSync(path.join(backlog, '.specrails/pipeline/switch-settled-bad/agent-workflow/run.sqlite'))).toBe(false)
}, 300_000)
