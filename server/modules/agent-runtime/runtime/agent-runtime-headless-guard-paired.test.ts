import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runAgentRuntimeInvocation } from './agent-runtime-bridge'
import { resetCoreAgentRuntimeApiCache } from './agent-runtime-loader'
import { resolveRetainedAgentRuntime } from './agent-runtime-package'
import { ELECTRON_HEADLESS_GUARD_FILE, coreHeadlessGuard } from './agent-runtime-headless-guard'
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))

/**
 * A run that started on a Core without the Electron headless guard keeps that
 * Core when it continues. Desktop must still get the guard into the project's
 * verification commands. The pre-guard Core is a real older build when
 * SPECRAILS_PREGUARD_CORE_SOURCE_DIR names one (Core f7ea5d38); otherwise the
 * paired Core with its guard file removed (it then adds no NODE_OPTIONS either).
 */
const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
const runnable = Boolean(core && coreHeadlessGuard(path.join(core, 'dist/agent-runtime/cli.js')))
const SHIPPED = ['package.json', 'dist', 'bin', 'templates', 'schemas', 'commands', 'integration-contract.json', 'pinned-versions.json']
let root: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'headless guard pairing ')))
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetCoreAgentRuntimeApiCache(); fs.rmSync(root, { recursive: true, force: true }) })

function preGuardCore(): string {
  const explicit = process.env.SPECRAILS_PREGUARD_CORE_SOURCE_DIR
  if (explicit) return explicit
  const copy = path.join(root, 'pre-guard-core')
  for (const entry of SHIPPED) if (fs.existsSync(path.join(core!, entry))) fs.cpSync(path.join(core!, entry), path.join(copy, entry), { recursive: true })
  fs.rmSync(path.join(copy, 'dist', 'pipeline', ELECTRON_HEADLESS_GUARD_FILE))
  fs.symlinkSync(path.join(core!, 'node_modules'), path.join(copy, 'node_modules'), 'junction')
  return copy
}
function useCore(source: string): void {
  vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', path.join(source, 'dist/agent-runtime/index.js'))
  resetCoreAgentRuntimeApiCache()
}

async function verifyAfterContinuing(runId: string, continueOn: 'guarded' | 'pre-guard') {
  const old = preGuardCore()
  expect(coreHeadlessGuard(path.join(old, 'dist/agent-runtime/cli.js'))).toBeNull()
  const repository = path.join(root, `${runId}-repo`)
  fs.mkdirSync(repository)
  expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
  expect(spawnSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline']).status).toBe(0)
  const directory = path.join(root, '.specrails', 'pipeline', runId); fs.mkdirSync(directory, { recursive: true })
  const contextPath = path.join(directory, 'desktop-context.json'), configPath = path.join(root, 'runtime-config.json'), probe = path.join(root, `${runId}-probe.json`)
  fs.copyFileSync(path.join(core!, 'src/agent-runtime/engine/__fixtures__/acceptance/runtime-config.json'), configPath)
  fs.writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId, backlogRoot: repository, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Verify', description: 'Headless verification fixture' }] }))
  // The verification command records what a project's test runner would see.
  const record = `require('fs').writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS ?? null, headless: process.env.SPECRAILS_HEADLESS ?? null, guard: globalThis.__specrailsHeadlessGuard ?? null }))`
  const env = { ...process.env, SPECRAILS_GIT_AUTO: 'false', SPECRAILS_HEADLESS: undefined, NODE_OPTIONS: undefined }
  useCore(old)
  const started = await runAgentRuntimeInvocation({ contextPath, configPath, change: `guard-${runId}`, cwd: repository, env, engineVersion: 2, timeoutMs: 90_000,
    prepareDefinition: () => ({ schemaVersion: 1, id: 'headless-guard', title: 'Headless guard', journal: 'ledger-only', change: 'none', entry: 'ask', roles: [], maxTransitions: 5, delivery: { requiresVerified: false }, nodes: {
      ask: { kind: 'question', params: { text: 'Continue?' }, ends: { next: 'verify' } },
      verify: { kind: 'verify', params: { commands: [{ repositoryId: 'repo', command: process.execPath, args: ['-e', record] }] }, ends: { pass: 'done', fail: 'failed', failed: 'failed' } },
      done: { kind: 'end', params: { outcome: 'success' }, ends: {} },
      failed: { kind: 'end', params: { outcome: 'failure' }, ends: {} },
    } }) })
  expect(started, JSON.stringify(started)).toMatchObject({ failed: false, runtimeStatus: 'paused' })
  // The run keeps its pre-guard Core; Desktop updates to a Core that ships the guard.
  const retained = await resolveRetainedAgentRuntime(contextPath)
  expect(coreHeadlessGuard(retained)).toBeNull()
  if (continueOn === 'guarded') useCore(core!)
  const lines: string[] = []
  const finished = await runAgentRuntimeInvocation({ contextPath, cwd: repository, env, engineVersion: 2, resume: true, answer: 'Yes', interruptId: started.pendingInterrupts![0].id, onLine: line => lines.push(line), timeoutMs: 90_000 })
  expect(finished, JSON.stringify(finished)).toMatchObject({ failed: false, runtimeStatus: 'succeeded' })
  return { seen: JSON.parse(fs.readFileSync(probe, 'utf8')) as { nodeOptions: string | null; headless: string | null; guard: unknown }, copy: path.join(directory, ELECTRON_HEADLESS_GUARD_FILE), lines }
}

it.skipIf(!runnable)('a run continuing on a retained pre-guard Core loads the installed Core guard into its verification commands', async () => {
  const { seen, copy, lines } = await verifyAfterContinuing('continued', 'guarded')
  expect(seen.headless).toBe('1')
  expect(seen.nodeOptions).toContain(`--require ${JSON.stringify(copy)}`)
  expect(seen.nodeOptions!.split(ELECTRON_HEADLESS_GUARD_FILE)).toHaveLength(2)
  // Loaded in the verification process itself: in plain Node it forwards itself to children (Electron included).
  expect(seen.guard).toEqual({ forwarding: true })
  expect(fs.readFileSync(copy, 'utf8')).toBe(fs.readFileSync(coreHeadlessGuard(path.join(core!, 'dist/agent-runtime/cli.js'))!, 'utf8'))
  expect(lines.join('')).toContain('Desktop applies it')
}, 480_000)

it.skipIf(!runnable)('control: without any guard to copy, the pre-guard Core leaves verification unguarded and says so', async () => {
  const { seen, copy, lines } = await verifyAfterContinuing('unguarded', 'pre-guard')
  expect(seen).toEqual({ nodeOptions: null, headless: '1', guard: null })
  expect(fs.existsSync(copy)).toBe(false)
  expect(lines.join('')).toContain('may be visible')
}, 480_000)
