import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../auth', () => ({ loadOrGenerateToken: () => 'v2-wp2-projects-test-token' }))
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createHarness, call, type Harness } from '../__fixtures__/harness'
import { registerV2Surface } from '../index'
import { buildToolSpecs } from '../../tools/catalog'
import { approxTokens } from '../core/size-guard'
import { addProject, listProjects } from '../../../desktop-db'
import { manyProjects, startDesktop, type FakeDesktop } from './__fixtures__/wp2-desktop'

// specrails_projects: registry reads in-process, every write through the app's own
// route (recorded by the fake desktop), destructive ones behind a bound confirmation.

type Res = { status(code: number): { json(body: unknown): void }; json(body: unknown): void }
type Req = { body: Record<string, unknown> }

let h: Harness
let desktop: FakeDesktop
let client: Client

async function boot(projects?: Array<{ id: string; slug: string; name: string; path: string }>) {
  h = createHarness({ projects: projects ?? [{ id: 'p1', slug: 'shop-api', name: 'Shop API', path: '/tmp/v2-shop-api' }, { id: 'p2', slug: 'shop-web', name: 'Shop Web', path: '/tmp/v2-shop-web' }, { id: 'p3', slug: 'blog', name: 'Blog', path: '/tmp/v2-blog' }] })
  desktop = await startDesktop(h)
  registerV2Surface(h.server, h.ctx, buildToolSpecs(), { inApp: false })
  client = await h.connect()
}
beforeEach(async () => { await boot() })
afterEach(async () => { await client.close(); await desktop.close() })

const projects = (args: Record<string, unknown>) => call(client, 'specrails_projects', args)
const posts = () => desktop.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body])

