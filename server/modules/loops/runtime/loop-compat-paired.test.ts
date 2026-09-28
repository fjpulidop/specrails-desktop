import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runAgentRuntimeInvocation } from '../../agent-runtime/runtime/agent-runtime-bridge'
import { resetCoreAgentRuntimeApiCache } from '../../agent-runtime/runtime/agent-runtime-loader'
import { convertLegacyLoop, LEGACY_DECIDER_ROLE } from './loop-compat'
import { compileLoopToDefinition } from './loop-definition'
import { initDb } from '../../../db'
import { LoopRunManager } from './loop-run-manager'
import { getLoopRun } from './loop-runs-store'
import { FACTORY_LOOPS } from './loop-factory'
import { LEGACY_LOOP_TEMPLATES } from './loop-templates'
import { opsxLifecycleGraph } from './loop-templates'
import type { LoopGraph } from './loop-graph'
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
vi.mock('../../agent-runtime/runtime/agent-runtime-package', async original => {
  const selected = new Map<string, string>()
  return { ...await original<typeof import('../../agent-runtime/runtime/agent-runtime-package')>(),
    retainAgentRuntime: (cli: string, context: string) => { selected.set(context, cli); return cli },
    resolveRetainedAgentRuntime: (context: string) => selected.get(context),
  }
})
const core = process.env.SPECRAILS_CORE_SOURCE_DIR
let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'legacy conversion pairing ')))
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'))
  if (core) vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', path.join(core, 'dist/agent-runtime/index.js'))
  resetCoreAgentRuntimeApiCache()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
