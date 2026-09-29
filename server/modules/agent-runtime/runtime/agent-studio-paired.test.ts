import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from '../../../db'
import { createProfilesRouter } from '../../agents/runtime/profiles-router'
import { compileLoopToDefinition } from '../../loops/runtime/loop-definition'
import type { LoopGraph } from '../../loops/runtime/loop-graph'
import { runAgentRuntimeInvocation } from './agent-runtime-bridge'
import { resetCoreAgentRuntimeApiCache } from './agent-runtime-loader'
import { registerAgentRuntimeSettingsRoutes } from './agent-runtime-settings-router'

vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
vi.mock('./agent-runtime-package', async importOriginal => ({
  ...await importOriginal<typeof import('./agent-runtime-package')>(), retainAgentRuntime: (cli: string) => cli,
}))
const core = process.env.SPECRAILS_CORE_SOURCE_DIR ?? process.env.SPECRAILS_EFFICIENCY_CORE_ROOT
let root: string, db: DbInstance
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio pairing ')))
  db = initDb(':memory:')
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'))
  if (core) vi.stubEnv('SPECRAILS_CORE_RUNTIME_PATH', path.join(core, 'dist/agent-runtime/index.js'))
  resetCoreAgentRuntimeApiCache()
})
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }) })

it.skipIf(!core || !fs.existsSync(path.join(core, 'dist/agent-runtime/cli.js')))('creates a Studio role, publishes its descriptor to the builder and preserves read-only Core CLI arguments', async () => {
  const repository = path.join(root, 'repository'); fs.mkdirSync(repository)
  expect(spawnSync('git', ['init', '-q', repository]).status).toBe(0)
  expect(spawnSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline']).status).toBe(0)
  const project = { id: 'project', path: repository, provider: 'claude', providers: ['claude'] }
  const ctx = { project, db, broadcast: vi.fn() }
  const app = express(); app.use(express.json())
  app.use('/api/projects/:projectId/profiles', (req, _res, next) => { Object.assign(req, { projectCtx: ctx }); next() }, createProfilesRouter())
  const router = express.Router(); registerAgentRuntimeSettingsRoutes({ router, ctx: () => ctx as never }); app.use('/api/projects', router)
  const body = '---\nname: custom-auditor\ndescription: Inspect security\naccess: read\nartifacts: none\nengine:\n  provider: claude\n  model: sonnet\n---\nInspect the frozen acceptance requirements without editing source.'
  expect((await request(app).post('/api/projects/project/profiles/catalog').send({ id: 'custom-auditor', body })).status).toBe(201)
  const catalog = await request(app).get('/api/projects/project/profiles/catalog')
  expect(catalog.body.agents).toContainEqual(expect.objectContaining({ id: 'custom-auditor', roleId: 'auditor', runtimeRoleDefaults: expect.objectContaining({ access: 'read', artifacts: 'none' }) }))
  const settings = await request(app).get('/api/projects/project/agent-runtime/config')
  expect(settings.status, JSON.stringify(settings.body)).toBe(200)
  expect(settings.body.config.roles.auditor).toMatchObject({ access: 'read', artifacts: 'none', prompt: expect.stringContaining('without editing source') })

  const configPath = path.join(repository, '.specrails/agent-runtime.json')
  const runtime = path.join(repository, '.specrails/pipeline/studio'); fs.mkdirSync(runtime, { recursive: true })
  const contextPath = path.join(runtime, 'desktop-context.json')
  fs.writeFileSync(contextPath, JSON.stringify({ schemaVersion: 1, runId: 'studio', backlogRoot: repository, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Repo', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 1, title: 'Audit security', description: 'Inspect without editing', repositoryIds: ['repo'], acceptanceCriteria: ['Produce a read-only audit'] }] }))
  const graph: LoopGraph = {
    nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 } },
      { id: 'audit', type: 'core', position: { x: 0, y: 1 }, data: { kind: 'role-turn', params: { roleId: 'auditor', prompt: 'Inspect this repository.' } } },
      { id: 'done', type: 'end', position: { x: 0, y: 2 }, data: { outcome: 'success', requiresVerified: false } },
      { id: 'failed', type: 'end', position: { x: 1, y: 2 }, data: { outcome: 'failure' } }],
    edges: [{ id: 'enter', source: 'start', target: 'audit' }, { id: 'pass', source: 'audit', target: 'done', label: 'next' }, { id: 'fail', source: 'audit', target: 'failed', label: 'failed' }],
    config: { maxIterations: 2, timeoutMinutes: 0, journal: 'ledger-only', change: 'none' },
  }
  const callsFile = path.join(root, 'calls.jsonl')
  const result = await runAgentRuntimeInvocation({ cwd: repository, contextPath, configPath, change: 'studio-audit', engineVersion: 2,
    prepareDefinition: config => compileLoopToDefinition(graph, { id: 'studio-audit', title: 'Audit', provider: 'claude', constants: {}, roles: config.roles }),
    env: { ...process.env, SPECRAILS_STUDIO_CORE: core, SPECRAILS_STUDIO_CALLS: callsFile, NODE_OPTIONS: `--import=${pathToFileURL(path.join(process.cwd(), 'server/modules/agent-runtime/runtime/__fixtures__/studio-role-preload.mjs')).href}` }, timeoutMs: 60_000,
  })
  expect(result, JSON.stringify(result)).toMatchObject({ failed: false, runtimeStatus: 'succeeded' })
  const recorded = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  // Capability help is not an AI turn; all other invocations must be accounted for.
  const calls = recorded.filter(call => call.args[0] !== '--help')
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ command: 'claude', stdin: expect.stringContaining('without editing source') })
  expect(calls[0].args).toEqual(expect.arrayContaining(['--tools', 'Read,Grep,Glob', '--permission-mode', 'plan', '--strict-mcp-config']))
  expect(calls[0].args).not.toContain('--dangerously-skip-permissions')
}, 90_000)
