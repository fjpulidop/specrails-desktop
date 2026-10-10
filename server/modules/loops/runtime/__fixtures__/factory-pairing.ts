// Shared real-Core factory pairing harness. Each test file keeps its own
// (hoisted) vi.mock declarations and calls useFactoryPairing() once; this
// module only builds fixture repositories and executes them through Core.
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runAgentRuntimeInvocation } from '../../../agent-runtime/runtime/agent-runtime-bridge'
import { resetCoreAgentRuntimeApiCache } from '../../../agent-runtime/runtime/agent-runtime-loader'
import { getFactoryLoop } from '../loop-factory'
import { convertLegacyLoop, LEGACY_DECIDER_ROLE } from '../loop-compat'
import { compileLoopToDefinition } from '../loop-definition'

export const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
export const coreCliMissing = !core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js'))
let root: string
export function useFactoryPairing() {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'factory pairing ')))
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'))
    if (core) vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', path.join(core, 'dist/agent-runtime/index.js'))
    resetCoreAgentRuntimeApiCache()
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
}
export type Event = Record<string, any>
export const compilerFailures = [
  "src/catalog.ts(12,7): error TS2551: Property 'CATALOG_V2' does not exist on type 'Endpoints'. Did you mean 'CATALOG_V1'?",
  "src/search.ts(23,5): error TS2339: Property 'SEARCH_V2' does not exist on type 'Endpoints'.",
]
export async function execute(mode: string, legacy = false, stall = false, blockAt?: string, decisionModel?: string, converted = false, configurable = false, customStep = false, approval = false, planningQuestion = false, addendaIds: string[] = []) {
  const reviewMode = process.env.SPECRAILS_FACTORY_REVIEW_MODE
  const id = `${mode}-${legacy ? 'legacy' : 'v2'}`, repository = path.join(root, id), backlog = path.join(root, id + '-backlog')
  mkdirSync(repository); mkdirSync(backlog)
  expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
  writeFileSync(path.join(repository, 'code.cjs'), process.env.SPECRAILS_FACTORY_ALREADY_IMPLEMENTED === '1' ? 'module.exports = 2\n' : 'module.exports = 1\n')
  if (process.env.SPECRAILS_FACTORY_REGEX === '1') {
    writeFileSync(path.join(repository, 'modal.txt'), "e.key === 'Escape' &&\n!confirmPending")
    writeFileSync(path.join(repository, 'guard.test.cjs'), `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst guard = /e\\.key === 'Escape' && !confirmPending/;\ntest('cancelling confirmation preserves the queue', () => { assert.match(fs.readFileSync('modal.txt', 'utf8'), guard); assert.doesNotMatch("e.key === 'Escape' &&\\ntrue", guard); });\ntest('required feature returns two', () => assert.equal(require('./code.cjs'), 2));\n`)
  }
  if (process.env.SPECRAILS_FACTORY_TYPESCRIPT_FAILURE === '1') {
    // A real portable subprocess supplies evidence. Keep diagnostics out of its
    // argv, and beyond both output tails, so prompt assertions test the summary.
    writeFileSync(path.join(repository, 'compiler-check.cjs'), `const noise = Array.from({ length: 120 }, (_, i) => 'lint warning ' + i + ': ' + 'context '.repeat(30));\nconsole.log(['✖ 74 problems (0 errors, 74 warnings)', ...noise, ...${JSON.stringify(compilerFailures)}, ...noise].join('\\n'));\nprocess.exitCode = 2;\n`)
  }
  expect(spawnSync('git', ['-C', repository, 'add', '.']).status).toBe(0)
  expect(spawnSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']).status).toBe(0)
  const runtime = path.join(backlog, '.specrails/pipeline', id); mkdirSync(runtime, { recursive: true })
  const contextPath = path.join(runtime, 'desktop-context.json'), configPath = path.join(root, id + '-config.json')
  const specs = [1].map(ticket => ({ id: ticket, title: 'Return two', description: 'code.cjs returns two', repositoryIds: ['repo'], acceptanceCriteria: ['Function returns 2'] }))
  writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId: id, backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs }))
  // Keep Desktop's fixture self-contained so it also exercises the published
  // Core package, which intentionally does not include its source/test tree.
  const config = { schemaVersion: 1, enabled: true, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }],
    agents: { architect: { provider: 'claude' }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } },
    verification: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9);console.log("actual value verified")'] }],
  }
  if (process.env.SPECRAILS_FACTORY_REGEX === '1') config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['--test', '--test-reporter=spec', 'guard.test.cjs'] }]
  if (process.env.SPECRAILS_FACTORY_TYPESCRIPT_FAILURE === '1') config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['compiler-check.cjs'] }]
  writeFileSync(configPath, JSON.stringify(config))
  const callsFile = path.join(root, id + '-calls.jsonl'), events: Event[] = [], lines: string[] = []
  const change = 'paired-change'
  let factory = getFactoryLoop(mode === 'quick-sdd' ? 'factory:sdd-quick-openspec' : `factory:${mode}`, { engineV2: 1, workflowDefinitions: 1, implementationSteps: 1, ...(configurable ? { workflowAgentSteps: 1 } : {}) })!
  if (reviewMode) factory.graph.config.maxTransitions = 80
  if (process.env.SPECRAILS_FACTORY_CORRECTION_QUESTION === '1') {
    factory.graph.edges.find(edge => edge.source === 'begin-correction')!.target = 'ask-first-correction'
    factory.graph.nodes.push(
      { id: 'ask-first-correction', type: 'core', position: { x: 360, y: 800 }, data: { kind: 'condition', params: { expr: '$vars.correctionAttempts == 1' } } },
      { id: 'correction-question', type: 'core', position: { x: 360, y: 940 }, data: { kind: 'question', params: { text: 'Confirm the first correction?' } } },
    )
    factory.graph.edges.push(
      { id: 'ask-first-yes', source: 'ask-first-correction', target: 'correction-question', label: 'true' },
      { id: 'ask-first-no', source: 'ask-first-correction', target: 'fixer', label: 'false' },
      { id: 'correction-answer', source: 'correction-question', target: 'fixer', label: 'next' },
    )
  }
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
    onRuntimeEvent: event => events.push(event), onLine: line => lines.push(line), timeoutMs: 150_000,
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
  const correctionStalled = process.env.SPECRAILS_FACTORY_NOOP === '1' || ['reject', 'score', 'churn'].includes(reviewMode ?? '')
  expect(result, JSON.stringify({ result, events: events.filter(event => event.type === 'workflow-event' && ['archive', 'approve', 'reviewer', 'verify'].includes(event.event?.nodePath)).slice(0, 20) })).toMatchObject({ failed: stall || correctionStalled })
  if (!legacy && !stall && !correctionStalled) expect(result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
  expect(readFileSync(path.join(repository, 'code.cjs'), 'utf8')).toBe(process.env.SPECRAILS_FACTORY_NOOP === '1' ? 'module.exports = 3\n' : 'module.exports = 2\n')
  return { result, calls, events, repository, lines }
}
