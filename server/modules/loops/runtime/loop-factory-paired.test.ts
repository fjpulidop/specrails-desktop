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
import { configurableImplementGraph } from './loop-implement-recipe'
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
async function execute(mode: string, legacy = false, stall = false, blockAt?: string, decisionModel?: string, converted = false, configurable = false, customStep = false, approval = false, planningQuestion = false, addendaIds: string[] = []) {
  const id = `${mode}-${legacy ? 'legacy' : 'v2'}`, repository = path.join(root, id), backlog = path.join(root, id + '-backlog')
  mkdirSync(repository); mkdirSync(backlog)
  expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
  writeFileSync(path.join(repository, 'code.cjs'), 'module.exports = 1\n')
  if (process.env.SPECRAILS_FACTORY_REGEX === '1') {
    writeFileSync(path.join(repository, 'modal.txt'), "e.key === 'Escape' &&\n!confirmPending")
    writeFileSync(path.join(repository, 'guard.test.cjs'), `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst guard = /e\\.key === 'Escape' && !confirmPending/;\ntest('cancelling confirmation preserves the queue', () => { assert.match(fs.readFileSync('modal.txt', 'utf8'), guard); assert.doesNotMatch("e.key === 'Escape' &&\\ntrue", guard); });\ntest('required feature returns two', () => assert.equal(require('./code.cjs'), 2));\n`)
  }
  expect(spawnSync('git', ['-C', repository, 'add', '.']).status).toBe(0)
  expect(spawnSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']).status).toBe(0)
  const runtime = path.join(backlog, '.specrails/pipeline', id); mkdirSync(runtime, { recursive: true })
  const contextPath = path.join(runtime, 'desktop-context.json'), configPath = path.join(root, id + '-config.json')
  const specs = [1].map(ticket => ({ id: ticket, title: 'Return two', description: 'code.cjs returns two', repositoryIds: ['repo'], acceptanceCriteria: ['Function returns 2'] }))
  writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId: id, backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs }))
  const config = JSON.parse(readFileSync(path.join(core!, 'src/agent-runtime/engine/__fixtures__/acceptance/runtime-config.json'), 'utf8'))
  config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9);console.log("actual value verified")'] }]
  if (process.env.SPECRAILS_FACTORY_REGEX === '1') config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['--test', '--test-reporter=spec', 'guard.test.cjs'] }]
  writeFileSync(configPath, JSON.stringify(config))
  const callsFile = path.join(root, id + '-calls.jsonl'), events: Event[] = []
  const change = 'paired-change'
  let factory = getFactoryLoop(mode === 'quick-sdd' ? 'factory:sdd-quick-openspec' : `factory:${mode}`, { engineV2: 1, workflowDefinitions: 1, implementationSteps: 1, ...(configurable ? { workflowAgentSteps: 1 } : {}) })!
  if (approval) factory.graph.nodes.find(node => node.id === 'approve')!.data!.params!.enabled = true
  if (customStep) {
    factory.graph.config.agents!.roles!.accessibility = { provider: 'claude', access: 'read', artifacts: 'none', prompt: 'Review accessibility against the actual requirements.' }
    factory.graph.nodes.push({ id: 'accessibility', type: 'core', position: { x: 360, y: 800 }, data: { kind: 'role-turn', params: { roleId: 'accessibility', prompt: 'Review actual code read-only.' } } })
    factory.graph.edges.find(edge => edge.source === 'verify' && edge.label === 'pass')!.target = 'accessibility'
    factory.graph.edges.push({ id: 'a-next', source: 'accessibility', target: 'reviewer', label: 'next' }, { id: 'a-failed', source: 'accessibility', target: 'failed', label: 'failed' })
  }
  if (converted) {
    const old = getFactoryLoop(`factory:${mode}`)!
    const projection = convertLegacyLoop(old.graph, { repositoryId: 'repo' })
    if (!projection.ok) throw Error(JSON.stringify(projection.issues))
    factory = { ...old, graph: projection.graph }
  }
  const env = { ...process.env, SPECRAILS_GIT_AUTO: 'false', SPECRAILS_FACTORY_CORE: core, SPECRAILS_FACTORY_CALLS: callsFile, SPECRAILS_FACTORY_STALL: stall ? '1' : '0', SPECRAILS_FACTORY_BLOCK: blockAt ?? '', SPECRAILS_FACTORY_ADDENDA: JSON.stringify(addendaIds),
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(process.cwd(), 'server/modules/loops/runtime/__fixtures__/factory-executor-preload.mjs')).href}` }
  let result = await runAgentRuntimeInvocation({ contextPath, configPath, cwd: repository, change, env,
    ...(!legacy && factory.graph.config.agents ? { loopConfig: factory.graph.config.agents } : {}),
    ...(decisionModel ? { workflowRoleBindings: { 'loop-decider': { provider: 'claude', model: decisionModel, access: 'read' as const, artifacts: 'none' as const } } } : {}),
    ...(converted && factory.graph.config.legacyDeciderRole ? { workflowRoleBindings: { [LEGACY_DECIDER_ROLE]: { provider: 'claude', access: 'read' as const, artifacts: 'none' as const } } } : {}),
    ...(!legacy ? { engineVersion: 2 as const, prepareDefinition: config => compileLoopToDefinition(factory.graph, { id: factory.id, title: factory.name, provider: 'claude', constants: {}, spec: specs[0], roles: config.roles, ...(factory.graph.config.agents ? { loopAgents: config } : {}), repositoryCount: 1, changeId: change, addendaIds }) } : {}),
    onRuntimeEvent: event => events.push(event), timeoutMs: 150_000,
  })
  if (blockAt) {
    expect(result).toMatchObject({ failed: false, runtimeStatus: 'paused' })
    expect(result.pendingInterrupts).toHaveLength(1)
    expect(readFileSync(path.join(repository, 'code.cjs'), 'utf8')).toBe(blockAt === 'loop-decider' ? 'module.exports = 2\n' : 'module.exports = 1\n')
    result = await runAgentRuntimeInvocation({ contextPath, cwd: repository, env, engineVersion: 2, resume: true,
      answer: 'Return two', interruptId: result.pendingInterrupts![0].id, onRuntimeEvent: event => events.push(event), timeoutMs: 150_000 })
  }
  if (planningQuestion) {
    expect(result).toMatchObject({ failed: false, runtimeStatus: 'paused' })
    result = await runAgentRuntimeInvocation({ contextPath, cwd: repository, env, engineVersion: 2, resume: true,
      answer: 'Return two', interruptId: result.pendingInterrupts![0].id, onRuntimeEvent: event => events.push(event), timeoutMs: 150_000 })
  }
  if (approval) {
    expect(result).toMatchObject({ failed: false, runtimeStatus: 'paused' })
    expect(result.pendingInterrupts).toHaveLength(1)
    result = await runAgentRuntimeInvocation({ contextPath, cwd: repository, env, engineVersion: 2, resume: true,
      approve: [result.pendingInterrupts![0].id], onRuntimeEvent: event => events.push(event), timeoutMs: 150_000 })
  }
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Event) : []
  const correctionStalled = process.env.SPECRAILS_FACTORY_NOOP === '1'
  expect(result, JSON.stringify({ result, events: events.filter(event => event.type === 'workflow-event' && ['archive', 'approve', 'reviewer', 'verify'].includes(event.event?.nodePath)).slice(0, 20) })).toMatchObject({ failed: stall || correctionStalled })
  if (!legacy && !stall && !correctionStalled) expect(result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
  expect(readFileSync(path.join(repository, 'code.cjs'), 'utf8')).toBe(correctionStalled ? 'module.exports = 3\n' : 'module.exports = 2\n')
  return { result, calls, events, repository }
}
it.skipIf(!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js'))).each(['implement', 'quick-sdd', 'freestyle'])('executes the %s factory through the real bridge and Core with deterministic local executors', async mode => {
  const actual = await execute(mode)
  if (mode === 'implement') {
    const legacy = await execute(mode, true)
    expect(actual.calls.map(call => call.role)).toEqual(legacy.calls.map(call => call.role))
    expect(actual.calls.map(call => call.role)).toEqual(['architect', 'developer', 'reviewer'])
  } else if (mode === 'quick-sdd') {
    expect(actual.calls.map(call => call.nativeCommand.id)).toEqual(['opsx:ff', 'opsx:apply'])
  } else {
    expect(actual.calls.map(call => call.role)).toEqual(['prompt', 'prompt', 'loop-decider'])
    expect(actual.calls[0].prompt).toContain('Title: Return two')
    expect(actual.calls[0].prompt).toContain('code.cjs returns two')
    expect(actual.calls[0].prompt).not.toContain('openspec-apply-change')
    expect(actual.calls[1].prompt).not.toContain('openspec-apply-change')
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

it.skipIf(!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js'))).each(['implement'])('executes the converted legacy %s factory with actual implementation evidence', async mode => {
  const actual = await execute(mode, false, false, undefined, undefined, true)
  for (const role of ['architect', 'developer', 'reviewer']) expect(actual.calls.filter(call => call.role === role)).toHaveLength(1)
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
  // Compare with the original engine on the same factory: it must match exactly.
  const original = await execute(mode, true)
  expect(actual.calls.map(call => call.role)).toEqual(original.calls.map(call => call.role))
}, 180_000)


it.skipIf(!core)('executes configurable Implement with arbitrary loop-owned agents and real artifacts and verification', async () => {
  const actual = await execute('implement', false, false, undefined, undefined, false, true, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'accessibility', 'assess'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)
it.skipIf(!core)('routes failed verification to the configurable correction agent and repeats host gates', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_CORRECT', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'correct', 'assess'])
}, 180_000)

it.skipIf(!core)('stops configurable Implement after an unchanged correction without repeating failed host checks', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_CORRECT', '1')
  vi.stubEnv('SPECRAILS_FACTORY_NOOP', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'correct'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'failed', completion: { ok: false, verified: false }, errorText: expect.stringContaining('Queue-modal test is outside the approved scope') })
  const starts = actual.events.filter(event => event.type === 'workflow-event' && event.event.type === 'step_started').map(event => event.event.nodePath)
  expect(starts.filter(node => node === 'verify')).toHaveLength(1)
  expect(starts).toContain('correction-stalled')
  expect(starts).not.toContain('reviewer')
  expect(starts).not.toContain('archive')
}, 180_000)

it.skipIf(!core)('delivers a pre-existing formatting test failure to the configurable fixer and verifies its minimal repair', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_REGEX', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'correct', 'assess'])
  const prompt = actual.calls.find(call => call.role === 'correct')!.prompt
  for (const value of ['failureSummary', 'evidenceId', 'guard.test.cjs', 'ERR_ASSERTION', 'expected:', 'An unchanged file or a pre-existing test does not prove', 'Latest review findings']) expect(prompt).toContain(value)
  expect(readFileSync(path.join(actual.repository, 'guard.test.cjs'), 'utf8')).toContain('&&\\s*!confirmPending/')
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)

it.skipIf(!core)('resumes candidate-bound approval in configurable Implement without replaying its agents', async () => {
  const actual = await execute('implement', false, false, undefined, undefined, false, true, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'assess'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)

it.skipIf(!core)('investigates low planning confidence before asking, then resumes the generic Implement recipe', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_CONFIDENCE', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true, false, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'plan', 'plan', 'build', 'assess'])
  expect(actual.calls[2].prompt).toContain('Return two')
}, 180_000)


it.skipIf(!core)('admits Implement addendum gates and rejects missing, partial or unverified delta coverage', async () => {
  const { validateWorkflowDefinition } = await import(pathToFileURL(path.join(core!, 'dist/agent-runtime/engine/definition-validator.js')).href)
  const { validationPieceRegistry } = await import(pathToFileURL(path.join(core!, 'dist/agent-runtime/engine/pieces/index.js')).href)
  const { parseExpression } = await import(pathToFileURL(path.join(core!, 'dist/agent-runtime/engine/expressions.js')).href)
  const addendaIds = Array.from({ length: 50 }, (_, index) => `addendum-${index}`)
  const definition = compileLoopToDefinition(configurableImplementGraph(), { id: 'factory:implement', provider: 'claude', constants: {}, addendaIds })
  const admitted = validateWorkflowDefinition(definition, validationPieceRegistry(), {}, { structural: true })
  expect(admitted.ok, JSON.stringify(admitted.errors)).toBe(true)
  const gates = Object.values(definition.nodes).filter(node => node.kind === 'condition' && String(node.params.expr).includes('.addenda.'))
  expect(gates).toHaveLength(5)
  const reports = Object.fromEntries(addendaIds.map((id, index) => [`a${index}`, { id, verdict: 'applied', files: ['src/file.ts'], tests: ['unit test passed'] }]))
  const passes = () => gates.every(gate => parseExpression(gate.params.expr).evaluate({ $outputs: { reviewer: { structured: { addenda: reports } } } }))
  expect(passes()).toBe(true)
  reports.a49.verdict = 'partial'
  expect(passes()).toBe(false)
  reports.a49.verdict = 'blocked'
  expect(passes()).toBe(false)
  reports.a49.verdict = 'applied'
  reports.a49.tests = []
  expect(passes()).toBe(false)
  reports.a49.tests = ['unit test passed']; reports.a49.files = []
  expect(passes()).toBe(false)
  delete reports.a49
  expect(passes()).toBe(false)
})


it.skipIf(!core)('corrects a partial addendum before archiving through the real Implement runtime', async () => {
  const actual = await execute('implement', false, false, undefined, undefined, false, true, false, false, false, ['a1'])
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'assess', 'correct', 'assess'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)

it.skipIf(!core)('clears previous review findings when a review correction breaks host verification', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_STALE_REVIEW', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true, false, false, false, ['a1'])
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'assess', 'correct', 'correct', 'assess'])
  const corrections = actual.calls.filter(call => call.role === 'correct')
  const reviewContext = (prompt: string) => prompt.split('Latest review findings for this candidate:')[1].split('Prior execution:')[0]
  expect(reviewContext(corrections[0].prompt)).toContain('"verdict":"partial"')
  expect(reviewContext(corrections[1].prompt)).toContain('No reviewer findings for the current verified candidate')
  expect(reviewContext(corrections[1].prompt)).not.toContain('"verdict":"partial"')
  expect(corrections[1].prompt).toContain('"exitCode":9')
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)