const prompt = (text: string) => ({ role: 'prompt', text })
const decision = (text = '{"verdict":"stop","reason":"Claims completion"}') => ({ role: LEGACY_DECIDER_ROLE, text })
function legacy(maxIterations = 3): LoopGraph {
  return { nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 } },
    { id: 'work', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Verify every criterion', requireVerificationPass: true } },
    { id: 'decide', type: 'decider', position: { x: 0, y: 2 }, data: { goal: 'Complete every criterion' } },
    { id: 'done', type: 'end', position: { x: 0, y: 3 } }],
    edges: [{ id: 'first', source: 'start', target: 'work' }, { id: 'judge', source: 'work', target: 'decide' },
      { id: 'again', source: 'decide', target: 'work', branch: 'continue' }, { id: 'stop', source: 'decide', target: 'done', branch: 'stop' }],
    config: { maxIterations, timeoutMinutes: 0, aiStepTimeoutMinutes: 0 } }
}
interface Response { role: string; text: string; error?: string; createChange?: string; files?: Record<string, string> }
async function execute(source: LoopGraph, plan: Response[], answer?: string, verification = 'process.exit(0)') {
  const converted = convertLegacyLoop(source, { repositoryId: 'repo' })
  if (!converted.ok) throw Error(JSON.stringify(converted.issues))
  const repository = path.join(root, 'repository'); mkdirSync(repository)
  expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
  expect(spawnSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline']).status).toBe(0)
  const runtime = path.join(root, 'runtime'); mkdirSync(runtime)
  const contextPath = path.join(runtime, 'context.json'), configPath = path.join(root, 'config.json'), planPath = path.join(root, 'plan.json'), callsFile = path.join(root, 'calls.jsonl')
  writeFileSync(planPath, JSON.stringify(plan))
  writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId: 'compat', backlogRoot: root, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Required behavior', description: 'Preserve required work', repositoryIds: ['repo'] }] }))
  const config = JSON.parse(readFileSync(path.join(core!, 'src/agent-runtime/engine/__fixtures__/acceptance/runtime-config.json'), 'utf8'))
  config.verification = [{ repositoryId: 'repo', command: process.execPath, args: ['-e', verification] }]
  writeFileSync(configPath, JSON.stringify(config))
  const env = { ...process.env, SPECRAILS_GIT_AUTO: 'false', SPECRAILS_COMPAT_CORE: core, SPECRAILS_COMPAT_PLAN: planPath, SPECRAILS_COMPAT_CALLS: callsFile,
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(process.cwd(), 'server/modules/loops/runtime/__fixtures__/compat-executor-preload.mjs')).href}` }
  let result = await runAgentRuntimeInvocation({ contextPath, configPath, cwd: repository, change: 'compat-change', env, engineVersion: 2,
    prepareDefinition: effective => compileLoopToDefinition(converted.graph, { provider: 'claude', model: 'work-model', roles: effective.roles, constants: {} }),
    workflowRoleBindings: source.nodes.some(node => node.type === 'decider') ? { [LEGACY_DECIDER_ROLE]: { provider: 'claude', model: 'decision-model', access: 'read', artifacts: 'none' } } : undefined, timeoutMs: 60_000 })
  if (answer) {
    expect(result).toMatchObject({ runtimeStatus: 'paused', failed: false })
    result = await runAgentRuntimeInvocation({ contextPath, cwd: repository, env, engineVersion: 2, resume: true, answer, interruptId: result.pendingInterrupts![0].id, timeoutMs: 60_000 })
  }
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  expect(calls.map(call => call.role)).toEqual(plan.map(call => call.role))
  expect(calls.filter(call => call.role === LEGACY_DECIDER_ROLE).every(call => call.model === 'decision-model')).toBe(true)
  return { result, calls }
}
async function executeLegacy(source: LoopGraph, plan: Response[], answer?: string) {
  const db = initDb(':memory:'), roles: string[] = []
  const next = (role: string) => {
    const item = plan[roles.length]
    expect(item?.role).toBe(role); roles.push(role)
    return item
  }
  const manager = new LoopRunManager(db, () => {}, {
    runAiStep: async () => {
      const item = next('prompt')
      // A provider exception or an empty reply is a hard failure with no output.
      if (item.error || !item.text) return { text: '', failed: true, resultIsError: !!item.error, tokens: 0 }
      return { text: item.text, tokens: 5, tokensIn: 3, tokensOut: 2 }
    },
    runDecider: async () => {
      const item = next(LEGACY_DECIDER_ROLE), blocked = /^LOOP_BLOCKED:\s*(.+)$/.exec(item.text)
      if (blocked) return { continue: false, blocked: true, reasoning: blocked[1], parsed: true, tokens: 5 }
      const value = JSON.parse(item.text); return { continue: value.verdict === 'continue', reasoning: value.reason, parsed: true, tokens: 5 }
    },
    runShell: async ({ command, cwd }) => {
      const child = spawnSync(command, { cwd, shell: true, encoding: 'utf8' })
      return { stdout: child.stdout ?? '', stderr: child.stderr ?? '', exitCode: child.status ?? 1, durationMs: 1 }
    },
  }, () => 1000)
  // Shell side effects (visit counters) must not leak into the Core run's repository.
  const cwd = path.join(root, 'legacy'); mkdirSync(cwd, { recursive: true })
  try {
    const running = manager.run({ loopId: 'baseline', runId: 'legacy-baseline', graph: source, projectId: 'fixture', cwd, provider: 'claude', model: 'fixture' })
    if (answer) {
      // A human answers the single pause through the same interactive-turn path the UI uses.
      await vi.waitFor(() => expect(getLoopRun(db, 'legacy-baseline')?.status).toBe('paused'), { timeout: 10_000 })
      expect(manager.sendInteractiveTurn('legacy-baseline', answer)).toBe(true)
    }
    const result = await running
    expect(roles).toEqual(plan.map(item => item.role))
    return result
  } finally { db.close() }
}
const paired = it.skipIf(!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js')))
paired('preserves failed-pass continuation before accepting a later stop with real host evidence', async () => {
  const plan = [prompt('VERIFICATION: FAIL'), decision(), prompt('VERIFICATION: PASS'), decision()]
  expect((await executeLegacy(legacy(), plan)).outcome).toBe('success')
  const { result } = await execute(legacy(), plan)
  expect(result, JSON.stringify(result)).toMatchObject({ runtimeStatus: 'succeeded', failed: false, completion: { ok: true, verified: true } })
}, 90_000)
paired('enforces the decision cap before another expensive work pass', async () => {
  const plan = [prompt('VERIFICATION: FAIL'), decision()]
  expect((await executeLegacy(legacy(1), plan)).outcome).toBe('max-iterations')
  const { result } = await execute(legacy(1), plan)
  expect(result).toMatchObject({ runtimeStatus: 'failed', failed: true, completion: { ok: false, reasons: expect.arrayContaining(['legacy_iteration_limit']) } })
}, 90_000)

paired('consumes a phase recovery allowance once across later decision iterations', async () => {
  const source = legacy()
  source.nodes[1].data = { ...source.nodes[1].data, stopOnFailure: true, failureRecovery: { target: 'work', maxRetries: 1 } }
  const plan = [prompt('VERIFICATION: FAIL'), prompt('VERIFICATION: PASS'),
    decision('{"verdict":"continue","reason":"More work remains"}'), prompt('VERIFICATION: FAIL')]
  expect((await executeLegacy(source, plan)).outcome).toBe('failed')
  const { result } = await execute(source, plan)
  expect(result).toMatchObject({ failed: true, completion: { ok: false, reasons: expect.arrayContaining(['legacy_required_work_failed']) } })
}, 90_000)

paired('repairs only artifacts and returns to the validator without replaying preparation', async () => {
  const source = legacy()
  source.nodes.splice(2, 0, { id: 'validate', type: 'shell', position: { x: 0, y: 2 }, data: {
    command: `"${process.execPath}" -e "const fs=require('node:fs');const n=fs.existsSync('visits')?Number(fs.readFileSync('visits','utf8'))+1:1;fs.writeFileSync('visits',String(n));process.exit(n===2?0:1)"`,
    repositoryId: 'repo', stopOnFailure: true, failureRecovery: { target: 'work', maxRetries: 1, artifactOnly: true },
  } })
  source.nodes[1].data = { prompt: 'Prepare artifacts', stopOnFailure: true }
  source.edges[1].target = 'validate'
  source.edges.push({ id: 'validated', source: 'validate', target: 'decide' })
  source.edges[2].target = 'validate'
  const { result, calls } = await execute(source, [prompt('Artifacts prepared'), prompt('Artifacts repaired'), decision('{"verdict":"continue","reason":"More validation remains"}')])
  expect(result).toMatchObject({ failed: true, completion: { ok: false } })
  expect(calls[1].prompt).toContain('Repair ONLY the OpenSpec artifacts')
  expect(readFileSync(path.join(root, 'repository/visits'), 'utf8')).toBe('3')
}, 90_000)
paired('retains failed-pass state across a human decision without re-evaluating the paused decision', async () => {
  const { result, calls } = await execute(legacy(), [prompt('VERIFICATION: FAIL'), decision('LOOP_BLOCKED: Which scope?'),
    prompt('VERIFICATION: PASS'), decision(), prompt('VERIFICATION: PASS'), decision()], 'Billing only')
  expect(result, JSON.stringify(result)).toMatchObject({ runtimeStatus: 'succeeded', failed: false })
  expect(calls[2].prompt).toContain('Billing only')
}, 90_000)

paired.each([false, true])('converts Quick SDD with pinned validation/archive and bounded artifact repair (%s)', async repair => {
  const base = 'openspec/changes/compat-change/'
  const spec = '## ADDED Requirements\n### Requirement: Return two\nThe function SHALL return two.\n#### Scenario: Load the function\n- **WHEN** value.cjs is loaded\n- **THEN** its value is two\n'
  const files = {
    [base + 'proposal.md']: '## Why\nReturn the required value.\n## What Changes\nUpdate value.cjs.\n## Capabilities\n### New Capabilities\n- value: Return two.\n## Impact\nOne function.\n',
    [base + 'design.md']: '## Design\nSet the value and verify with Node.\n',
    [base + 'specs/value/spec.md']: repair ? 'Invalid specification' : spec,
    [base + 'tasks.md']: '- [ ] 1. Update and verify the function\n',
    'value.cjs': 'module.exports = 1\n',
  }
  const plan: Response[] = [{ ...prompt('Prepared compat-change'), createChange: 'compat-change', files }]
  if (repair) plan.push({ ...prompt('Repaired artifacts'), files: { [base + 'specs/value/spec.md']: spec } })
  plan.push({ ...prompt('VERIFICATION: PASS'), files: { 'value.cjs': 'module.exports = 2\n', [base + 'tasks.md']: '- [x] 1. Update and verify the function\n' } })
  const { result, calls } = await execute(opsxLifecycleGraph(), plan, undefined, 'if(require("./value.cjs")!==2)process.exit(1)')
  expect(result, JSON.stringify(result)).toMatchObject({ runtimeStatus: 'succeeded', failed: false, completion: { ok: true, verified: true } })
  expect(existsSync(path.join(root, 'repository', base))).toBe(false)
  expect(readFileSync(path.join(root, 'repository/openspec/specs/value/spec.md'), 'utf8')).toContain('Return two')
  if (repair) expect(calls[1].prompt).toContain('Repair ONLY the OpenSpec artifacts')
}, 90_000)

paired('validates every saved factory/template conversion with the actual Core catalog', () => {
  const definitions = [...FACTORY_LOOPS, ...LEGACY_LOOP_TEMPLATES].map(source => {
    const converted = convertLegacyLoop(source.graph, { repositoryId: 'repo' })
    if (!converted.ok) throw Error(source.id + ': ' + JSON.stringify(converted.issues))
    return { id: source.id, definition: compileLoopToDefinition(converted.graph, { provider: 'claude', constants: {}, repositoryCount: 2, changeId: 'compat-change', spec: { ticketIds: [1, 2] } }) }
  })
  // One actual Core process validates the complete corpus. Per-run CLI behavior
  // stays covered above; 48 separate CLI startups only duplicate module loading.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const { validateWorkflowDefinition, validationPieceRegistry } = await import(process.argv[1]);
    const registry = validationPieceRegistry();
    const results = JSON.parse(fs.readFileSync(0, 'utf8')).map(({id, definition}) => {
      const result = validateWorkflowDefinition(definition, registry, {}, { structural: true });
      return { id, ok: result.ok, errors: result.ok ? [] : result.errors };
    });
    process.stdout.write(JSON.stringify(results));
  `, pathToFileURL(path.join(core!, 'dist/agent-runtime/engine/index.js')).href], {
    input: JSON.stringify(definitions), encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  })
  expect(child.status, child.stderr).toBe(0)
  const results = JSON.parse(child.stdout) as Array<{ id: string; ok: boolean; errors: unknown[] }>
  expect(results).toHaveLength(definitions.length)
  expect(results.filter(result => !result.ok)).toEqual([])
}, 35_000)

