import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runAgentRuntimeInvocation } from '../../agent-runtime/runtime/agent-runtime-bridge'
import { resetCoreAgentRuntimeApiCache } from '../../agent-runtime/runtime/agent-runtime-loader'
import { acceptedRouteOverrides, currentRoleRoutes } from '../../agent-runtime/runtime/agent-runtime-route-overrides'
import { getFactoryLoop } from './loop-factory'
import { compileLoopToDefinition } from './loop-definition'
import { rolesOnProvider, routeOverrideRequest } from './loop-provider-switch'
import { classifyProviderLimit } from '../../../provider-limit'

// Continue on another provider through the REAL bridge and a built Core with `routeOverrides`:
// every Implement role starts on codex, which refuses on its usage limit; Desktop resumes the
// retained run with the codex roles moved to claude/haiku, and Core re-runs the refused step and
// every later step there, then delivers. Only the provider executor is a fixture.
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
vi.mock('../../agent-runtime/runtime/agent-runtime-package', async importOriginal => {
  const original = await importOriginal<typeof import('../../agent-runtime/runtime/agent-runtime-package')>()
  const selected = new Map<string, string>()
  return { ...original,
    prepareRetainedAgentRuntime: async () => {},
    retainAgentRuntime: (cli: string, contextPath: string) => { selected.set(contextPath, cli); return cli },
    resolveRetainedAgentRuntime: async (contextPath: string) => { const cli = selected.get(contextPath); if (!cli) throw new Error('Fixture runtime was never retained'); return cli },
  }
})

const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
const coreRouteOverrides = (() => {
  if (!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js'))) return false
  const api = spawnSync(process.execPath, [path.join(core, 'dist/agent-runtime/cli.js'), 'api'], { encoding: 'utf8' })
  try { return (JSON.parse(api.stdout.trim().split('\n').at(-1) ?? '{}') as { capabilities?: Record<string, number> }).capabilities?.routeOverrides === 1 } catch { return false }
})()

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'provider switch pairing ')))
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'))
  if (core) vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', path.join(core, 'dist/agent-runtime/index.js'))
  resetCoreAgentRuntimeApiCache()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

it.skipIf(!coreRouteOverrides)('a run refused on codex continues on claude/haiku for the refused step and every later step, and delivers', async () => {
  const id = 'switch-v2', repository = path.join(root, id), backlog = path.join(root, id + '-backlog')
  mkdirSync(repository); mkdirSync(backlog)
  expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
  writeFileSync(path.join(repository, 'code.cjs'), 'module.exports = 1\n')
  expect(spawnSync('git', ['-C', repository, 'add', '.']).status).toBe(0)
  expect(spawnSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']).status).toBe(0)
  const runtime = path.join(backlog, '.specrails/pipeline', id); mkdirSync(runtime, { recursive: true })
  const contextPath = path.join(runtime, 'desktop-context.json'), configPath = path.join(root, id + '-config.json')
  const specs = [{ id: 1, title: 'Return two', description: 'code.cjs returns two', repositoryIds: ['repo'], acceptanceCriteria: ['Function returns 2'] }]
  writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId: id, backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs }))
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, enabled: true, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }, { id: 'codex', kind: 'cli', cli: 'codex' }],
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
  expect(refused).toMatchObject({ failed: true, runtimeStatus: 'failed' })
  // The refusal stops the run without a completion, so Desktop pauses it at the limit instead of settling it.
  expect(refused.completion ?? null, JSON.stringify(refused).slice(0, 2000)).toBeNull()
  expect(refused.errorText ?? '').toContain('codex usage limit reached')
  expect(classifyProviderLimit(refused.errorText) !== null || (refused.failure as { kind?: string } | undefined)?.kind === 'provider_limit').toBe(true)
  const frozen = readFileSync(path.join(runtime, 'desktop-runtime-config.json'), 'utf8')
  // Every role of this run is on codex: they all move.
  const roles = rolesOnProvider(currentRoleRoutes(contextPath), 'codex')
  expect(roles.length).toBeGreaterThan(0)
  const routeOverrides = routeOverrideRequest({ runId: id, sequence: 1, fromProvider: 'codex', roles, choice: { provider: 'claude', model: 'haiku' } })
  const resumed = await runAgentRuntimeInvocation({ contextPath, cwd: repository, env, engineVersion: 2, resume: true, routeOverrides, onLine: line => lines.push(line), timeoutMs: 150_000 })
  expect(resumed, JSON.stringify(resumed).slice(0, 2000)).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
  expect(readFileSync(path.join(repository, 'code.cjs'), 'utf8')).toBe('module.exports = 2\n')
  const calls = readFileSync(switchCalls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { provider: string; role: string; model: string | null })
  // The refused step ran once on codex; it and every later step ran on claude/haiku.
  expect(calls[0]).toMatchObject({ provider: 'codex' })
  expect(calls.filter(call => call.provider === 'codex')).toHaveLength(1)
  expect(calls.slice(1).length).toBeGreaterThan(1)
  expect(calls.slice(1).every(call => call.provider === 'claude' && call.model === 'haiku')).toBe(true)
  expect(calls[1]!.role).toBe(calls[0]!.role)
  // Core accepted and recorded the override; Desktop never rewrote the frozen files.
  expect(acceptedRouteOverrides(contextPath)).toEqual([expect.objectContaining({ requestId: routeOverrides.requestId, fromProvider: 'codex' })])
  expect(readFileSync(path.join(runtime, 'desktop-runtime-config.json'), 'utf8')).toBe(frozen)
  expect(lines.join('')).toMatch(/\[runtime\] \S+: claude\/haiku/)
  // A later plain resume of the finished run keeps the moved routes on record.
  expect(currentRoleRoutes(contextPath)[roles[0]!]).toMatchObject({ provider: 'claude', model: 'haiku' })
}, 240_000)
