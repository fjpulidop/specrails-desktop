import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createJob, initDb, type DbInstance } from '../../../db'
import { createLoopRun } from '../../loops/runtime/loop-runs-store'
import { AgentRuntimeControls } from './agent-runtime-controls'
import { runAgentRuntimeInvocation } from './agent-runtime-bridge'
import { resetCoreAgentRuntimeApiCache } from './agent-runtime-loader'
import { resolveRetainedAgentRuntime } from './agent-runtime-package'
import type { ProjectContext } from '../../../project-registry'
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
vi.mock('../../../workspace-resolution', () => ({ resolveProjectExecution: (project: { path: string }) => ({ specrailsDir: path.join(project.path, '.specrails') }), resolveLoopBaseEnv: () => ({ ...process.env }) }))
const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
let root: string, db: DbInstance, controls: AgentRuntimeControls | undefined
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retained runtime gc pairing '))); db = initDb(':memory:')
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'))
  if (core) vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', path.join(core, 'dist/agent-runtime/index.js'))
  resetCoreAgentRuntimeApiCache()
})
afterEach(() => { controls?.shutdown(); controls = undefined; db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }) })
it.skipIf(!core || !fs.existsSync(path.join(core, 'dist/agent-runtime/cli.js')))('expires actual Core histories while protecting every surviving original package pin', async () => {
  expect(spawnSync('git', ['init', '-q', root]).status).toBe(0)
  expect(spawnSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline']).status).toBe(0)
  const config = path.join(root, 'runtime-config.json')
  fs.copyFileSync(path.join(core!, 'src/agent-runtime/engine/__fixtures__/acceptance/runtime-config.json'), config)
  const contexts: string[] = []
  for (const runId of ['old-run', 'recent-run']) {
    const directory = path.join(root, '.specrails/pipeline', runId); fs.mkdirSync(directory, { recursive: true })
    const contextPath = path.join(directory, 'desktop-context.json'); contexts.push(contextPath)
    fs.writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId, backlogRoot: root, artifactRoot: root, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: root }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Inspect', description: 'Read-only fixture' }] }))
    const result = await runAgentRuntimeInvocation({ contextPath, configPath: config, change: `retention-${runId}`, cwd: root, env: { ...process.env, SPECRAILS_GIT_AUTO: 'false' }, engineVersion: 2,
      prepareDefinition: () => ({ schemaVersion: 1, id: 'retention-fixture', title: 'Retention fixture', journal: 'ledger-only', change: 'none', entry: 'done', roles: [], maxTransitions: 1,
        nodes: { done: { kind: 'end', params: { outcome: 'success' }, ends: {} } }, delivery: { requiresVerified: false } }), timeoutMs: 30_000 })
    expect(result).toMatchObject({ failed: false, runtimeStatus: 'succeeded' })
    createJob(db, { id: runId, command: 'loop:fixture', started_at: '2000-01-01T00:00:00Z', owner: 'loop' })
    createLoopRun(db, { id: runId, projectId: 'project', loopId: 'fixture', iterationLimit: 1, startedAt: '2000-01-01T00:00:00Z' })
    db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(runId)
    db.prepare("UPDATE loop_runs SET status='completed',final_outcome='success',engine_version=2,finished_at=? WHERE id=?").run(runId === 'old-run' ? '2000-01-02 00:00:00' : new Date().toISOString(), runId)
  }
  const retained = resolveRetainedAgentRuntime(contexts[0])
  expect(resolveRetainedAgentRuntime(contexts[1])).toBe(retained)
  const pin = JSON.parse(fs.readFileSync(path.join(path.dirname(contexts[0]), 'desktop-runtime-package.json'), 'utf8'))
  fs.utimesSync(pin.root, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'))
  controls = new AgentRuntimeControls({ project: { id: 'project', path: root }, db } as Pick<ProjectContext, 'project' | 'db'>)
  controls.configureRetention({ days: 30 })
  const first = await controls.collectRetention({ dryRun: false })
  expect(first, JSON.stringify(first)).toMatchObject({ runs: expect.arrayContaining([{ runId: 'old-run', collect: true, reasons: [], state: 'expired' }, expect.objectContaining({ runId: 'recent-run', state: 'protected', reasons: ['within_retention'] })]), packages: [], errors: [] })
  expect(resolveRetainedAgentRuntime(contexts[1])).toBe(retained)
  expect(fs.existsSync(contexts[0])).toBe(false)
  db.prepare("UPDATE loop_runs SET finished_at='2000-01-02 00:00:00' WHERE id='recent-run'").run()
  const second = await controls.collectRetention({ dryRun: false })
  expect(second, JSON.stringify(second)).toMatchObject({ runs: [{ runId: 'recent-run', state: 'expired' }], packages: [pin.integrity], errors: [] })
  expect(fs.existsSync(retained)).toBe(false)
  expect(fs.existsSync(path.join(core!, 'dist/agent-runtime/cli.js'))).toBe(true)
  expect(db.prepare('SELECT count(*) total FROM jobs').get()).toEqual({ total: 2 })
  // Each run retains a full copy of Core's dependency closure and hashes it; on
  // Windows runners that file copy alone is several times slower than on Linux.
}, 480_000)