paired.each(['exception', 'empty'])('stops after two consecutive provider failures (%s) before another expensive call', async mode => {
  const source: LoopGraph = { nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 } },
    ...['first', 'second', 'third'].map(id => ({ id, type: 'ai-step' as const, position: { x: 0, y: 1 }, data: { prompt: 'Do required work' } })),
    { id: 'done', type: 'end', position: { x: 0, y: 2 } },
  ], edges: ['start', 'first', 'second', 'third'].map((source, index) => ({ id: String(index), source, target: ['first', 'second', 'third', 'done'][index] })), config: { maxIterations: 3, timeoutMinutes: 0 } }
  const { result } = await execute(source, [
    ...Array.from({ length: 2 }, () => ({ ...prompt(''), ...(mode === 'exception' ? { error: 'Provider unavailable' } : {}) })),
  ])
  expect(result).toMatchObject({ failed: true, runtimeStatus: 'failed' })
}, 90_000)

function unlabeled(maxIterations = 3): LoopGraph {
  const graph = legacy(maxIterations)
  // Legacy fallback: continue follows the first non-end successor, stop the first end.
  graph.edges = graph.edges.map(({ branch: _branch, ...edge }) => edge)
  return graph
}
function sequential(): LoopGraph {
  return { nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 } },
    ...['first', 'second', 'third'].map(id => ({ id, type: 'ai-step' as const, position: { x: 0, y: 1 }, data: { prompt: 'Do required work' } })),
    { id: 'done', type: 'end', position: { x: 0, y: 2 } },
  ], edges: ['start', 'first', 'second', 'third'].map((source, index) => ({ id: String(index), source, target: ['first', 'second', 'third', 'done'][index] })), config: { maxIterations: 3, timeoutMinutes: 0 } }
}
const cont = (reason = 'More work remains') => decision(JSON.stringify({ verdict: 'continue', reason }))
// Differential parity: the same scripted provider sequence runs through the
// original LoopRunManager and the converted Core definition. Both harnesses
// assert the exact invocation order, so branch choices, decision counts and
// the absence of extra expensive calls are compared, not only the outcome.
paired.each([
  { name: 'first-pass success stops once', graph: () => legacy(), plan: [prompt('VERIFICATION: PASS'), decision()], legacy: 'success', core: 'succeeded' },
  { name: 'continue then stop keeps every pass', graph: () => legacy(), plan: [prompt('VERIFICATION: PASS'), cont(), prompt('VERIFICATION: PASS'), decision()], legacy: 'success', core: 'succeeded' },
  { name: 'a missing sentinel counts as a failed pass', graph: () => legacy(), plan: [prompt('Implemented everything'), decision(), prompt('VERIFICATION: PASS'), decision()], legacy: 'success', core: 'succeeded' },
  { name: 'continue verdicts exhaust the decision cap', graph: () => legacy(2), plan: [prompt('VERIFICATION: PASS'), cont(), prompt('VERIFICATION: PASS'), cont()], legacy: 'max-iterations', core: 'failed' },
  { name: 'unlabeled decider edges use the legacy fallback', graph: () => unlabeled(), plan: [prompt('VERIFICATION: PASS'), cont(), prompt('VERIFICATION: PASS'), decision()], legacy: 'success', core: 'succeeded' },
  { name: 'two provider exceptions abort before the third call', graph: sequential, plan: [{ ...prompt(''), error: 'Provider unavailable' }, { ...prompt(''), error: 'Provider unavailable' }], legacy: 'failed', core: 'failed' },
  { name: 'two empty replies abort before the third call', graph: sequential, plan: [prompt(''), prompt('')], legacy: 'failed', core: 'failed' },
])('matches legacy behavior: $name', async ({ graph, plan, legacy: expected, core: status }) => {
  expect((await executeLegacy(graph(), plan)).outcome).toBe(expected)
  const { result } = await execute(graph(), plan)
  expect(result, JSON.stringify(result)).toMatchObject({ runtimeStatus: status, failed: status !== 'succeeded' })
}, 90_000)

