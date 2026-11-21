import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { retainedRuntimeSupportsPause, runAgentRuntimeControl, runAgentRuntimeInvocation } from '../../agent-runtime/runtime/agent-runtime-bridge'
import { resetCoreAgentRuntimeApiCache } from '../../agent-runtime/runtime/agent-runtime-loader'
import { getFactoryLoop } from './loop-factory'
import { compileLoopToDefinition } from './loop-definition'
import { USER_PAUSE_REASON, userPauseRequestId } from './loop-user-pauses'

// The person's Pause through the REAL bridge and a built Core with `pauseRuns`: an
// Implement run is paused while its first step is in progress; Core finishes that step,
// parks at the next step boundary (`state.pause`, reason `requested`, no completion),
// and Desktop's Resume continues the SAME run in place (no fork, no fresh run) to a
// verified delivery. Only the provider executor is a fixture.
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
const corePauseRuns = (() => {
  if (!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js'))) return false
  const api = spawnSync(process.execPath, [path.join(core, 'dist/agent-runtime/cli.js'), 'api'], { encoding: 'utf8' })
  try { return (JSON.parse(api.stdout.trim().split('\n').at(-1) ?? '{}') as { capabilities?: Record<string, number> }).capabilities?.pauseRuns === 1 } catch { return false }
})()

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'user pause pairing ')))
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'))
  if (core) vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', path.join(core, 'dist/agent-runtime/index.js'))
  resetCoreAgentRuntimeApiCache()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

async function until(condition: () => boolean, label: string, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

it.skipIf(!corePauseRuns)('pauses a running Implement at the next step boundary and resumes the same run in place to a verified delivery', async () => {
  const id = 'pause-v2', repository = path.join(root, id), backlog = path.join(root, id + '-backlog')
  mkdirSync(repository); mkdirSync(backlog)
  expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
  writeFileSync(path.join(repository, 'code.cjs'), 'module.exports = 1\n')
  expect(spawnSync('git', ['-C', repository, 'add', '.']).status).toBe(0)
  expect(spawnSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']).status).toBe(0)
  const pipeline = path.join(backlog, '.specrails/pipeline'), runtime = path.join(pipeline, id); mkdirSync(runtime, { recursive: true })
  const contextPath = path.join(runtime, 'desktop-context.json'), configPath = path.join(root, id + '-config.json')
  const specs = [{ id: 1, title: 'Return two', description: 'code.cjs returns two', repositoryIds: ['repo'], acceptanceCriteria: ['Function returns 2'] }]
  writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId: id, backlogRoot: backlog, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs }))
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, enabled: true, providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }],
    verification: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', 'if(require("./code.cjs")!==2)process.exit(9);console.log("actual value verified")'] }] }))
  const callsFile = path.join(root, 'factory-calls.jsonl'), gate = path.join(root, 'gate'), lines: string[] = []
  const calls = () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0
  const factory = getFactoryLoop('factory:implement', { engineV2: 1, workflowDefinitions: 1, implementationSteps: 1 })!
  const preload = (file: string) => `--import=${pathToFileURL(path.join(process.cwd(), 'server/modules/loops/runtime/__fixtures__', file)).href}`
  const env = { ...process.env, SPECRAILS_GIT_AUTO: 'false', SPECRAILS_FACTORY_CORE: core, SPECRAILS_FACTORY_CALLS: callsFile, SPECRAILS_PAUSE_GATE: gate, SPECRAILS_FACTORY_STALL: '0', SPECRAILS_FACTORY_BLOCK: '', SPECRAILS_FACTORY_ADDENDA: '[]',
    NODE_OPTIONS: `${preload('factory-executor-preload.mjs')} ${preload('pause-gate-executor-preload.mjs')}` }
  const change = 'paired-change'
  const first = runAgentRuntimeInvocation({ contextPath, configPath, cwd: repository, change, env, defaultProvider: 'claude',
    loopConfig: factory.graph.config.agents, engineVersion: 2,
    prepareDefinition: config => compileLoopToDefinition(factory.graph, { id: factory.id, title: factory.name, provider: 'claude', constants: {}, spec: specs[0], roles: config.roles, loopAgents: config, repositoryCount: 1, changeId: change }),
    onLine: line => lines.push(line), timeoutMs: 150_000 })

  // The first step is in progress: the person presses Pause (Desktop's own request, through the retained Core).
  await until(() => existsSync(gate + '.entered'), 'the first step to start')
  const control = { runId: id, contextPath, cwd: repository, env }
  expect(await retainedRuntimeSupportsPause(control)).toBe(true)
  const requestId = userPauseRequestId(id, 1, Date.now())
  const asked = await runAgentRuntimeControl({ kind: 'pause', ...control, requestId, reason: USER_PAUSE_REASON })
  expect(asked).toMatchObject({ kind: 'pause', requestId, reason: 'requested', outcome: 'requested' })
  // Nothing is interrupted: the step in progress finishes, then Core parks at the next boundary.
  writeFileSync(gate + '.open', '')
  const paused = await first
  expect(paused, JSON.stringify(paused).slice(0, 2000)).toMatchObject({ runtimeStatus: 'paused', pause: { requestId, reason: 'requested' } })
  expect(paused.completion ?? null).toBeNull()
  expect(paused.pendingInterrupts ?? []).toEqual([])
  const callsWhenPaused = calls()
  expect(callsWhenPaused).toBe(1)
  expect(readFileSync(path.join(repository, 'code.cjs'), 'utf8')).toBe('module.exports = 1\n')

  // Resume: the same retained run continues in place (no fork, no fresh run) and delivers.
  const resumed = await runAgentRuntimeInvocation({ contextPath, cwd: repository, env, engineVersion: 2, resume: true, onLine: line => lines.push(line), timeoutMs: 150_000 })
  expect(resumed, JSON.stringify(resumed).slice(0, 2000)).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
  expect(readFileSync(path.join(repository, 'code.cjs'), 'utf8')).toBe('module.exports = 2\n')
  // The step that ran before the pause never ran again.
  const roles = readFileSync(callsFile, 'utf8').trim().split('\n').map(line => (JSON.parse(line) as { role: string }).role)
  expect(roles.length).toBeGreaterThan(callsWhenPaused)
  expect(roles.slice(1)).not.toContain(roles[0])
  // One retained run: no fork directory or second run was created.
  expect(readdirSync(pipeline)).toEqual([id])
  expect((JSON.parse(readFileSync(contextPath, 'utf8')) as { runId: string }).runId).toBe(id)
  // A later Pause of the finished run is a reported no-op, never a failure.
  expect(await runAgentRuntimeControl({ kind: 'pause', ...control, requestId: userPauseRequestId(id, 2, Date.now()), reason: USER_PAUSE_REASON })).toMatchObject({ outcome: 'terminal' })
}, 300_000)
