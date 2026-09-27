import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runAgentRuntimeInvocation } from '../../agent-runtime/runtime/agent-runtime-bridge'
import { resetCoreAgentRuntimeApiCache } from '../../agent-runtime/runtime/agent-runtime-loader'
import { getFactoryLoop } from './loop-factory'
import { convertLegacyLoop, LEGACY_DECIDER_ROLE } from './loop-compat'
import { compileLoopToDefinition } from './loop-definition'

vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
// Retention copying has its own installed-package tests. Keep real negotiation,
// validation, freezing, process execution and result parsing in this pairing.
vi.mock('../../agent-runtime/runtime/agent-runtime-package', async importOriginal => {
  const original = await importOriginal<typeof import('../../agent-runtime/runtime/agent-runtime-package')>()
  const selected = new Map<string, string>()
  return { ...original,
    retainAgentRuntime: (cli: string, contextPath: string) => { selected.set(contextPath, cli); return cli },
    resolveRetainedAgentRuntime: (contextPath: string) => {
      const cli = selected.get(contextPath)
      if (!cli) throw new Error('Fixture runtime was never retained')
      return cli
    },
  }
})
const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'factory pairing ')))
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'))
  if (core) vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', path.join(core, 'dist/agent-runtime/index.js'))
  resetCoreAgentRuntimeApiCache()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