function checked(exitWhen: string, options: { stopOnFailure?: boolean } = {}): LoopGraph {
  const graph = legacy()
  graph.nodes.splice(2, 0, { id: 'check', type: 'shell', position: { x: 0, y: 2 }, data: {
    command: `"${process.execPath}" -e "const fs=require('node:fs');const n=fs.existsSync('visits')?Number(fs.readFileSync('visits','utf8'))+1:1;fs.writeFileSync('visits',String(n));process.exit(${exitWhen}?1:0)"`,
    ...options } })
  graph.nodes[1].data = { prompt: 'Implement the change' }
  graph.edges[1].target = 'check'
  graph.edges.push({ id: 'checked', source: 'check', target: 'decide' })
  return graph
}
paired.each([
  { name: 'a passing shell check lets the first stop succeed', graph: () => checked('false'), plan: [prompt('Done'), decision()], legacy: 'success', core: 'succeeded' },
  { name: 'a failed shell check forces one more pass before stopping', graph: () => checked('n===1'), plan: [prompt('Done'), decision(), prompt('Fixed'), decision()], legacy: 'success', core: 'succeeded' },
  { name: 'a required shell check fails the run without deciding', graph: () => checked('true', { stopOnFailure: true }), plan: [prompt('Done')], legacy: 'failed', core: 'failed' },
])('matches legacy shell behavior: $name', async ({ graph, plan, legacy: expected, core: status }) => {
  expect((await executeLegacy(graph(), plan)).outcome).toBe(expected)
  const { result } = await execute(graph(), plan)
  expect(result, JSON.stringify(result)).toMatchObject({ runtimeStatus: status, failed: status !== 'succeeded' })
}, 90_000)

