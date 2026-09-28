import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runAgentRuntimeControl, runAgentRuntimeInvocation } from './agent-runtime-bridge'
import { resetCoreAgentRuntimeApiCache } from './agent-runtime-loader'

/* D7 pairing: Desktop's steering control through the real Core CLI, SQLite
 * inbox and prompt admission. Only the provider is a deterministic local
 * executor (the compat preload); the retained package is the built Core. */
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
vi.mock('./agent-runtime-package', async original => {
  const selected = new Map<string, string>()
  return { ...await original<typeof import('./agent-runtime-package')>(),
    retainAgentRuntime: (cli: string, context: string) => { selected.set(context, cli); return cli },
    resolveRetainedAgentRuntime: (context: string) => selected.get(context),
  }
})
const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'steering pairing ')))
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'))
  if (core) vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', path.join(core, 'dist/agent-runtime/index.js'))
  resetCoreAgentRuntimeApiCache()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

it.skipIf(!core || !existsSync(path.join(core, 'dist/agent-runtime/cli.js')))('delivers host steering once through the real Core inbox and rejects a changed retry', async () => {
  const repository = path.join(root, 'repository'); mkdirSync(repository)
  expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
  expect(spawnSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline']).status).toBe(0)
  const runtime = path.join(root, 'runtime'); mkdirSync(runtime)
  const contextPath = path.join(runtime, 'context.json'), configPath = path.join(root, 'config.json'), planPath = path.join(root, 'plan.json'), callsFile = path.join(root, 'calls.jsonl')
  writeFileSync(planPath, JSON.stringify([{ role: 'prompt', text: 'Inspected the parser' }]))
  writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId: 'steering', backlogRoot: root, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Inspect', description: 'Read-only fixture' }] }))
  writeFileSync(configPath, readFileSync(path.join(core!, 'src/agent-runtime/engine/__fixtures__/acceptance/runtime-config.json')))
  const env = { ...process.env, SPECRAILS_GIT_AUTO: 'false', SPECRAILS_COMPAT_CORE: core, SPECRAILS_COMPAT_PLAN: planPath, SPECRAILS_COMPAT_CALLS: callsFile,
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(process.cwd(), 'server/modules/loops/runtime/__fixtures__/compat-executor-preload.mjs')).href}` }
  const paused = await runAgentRuntimeInvocation({ contextPath, configPath, change: 'steering-change', cwd: repository, env, engineVersion: 2, timeoutMs: 60_000,
    prepareDefinition: () => ({ schemaVersion: 1, id: 'steering-fixture', title: 'Steering fixture', journal: 'ledger-only', change: 'none', entry: 'ask', roles: [], maxTransitions: 4,
      nodes: {
        ask: { kind: 'question', params: { text: 'Start?' }, ends: { next: 'inspect' } },
        inspect: { kind: 'prompt', params: { engine: { provider: 'claude' }, text: 'Inspect the project', access: 'read' }, ends: { next: 'done', failed: null } },
        done: { kind: 'end', params: { outcome: 'success' }, ends: {} },
      } }) })
  expect(paused).toMatchObject({ runtimeStatus: 'paused', failed: false })
  const control = { contextPath, cwd: repository, env, runId: 'steering', kind: 'signal' as const }
  const accepted = await runAgentRuntimeControl({ ...control, requestId: 'host-steer-1', text: 'Focus on the parser' })
  expect(accepted).toMatchObject({ kind: 'signal', id: 'host-steer-1' })
  // An uncertain response is retried with the same identity and payload.
  expect(await runAgentRuntimeControl({ ...control, requestId: 'host-steer-1', text: 'Focus on the parser' })).toEqual(accepted)
  // Edited text must use a new identity; the same identity with another payload is refused.
  await expect(runAgentRuntimeControl({ ...control, requestId: 'host-steer-1', text: 'Focus on the lexer' })).rejects.toThrow(/cannot change/)
  const resumed = await runAgentRuntimeInvocation({ contextPath, cwd: repository, env, engineVersion: 2, resume: true, answer: 'Start', interruptId: paused.pendingInterrupts![0].id, timeoutMs: 60_000 })
  expect(resumed, JSON.stringify(resumed)).toMatchObject({ runtimeStatus: 'succeeded', failed: false })
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { prompt: string })
  expect(calls).toHaveLength(1)
  expect(calls[0].prompt.split('Focus on the parser')).toHaveLength(2)
  expect(calls[0].prompt).not.toContain('Focus on the lexer')
}, 120_000)