type Event = Record<string, any>
async function execute(mode: string, legacy = false, stall = false, blockAt?: string, decisionModel?: string, converted = false) {
  const id = `${mode}-${legacy ? 'legacy' : 'v2'}`, repository = path.join(root, id), backlog = path.join(root, id + '-backlog')
  mkdirSync(repository); mkdirSync(backlog)
  expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
  writeFileSync(path.join(repository, 'code.cjs'), 'module.exports = 1\n')
  expect(spawnSync('git', ['-C', repository, 'add', '.']).status).toBe(0)
  expect(spawnSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']).status).toBe(0)
  const runtime = path.join(backlog, '.specrails/pipeline', id); mkdirSync(runtime, { recursive: true })
  const contextPath = path.join(runtime, 'desktop-context.json'), configPath = path.join(root, id + '-config.json')
  const specs = (mode === 'batch' ? [1, 2] : [1]).map(ticket => ({ id: ticket, title: 'Return two', description: 'code.cjs returns two', repositoryIds: ['repo'], acceptanceCriteria: ['Function returns 2'] }))
  writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId: id, backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs }))
  const config = JSON.parse(readFileSync(path.join(core!, 'src/agent-runtime/engine/__fixtures__/acceptance/runtime-config.json'), 'utf8'))
  config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9);console.log("actual value verified")'] }]
  writeFileSync(configPath, JSON.stringify(config))
  const callsFile = path.join(root, id + '-calls.jsonl'), events: Event[] = []
  const change = 'paired-change'
  let factory = getFactoryLoop(mode === 'quick-sdd' ? 'factory:sdd-quick-openspec' : `factory:${mode}`, { engineV2: 1, workflowDefinitions: 1 })!
  if (converted) {
    const old = getFactoryLoop(`factory:${mode}`)!
    const projection = convertLegacyLoop(old.graph, { repositoryId: 'repo' })
    if (!projection.ok) throw Error(JSON.stringify(projection.issues))
    factory = { ...old, graph: projection.graph }
  }
  const env = { ...process.env, SPECRAILS_GIT_AUTO: 'false', SPECRAILS_FACTORY_CORE: core, SPECRAILS_FACTORY_CALLS: callsFile, SPECRAILS_FACTORY_STALL: stall ? '1' : '0', SPECRAILS_FACTORY_BLOCK: blockAt ?? '',
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(process.cwd(), 'server/modules/loops/runtime/__fixtures__/factory-executor-preload.mjs')).href}` }
  let result = await runAgentRuntimeInvocation({ contextPath, configPath, cwd: repository, change, env,
    ...(decisionModel ? { workflowRoleBindings: { 'loop-decider': { provider: 'claude', model: decisionModel, access: 'read' as const, artifacts: 'none' as const } } } : {}),
    ...(converted && factory.graph.config.legacyDeciderRole ? { workflowRoleBindings: { [LEGACY_DECIDER_ROLE]: { provider: 'claude', access: 'read' as const, artifacts: 'none' as const } } } : {}),
    ...(!legacy ? { engineVersion: 2 as const, prepareDefinition: config => compileLoopToDefinition(factory.graph, { id: factory.id, title: factory.name, provider: 'claude', constants: {}, roles: config.roles, repositoryCount: 1, changeId: change }) } : {}),
    onRuntimeEvent: event => events.push(event), timeoutMs: 150_000,
  })
  if (blockAt) {
    expect(result).toMatchObject({ failed: false, runtimeStatus: 'paused' })
    expect(result.pendingInterrupts).toHaveLength(1)
    expect(readFileSync(path.join(repository, 'code.cjs'), 'utf8')).toBe(blockAt === 'loop-decider' ? 'module.exports = 2\n' : 'module.exports = 1\n')
    result = await runAgentRuntimeInvocation({ contextPath, cwd: repository, env, engineVersion: 2, resume: true,
      answer: 'Return two', interruptId: result.pendingInterrupts![0].id, onRuntimeEvent: event => events.push(event), timeoutMs: 150_000 })
  }
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Event) : []
  expect(result, JSON.stringify({ result, events: events.slice(-5) })).toMatchObject({ failed: stall })
  if (!legacy && !stall) expect(result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
  expect(readFileSync(path.join(repository, 'code.cjs'), 'utf8')).toBe('module.exports = 2\n')
  return { result, calls, events }
}
it.skipIf(!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js'))).each(['implement', 'batch', 'quick-sdd', 'freestyle'])('executes the %s factory through the real bridge and Core with deterministic local executors', async mode => {
  const actual = await execute(mode)
  if (mode === 'implement') {
    const legacy = await execute(mode, true)
    expect(actual.calls.map(call => call.role)).toEqual(legacy.calls.map(call => call.role))
    expect(actual.calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer'])
  } else if (mode === 'batch') {
    expect(actual.calls.filter(call => call.role === 'architect')).toHaveLength(2)
    expect(actual.calls.filter(call => call.role === 'developer')).toHaveLength(2)
    expect(actual.calls.filter(call => call.role === 'reviewer')).toHaveLength(2)
  } else if (mode === 'quick-sdd') {
    expect(actual.calls.map(call => call.nativeCommand.id)).toEqual(['opsx:ff', 'opsx:apply'])
  } else {
    expect(actual.calls.map(call => call.role)).toEqual(['prompt', 'prompt', 'loop-decider'])
    const terminal = actual.events.filter(event => event.type === 'workflow-event' && event.event.nodePath === 'verify' && event.event.type === 'step_succeeded')
    expect(terminal).toHaveLength(2)
    expect(actual.calls.at(-1)?.access).toBe('read')
  }
}, 180_000)

it.skipIf(!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js'))).each(['quick-sdd', 'freestyle'])('resumes a blocked %s factory through the real bridge without replaying completed phases', async mode => {
  const actual = await execute(mode, false, false, mode === 'quick-sdd' ? 'opsx:apply' : 'prompt')
  if (mode === 'quick-sdd') {
    expect(actual.calls.map(call => call.nativeCommand.id)).toEqual(['opsx:ff', 'opsx:apply', 'opsx:apply'])
    expect(actual.calls.at(-1)?.nativeCommand.args).toContain('Return two')
  } else expect(actual.calls.map(call => call.role)).toEqual(['prompt', 'prompt', 'prompt', 'loop-decider'])
}, 180_000)

it.skipIf(!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js')))('does not report Freestyle success when verified checks pass but the decider makes no progress', async () => {
  const actual = await execute('freestyle', false, true)
  expect(actual.result).toMatchObject({ failed: true, runtimeStatus: 'failed', completion: { ok: false } })
  expect(actual.calls.filter(call => call.role === 'loop-decider')).toHaveLength(3)
  const lifecycle = actual.events.filter(event => event.type === 'workflow-event').map(event => event.event)
  expect(lifecycle.some(event => event.type === 'workflow_succeeded')).toBe(false)
  expect(lifecycle.some(event => event.type === 'step_started' && event.nodePath === 'done')).toBe(false)
  expect(lifecycle.some(event => event.type === 'step_failed' && event.nodePath === 'decide')).toBe(true)
}, 180_000)

it.skipIf(!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js')))('continues after a decider question without repeating its paused provider invocation', async () => {
  const actual = await execute('freestyle', false, false, 'loop-decider', 'selected-decider')
  expect(actual.calls.map(call => call.role)).toEqual(['prompt', 'prompt', 'loop-decider', 'prompt', 'loop-decider'])
  expect(actual.calls[3].prompt).toContain('Return two')
  expect(actual.calls.filter(call => call.role === 'loop-decider')).toHaveLength(2)
  expect(actual.calls.filter(call => call.role === 'loop-decider').map(call => call.model)).toEqual(['selected-decider', 'selected-decider'])
  expect(actual.calls.filter(call => call.role === 'prompt').every(call => call.model !== 'selected-decider')).toBe(true)
}, 180_000)

it.skipIf(!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js'))).each(['implement', 'batch'])('executes the converted legacy %s factory with actual implementation evidence', async mode => {
  const actual = await execute(mode, false, false, undefined, undefined, true)
  const count = mode === 'batch' ? 2 : 1
  for (const role of ['architect', 'developer', 'reviewer']) expect(actual.calls.filter(call => call.role === role)).toHaveLength(count)
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)