paired.each([
  { name: 'a blocked work step pauses, then repeats with the answer', graph: () => legacy(),
    plan: [prompt('LOOP_BLOCKED: Which scope?'), prompt('VERIFICATION: PASS'), decision()], legacy: 'success', core: 'succeeded' },
  { name: 'a blocked decision continues without re-deciding and keeps the failed pass', graph: () => legacy(),
    plan: [prompt('VERIFICATION: FAIL'), decision('LOOP_BLOCKED: Which scope?'), prompt('VERIFICATION: PASS'), decision(), prompt('VERIFICATION: PASS'), decision()], legacy: 'success', core: 'succeeded' },
])('matches legacy human pauses: $name', async ({ graph, plan, legacy: expected, core: status }) => {
  expect((await executeLegacy(graph(), plan, 'Billing only')).outcome).toBe(expected)
  const { result, calls } = await execute(graph(), plan, 'Billing only')
  expect(result, JSON.stringify(result)).toMatchObject({ runtimeStatus: status, failed: status !== 'succeeded' })
  // The answer reaches the next work invocation in both engines.
  expect(calls.find((call, index) => index > 0 && call.role === 'prompt')?.prompt).toContain('Billing only')
}, 120_000)

function withCondition(): LoopGraph {
  const graph = legacy()
  graph.nodes.splice(2, 0, { id: 'gate', type: 'condition', position: { x: 0, y: 2 }, data: {} })
  graph.edges[1].target = 'gate'
  graph.edges.push({ id: 'through', source: 'gate', target: 'decide' })
  return graph
}
function twoPhase(): LoopGraph {
  const graph = legacy()
  graph.nodes.splice(1, 0, { id: 'prepare', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Prepare the change' } })
  graph.edges[0].target = 'prepare'
  graph.edges.push({ id: 'prepared', source: 'prepare', target: 'work' })
  // The decider's continue branch returns to preparation, not only to the verified phase.
  graph.edges.find(edge => edge.id === 'again')!.target = 'prepare'
  return graph
}
paired.each([
  { name: 'a single-successor condition is a pass-through', graph: withCondition, plan: [prompt('VERIFICATION: PASS'), decision()], legacy: 'success', core: 'succeeded' },
  { name: 'a two-phase pass re-enters at the first phase after continue', graph: twoPhase,
    plan: [prompt('Prepared'), prompt('VERIFICATION: PASS'), cont(), prompt('Prepared again'), prompt('VERIFICATION: PASS'), decision()], legacy: 'success', core: 'succeeded' },
  { name: 'an iteration cap of one accepts a successful first stop', graph: () => legacy(1), plan: [prompt('VERIFICATION: PASS'), decision()], legacy: 'success', core: 'succeeded' },
])('matches legacy saved graphs: $name', async ({ graph, plan, legacy: expected, core: status }) => {
  expect((await executeLegacy(graph(), plan)).outcome).toBe(expected)
  const { result } = await execute(graph(), plan)
  expect(result, JSON.stringify(result)).toMatchObject({ runtimeStatus: status, failed: status !== 'succeeded' })
}, 90_000)

it('refuses to convert a branching condition the legacy runtime cannot execute', () => {
  const graph = withCondition()
  graph.edges.push({ id: 'other', source: 'gate', target: 'done' })
  expect(convertLegacyLoop(graph, { repositoryId: 'repo' })).toMatchObject({ ok: false })
})