describe('list / get / select', () => {
  it('lists with refs, searches fuzzily and puts the session default first', async () => {
    const all = await projects({ action: 'list' })
    expect(all.envelope.data.total).toBe(3)
    expect(all.envelope.data.items[0]).toMatchObject({ ref: expect.stringMatching(/^project:/), providers: ['claude'] })
    expect(all.envelope.summary).toBe('3 projects; default: none (pass project or call select).')
    const shop = await projects({ action: 'list', project: 'shop' })
    expect(shop.envelope.data.items.map((item: { slug: string }) => item.slug).sort()).toEqual(['shop-api', 'shop-web'])
    expect((await projects({ action: 'list', options: { query: 'nothing' } })).envelope.summary).toMatch(/^No project matches/)
    await projects({ action: 'select', project: 'blog' })
    const after = await projects({ action: 'list' })
    expect(after.envelope.data.items[0]).toMatchObject({ slug: 'blog', default: true })
    expect(after.envelope.refs).toEqual({ default: 'project:blog' })
  })

  it('get answers identity, repositories and default; detail adds settings and setup with offers', async () => {
    desktop.on('GET', '/projects/p1/settings', { integrationBranch: 'develop', orchestratorModel: 'sonnet', allowSubagents: false, reviewWipLimit: 2, prePrompt: 'secret prompt text' })
    desktop.on('GET', '/projects/p1/setup/checkpoints', { checkpoints: [{ key: 'a', name: 'Agents', status: 'done' }, { key: 'b', name: 'Commands', status: 'pending' }], isInstalling: false, isSettingUp: false, tier: 'quick', logLines: ['one', 'two'] })
    const summary = await projects({ action: 'get', project: 'Shop API' })
    expect(summary.envelope.data).toMatchObject({ ref: 'project:shop-api', repositories: [{ ref: expect.stringMatching(/^repository:shop-api\//), primary: true }], default: false })
    expect(summary.envelope.data.settings).toBeUndefined()
    const detail = await projects({ action: 'get', project: 'shop-api', view: 'detail' })
    expect(detail.envelope.data.settings).toEqual({ integrationBranch: 'develop', orchestratorModel: 'sonnet', allowSubagents: false, reviewWipLimit: 2 })
    expect(detail.envelope.data.setup).toMatchObject({ installing: false, done: 1, total: 2, logTail: ['one', 'two'] })
    expect(detail.envelope.state.offers.map((offer: { id: string }) => offer.id)).toEqual(['provision', 'assemble'])
  })

  it('resolves fuzzily: ambiguous with choices, unknown with choices, v1 projectId too', async () => {
    const ambiguous = await projects({ action: 'get', project: 'shop' })
    expect(ambiguous.envelope.error).toMatchObject({ code: 'ambiguous', choices: [{ slug: 'shop-api' }, { slug: 'shop-web' }] })
    expect((await projects({ action: 'get', project: 'zzz' })).envelope.error.code).toBe('not_found')
    expect((await projects({ action: 'get', projectId: 'p3' })).envelope.data.slug).toBe('blog')
    expect((await projects({ action: 'get' })).envelope.error.code).toBe('ambiguous')
  })

  it('select sets the session default and language; clear removes it', async () => {
    const selected = await projects({ action: 'select', project: '/tmp/v2-blog', lang: 'es' })
    expect(selected.envelope.data).toMatchObject({ slug: 'blog', default: true, lang: 'es' })
    expect(h.ctx.sessionState).toMatchObject({ activeProjectId: 'p3', lang: 'es' })
    expect((await projects({ action: 'get' })).envelope.data.slug).toBe('blog')
    await projects({ action: 'select', options: { clear: true } })
    expect(h.ctx.sessionState?.activeProjectId).toBeNull()
  })

  it('lists 100 projects in pages under the summary budget', async () => {
    await client.close(); await desktop.close()
    await boot(manyProjects(100))
    const started = performance.now()
    const first = await projects({ action: 'list' })
    const elapsed = performance.now() - started
    expect(first.envelope.data.items).toHaveLength(25)
    expect(first.envelope.page).toMatchObject({ total: 100, truncated: true })
    expect(approxTokens(first.text)).toBeLessThanOrEqual(1500)
    const next = await projects({ action: 'list', cursor: first.envelope.page.cursor })
    expect(next.envelope.data.items[0].slug).not.toBe(first.envelope.data.items[0].slug)
    expect((await projects({ action: 'get', project: 'proj-57' })).envelope.data.id).toBe('p57')
    console.info(`[wp2 perf] projects(list) 100 projects: ${elapsed.toFixed(0)} ms, ~${approxTokens(first.text)} tokens`)
    expect(elapsed).toBeLessThan(500)
  })
})

describe('add / clone / provision / install', () => {
  it('add registers through POST /projects and can make it the default', async () => {
    desktop.on('POST', '/projects', (req: Req, res: Res) => {
      addProject(h.db, { id: 'p9', slug: 'new-app', name: 'New App', path: String(req.body.path) } as never)
      res.status(201).json({ project: { id: 'p9', slug: 'new-app', name: 'New App', path: req.body.path, providers: ['claude'] }, has_specrails: false })
    })
    const { envelope } = await projects({ action: 'add', path: '/tmp/new-app', name: 'New App', options: { providers: ['claude', 'codex'], select: true } })
    expect(envelope).toMatchObject({ ok: true, data: { project: { ref: 'project:new-app' } }, refs: { project: 'project:new-app' } })
    expect(posts()).toEqual([['POST', '/projects', { path: '/tmp/new-app', name: 'New App', providers: ['claude', 'codex'] }]])
    expect(h.ctx.sessionState?.activeProjectId).toBe('p9')
    expect((await projects({ action: 'add' })).envelope.error.code).toBe('invalid_input')
  })

  it('add relays the route\'s refusal', async () => {
    desktop.on('POST', '/projects', (_req: Req, res: Res) => { res.status(409).json({ error: 'A project with this path is already registered' }) })
    const { envelope } = await projects({ action: 'add', path: '/tmp/v2-blog' })
    expect(envelope.ok).toBe(false)
    expect(envelope.error.message).toMatch(/already registered/)
  })

  it('clone clones then registers; register:false only clones; a destination is required', async () => {
    desktop.on('POST', '/repositories/clone', (req: Req, res: Res) => { res.status(201).json({ path: req.body.destination }) })
    desktop.on('POST', '/projects', (req: Req, res: Res) => { res.status(201).json({ project: { id: 'p8', slug: 'repo', name: 'repo', path: req.body.path } }) })
    const { envelope } = await projects({ action: 'clone', url: 'https://github.com/acme/repo', path: '/tmp/clones/repo' })
    expect(envelope.data).toMatchObject({ path: '/tmp/clones/repo', project: { ref: 'project:repo' } })
    expect(posts()).toEqual([['POST', '/repositories/clone', { url: 'https://github.com/acme/repo', destination: '/tmp/clones/repo' }], ['POST', '/projects', { path: '/tmp/clones/repo' }]])
    const only = await projects({ action: 'clone', url: 'https://github.com/acme/repo', options: { destination: '/tmp/clones/two', register: false } })
    expect(only.envelope.data).toEqual({ path: '/tmp/clones/two' })
    expect((await projects({ action: 'clone', url: 'https://github.com/acme/repo' })).envelope.error.code).toBe('invalid_input')
  })

  it('provision runs the quick setup of every provider without a confirmation (offline, $0)', async () => {
    desktop.on('POST', '/projects/p1/setup/install', (_req: Req, res: Res) => { res.status(202).json({ ok: true }) })
    desktop.on('POST', '/projects/p1/setup/install-config', { ok: true })
    const dry = await projects({ action: 'provision', project: 'shop-api', dryRun: true })
    expect(dry.envelope.data.preview).toMatchObject({ cost: { forecastUsd: [0, 0], runs: 1 }, effect: expect.stringContaining('quick, offline') })
    expect(dry.envelope.data.confirmToken).toBeUndefined()
    const { envelope } = await projects({ action: 'provision', project: 'shop-api', options: { config: { agents: ['dev'], tier: 'full' } } })
    expect(envelope).toMatchObject({ ok: true, data: { installing: true, providers: ['claude'] } })
    expect(posts()).toEqual([
      ['POST', '/projects/p1/setup/install-config', { agents: ['dev'], tier: 'quick', provider: 'claude' }],
      ['POST', '/projects/p1/setup/install', { all: true }],
    ])
  })

  it('provision with assemble retries the background workspace assembly', async () => {
    desktop.on('POST', '/projects/p1/assemble-retry', (_req: Req, res: Res) => { res.status(202).json({ retrying: ['claude'] }) })
    const { envelope } = await projects({ action: 'provision', project: 'shop-api', options: { assemble: true } })
    expect(envelope.data).toMatchObject({ assembling: ['claude'] })
  })

  it('install_status reads the checkpoints with offers; abort_install stops it', async () => {
    desktop.on('GET', '/projects/p1/setup/checkpoints', { checkpoints: [{ key: 'a', name: 'Agents', status: 'running' }], isInstalling: true, logLines: ['x'] })
    desktop.on('POST', '/projects/p1/setup/abort', { ok: true })
    const status = await projects({ action: 'install_status', project: 'shop-api' })
    expect(status.envelope).toMatchObject({ data: { installing: true, done: 0, total: 1 }, state: { status: 'running', offers: [{ id: 'abort_install' }] } })
    expect(status.envelope.data.logTail).toBeUndefined()
    expect((await projects({ action: 'install_status', project: 'shop-api', view: 'detail' })).envelope.data.logTail).toEqual(['x'])
    expect((await projects({ action: 'abort_install', project: 'shop-api' })).envelope.data.aborted).toBe(true)
  })
})

describe('repositories', () => {
  it('lists, adds and updates through the repository routes', async () => {
    const repositories = await projects({ action: 'repositories', project: 'shop-api' })
    expect(repositories.envelope.data.total).toBe(1)
    const id = repositories.envelope.data.items[0].id
    desktop.on('POST', '/projects/p1/repositories', { repository: { id: 'r2', name: 'web' } })
    desktop.on('PATCH', `/projects/p1/repositories/${id}`, { ok: true })
    expect((await projects({ action: 'repository_add', project: 'shop-api', path: '/tmp/web', name: 'web', options: { integrationBranch: 'main' } })).envelope.refs.repository).toBe('repository:shop-api/r2')
    expect((await projects({ action: 'repository_update', project: 'shop-api', repository: `repository:shop-api/${id}`, options: { workspacePaths: ['src'] } })).envelope.ok).toBe(true)
    expect((await projects({ action: 'repository_update', project: 'shop-api', repository: id })).envelope.error.code).toBe('invalid_input')
    expect((await projects({ action: 'repository_update', project: 'shop-api', repository: 'nope', name: 'x' })).envelope.error).toMatchObject({ code: 'not_found', choices: [{ ref: `repository:shop-api/${id}` }] })
    expect(posts()).toEqual([
      ['POST', '/projects/p1/repositories', { path: '/tmp/web', name: 'web', integrationBranch: 'main' }],
      ['PATCH', `/projects/p1/repositories/${id}`, { workspacePaths: ['src'] }],
    ])
  })

  it('repository_remove needs a confirmation bound to the repository', async () => {
    const id = (await projects({ action: 'repositories', project: 'shop-api' })).envelope.data.items[0].id
    desktop.on('DELETE', `/projects/p1/repositories/${id}`, { ok: true })
    const first = await projects({ action: 'repository_remove', project: 'shop-api', repository: id })
    expect(first.envelope.error).toMatchObject({ code: 'confirmation_required', preview: { class: 'irreversible', effect: expect.stringContaining('files stay on disk') } })
    expect(posts()).toEqual([])
    const done = await projects({ action: 'repository_remove', project: 'shop-api', repository: id, confirm: first.envelope.error.confirmToken })
    expect(done.envelope.ok).toBe(true)
    expect(posts().map(([method, path]) => [method, path])).toEqual([['DELETE', `/projects/p1/repositories/${id}`]])
  })
})

describe('unregister', () => {
  it('previews, confirms, unregisters through DELETE and clears the session default', async () => {
    desktop.on('DELETE', '/projects/p3', { ok: true })
    await projects({ action: 'select', project: 'blog' })
    const first = await projects({ action: 'unregister', project: 'blog' })
    expect(first.envelope.error).toMatchObject({ code: 'confirmation_required', preview: { refs: ['project:blog'], reversible: false } })
    const done = await projects({ action: 'unregister', project: 'blog', confirm: first.envelope.error.confirmToken })
    expect(done.envelope.summary).toBe('Blog was unregistered; its files stay on disk.')
    expect(h.ctx.sessionState?.activeProjectId).toBeNull()
    // Single use.
    expect((await projects({ action: 'unregister', project: 'blog', confirm: first.envelope.error.confirmToken })).envelope.error.code).toBe('stale')
  })

  it('a token for one project does not unregister another, and project is required', async () => {
    const first = await projects({ action: 'unregister', project: 'blog' })
    const other = await projects({ action: 'unregister', project: 'shop-api', confirm: first.envelope.error.confirmToken })
    expect(other.envelope.error).toMatchObject({ code: 'confirmation_required', reason: 'mismatch' })
    expect((await projects({ action: 'unregister' })).envelope.error.code).toBe('invalid_input')
    expect(listProjects(h.db)).toHaveLength(3)
  })
})

describe('sample project and prerequisites', () => {
  it('creates the sample in the call language; removes it behind a confirmation', async () => {
    desktop.on('POST', '/onboarding/sample', (req: Req, res: Res) => {
      addProject(h.db, { id: 'p7', slug: 'tic-tac-toe', name: 'Tic-tac-toe', path: '/tmp/ttt' } as never)
      res.status(201).json({ reused: false, project: { id: 'p7', name: 'Tic-tac-toe', path: '/tmp/ttt' }, sample: { sampleId: 'ttt', projectId: 'p7', path: '/tmp/ttt', specIds: [1, 2, 3] }, echo: req.body })
    })
    const created = await projects({ action: 'sample_create', lang: 'es', options: { parentDir: '/tmp' } })
    expect(created.envelope.data).toMatchObject({ project: 'project:tic-tac-toe', specs: ['spec:tic-tac-toe/1', 'spec:tic-tac-toe/2', 'spec:tic-tac-toe/3'] })
    expect(posts()[0]).toEqual(['POST', '/onboarding/sample', { locale: 'es', parentDir: '/tmp' }])
    desktop.on('GET', '/onboarding/sample', { sample: { sampleId: 'ttt', projectId: 'p7', path: '/tmp/ttt', specIds: [1] } })
    desktop.on('DELETE', '/onboarding/sample?deleteFolder=1', { ok: true, removed: true })
    const first = await projects({ action: 'sample_remove', lang: 'en', options: { deleteFolder: true } })
    expect(first.envelope.error.preview.effect).toContain('deletes its folder /tmp/ttt')
    const removed = await projects({ action: 'sample_remove', lang: 'en', options: { deleteFolder: true }, confirm: first.envelope.error.confirmToken })
    expect(removed.envelope.summary).toBe('The sample project was removed and its folder deleted.')
  })

  it('sample_remove says when there is none', async () => {
    desktop.on('GET', '/onboarding/sample', { sample: null })
    expect((await projects({ action: 'sample_remove' })).envelope.error.code).toBe('not_found')
  })

  it('prerequisites are compact and name what is missing', async () => {
    desktop.on('GET', '/setup-prerequisites', { ok: false, platform: 'darwin', prerequisites: [
      { key: 'node', kind: 'tool', label: 'Node.js', command: 'node', required: true, installed: true, executable: true, version: '22.1.0', minVersion: '20.19.0', meetsMinimum: true, installUrl: 'x', installHint: 'y', resolvedPath: '/usr/bin/node' },
      { key: 'git', kind: 'tool', label: 'Git', command: 'git', required: true, installed: false, executable: false, meetsMinimum: false, installUrl: 'x', installHint: 'y' },
      { key: 'claude', kind: 'provider', label: 'Claude', command: 'claude', required: false, installed: true, executable: true, meetsMinimum: true, installUrl: 'x', installHint: 'y' },
    ], missingRequired: [] })
    const { envelope } = await projects({ action: 'prerequisites' })
    expect(envelope.summary).toBe('Missing required tools: Git.')
    expect(envelope.data.items[0]).toEqual({ key: 'node', kind: 'tool', label: 'Node.js', required: true, installed: true, version: '22.1.0', minVersion: '20.19.0' })
  })
})
