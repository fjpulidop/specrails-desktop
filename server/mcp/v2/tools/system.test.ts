import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../auth', () => ({ loadOrGenerateToken: () => 'system-v2-test-token' }))

const terminal = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  written: [] as Array<[string, string]>,
}))
vi.mock('../../../modules/terminals/runtime/terminal-manager', () => ({
  getTerminalManager: () => ({
    get: (projectId: string, id: string) => { const s = terminal.sessions.get(id); return s && s.projectId === projectId ? s : undefined },
    write: (id: string, data: string) => { terminal.written.push([id, data]) },
  }),
}))

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import express from 'express'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { call, createHarness, registerTools, type Harness } from '../__fixtures__/harness'
import { settingsTool } from './settings'
import { approxTokens } from '../core/size-guard'
import { v2Catalog } from '../index'
import { systemTool, terminalText } from './system'

type Reply = { status?: number; body: unknown } | ((req: express.Request) => { status?: number; body: unknown })
const routes = new Map<string, Reply>()
const seen: Array<{ method: string; path: string; query: Record<string, unknown>; body: unknown }> = []
let server: Server
let port = 0
let h: Harness
let client: Client
let tmp: string

const route = (key: string, reply: Reply) => routes.set(key, reply)
const calls = (prefix: string) => seen.filter((entry) => `${entry.method} ${entry.path}`.startsWith(prefix))

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'system-v2-'))
  const app = express()
  app.use(express.json())
  app.use((req, res) => {
    seen.push({ method: req.method, path: req.path, query: req.query as Record<string, unknown>, body: req.body })
    const reply = routes.get(`${req.method} ${req.path}`)
    if (!reply) { res.status(404).json({ error: 'not stubbed', path: req.path }); return }
    const value = typeof reply === 'function' ? reply(req) : reply
    res.status(value.status ?? 200).json(value.body)
  })
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(async () => {
  routes.clear()
  seen.length = 0
  terminal.sessions.clear()
  terminal.written.length = 0
  h = createHarness()
  h.ctx.desktopPort = port
  h.ctx.sessionState = { activeProjectId: 'p1', sessionKey: 'session-a' } as never
  // machine_installs is specrails_settings' section: system dispatches to it.
  registerTools(h, [systemTool, settingsTool], { catalog: v2Catalog() })
  client = await h.connect()
})

const sys = (args: Record<string, unknown>) => call(client, 'specrails_system', args)
const P = '/api/projects/p1'

function healthyRoutes() {
  route('GET /api/meta', { body: { appVersion: '3.5.0', coreVersion: '6.10.0', apiVersion: 4, channel: 'latest' } })
  route('GET /api/diagnostics/crashes', { body: { available: true, acknowledgedThroughMs: 0, notices: [] } })
  route('GET /api/diagnostics/stalls', { body: { thresholdMs: 200, sampling: false, sinceMs: 1, total: 0, longestMs: 0, recent: [] } })
  route('GET /api/core-update/status', { body: { currentVersion: '6.10.0', latestVersion: '6.10.0', updateAvailable: false, updating: false, lastCheckedAt: 1 } })
  route('GET /api/desktop-updates/status', { body: { currentVersion: '3.5.0', latest: null, available: false, checkedAt: null, window: { connected: true } } })
  route('GET /api/continuity/resume-offers', { body: { offers: [], runs: [], bootedAt: 'b' } })
  route('GET /api/continuity/active-work', { body: { missions: 0, runs: 1, total: 1 } })
}

describe('health', () => {
  it('is one short line when everything is fine', async () => {
    healthyRoutes()
    const { envelope } = await sys({ action: 'health' })
    expect(envelope.summary).toBe('Specrails 3.5.0 is healthy.')
    expect(envelope.data.healthy).toBe(true)
    expect(envelope.data.versions).toEqual({ app: '3.5.0', core: '6.10.0', api: 4, channel: 'latest' })
  })

  it('names what needs attention and where to look', async () => {
    healthyRoutes()
    route('GET /api/diagnostics/crashes', { body: { available: true, notices: [{ id: 'c', atMs: 5 }] } })
    route('GET /api/core-update/status', { body: { currentVersion: '6.10.0', latestVersion: '6.11.0', updateAvailable: true } })
    route('GET /api/continuity/resume-offers', { body: { offers: [{ conversationId: 'm1' }], runs: [] } })
    routes.delete('GET /api/diagnostics/stalls')
    const { envelope } = await sys({ action: 'health' })
    expect(envelope.data.healthy).toBe(false)
    expect(envelope.summary).toContain('1 unexplained server restarts')
    expect(envelope.summary).toContain('Core 6.11.0 is available')
    expect(envelope.summary).toContain('stalls could not be read')
    expect(envelope.data.next.map((n: any) => n.args.action)).toEqual(['crashes', 'continuity', 'updates'])
  })
})

describe('help', () => {
  it('lists the catalog and guide topics within the summary budget', async () => {
    const { envelope } = await sys({ action: 'help' })
    expect(envelope.data.tools).toHaveLength(15)
    expect(envelope.data.topics.length).toBeGreaterThan(5)
    expect(approxTokens(JSON.stringify(envelope))).toBeLessThan(1500)
  })

  it('describes an action and validates arguments', async () => {
    const described = await sys({ action: 'help', options: { describe: 'specrails_integrations.jira_disconnect' } })
    expect(described.envelope.data).toMatchObject({ tool: 'specrails_integrations', action: 'jira_disconnect', tier: 'destructive', confirm: 'irreversible', implemented: true })
    const ops = await sys({ action: 'help', options: { describe: 'specrails_system.updates', args: { op: 'apply' } } })
    expect(ops.envelope.data).toMatchObject({ tier: 'destructive', ops: ['status', 'check', 'apply'] })
    const bad = await sys({ action: 'help', options: { validate: { tool: 'specrails_integrations', action: 'code_read', args: { file: 'x' } } } })
    expect(bad.envelope.data.valid).toBe(false)
    expect(bad.envelope.data.problems.join(' ')).toContain('missing path')
    expect(bad.envelope.data.problems.join(' ')).toContain('unknown fields file')
    const unknown = await sys({ action: 'help', options: { describe: 'specrails_nope.x' } })
    expect(unknown.envelope.error.code).toBe('invalid_input')
  })

  it('pages a long guide topic and searches', async () => {
    const first = await sys({ action: 'help', topic: 'platform-model' })
    expect(first.envelope.data.text.length).toBeGreaterThan(100)
    if (first.envelope.page?.cursor) {
      const next = await sys({ action: 'help', topic: 'platform-model', cursor: first.envelope.page.cursor })
      expect(next.envelope.data.text).not.toBe(first.envelope.data.text)
    }
    const search = await sys({ action: 'help', query: 'jira' })
    expect(search.envelope.data.items.some((hit: any) => hit.describe?.startsWith('specrails_integrations.jira_'))).toBe(true)
  })
})

describe('diagnostics', () => {
  it('saves the problem report ZIP locally and returns its path', async () => {
    route('POST /api/diagnostics/report', { body: { id: 'r1', fileName: 'specrails-report.zip', files: [{ name: 'versions.json', content: '{"a":1}', bytes: 7 }] } })
    const { envelope } = await sys({ action: 'report', options: { dir: tmp } })
    expect(envelope.data.path).toBe(path.join(tmp, 'specrails-report.zip'))
    expect(fs.readFileSync(envelope.data.path).subarray(0, 2).toString()).toBe('PK')
    expect(JSON.stringify(envelope.data)).not.toContain('"a":1')
    expect(envelope.summary).toContain('Nothing was uploaded')
  })

  it('acknowledges crashes through the newest notice by default', async () => {
    route('GET /api/diagnostics/crashes', { body: { notices: [{ id: 'a', atMs: 10 }, { id: 'b', atMs: 30 }] } })
    route('POST /api/diagnostics/crashes/ack', { body: { acknowledgedThroughMs: 30 } })
    expect((await sys({ action: 'crashes' })).envelope.data.items).toHaveLength(2)
    await sys({ action: 'crashes_ack' })
    expect(calls('POST /api/diagnostics/crashes/ack')[0].body).toEqual({ throughMs: 30 })
  })
})

describe('updates', () => {
  it('reports both channels and checks both', async () => {
    healthyRoutes()
    route('POST /api/core-update/check', { body: {} })
    route('POST /api/desktop-updates/check', { body: {} })
    const status = await sys({ action: 'updates' })
    expect(status.envelope.summary).toBe('Desktop 3.5.0 (not checked); Core 6.10.0 (up to date).')
    await sys({ action: 'updates', op: 'check' })
    expect(calls('POST /api/core-update/check')).toHaveLength(1)
    expect(calls('POST /api/desktop-updates/check')).toHaveLength(1)
  })

  it('needs a target and a known update to apply', async () => {
    healthyRoutes()
    expect((await sys({ action: 'updates', op: 'apply' })).envelope.error.code).toBe('invalid_input')
    expect((await sys({ action: 'updates', op: 'apply', options: { target: 'desktop' } })).envelope.error.code).toBe('invalid_input')
    expect((await sys({ action: 'updates', op: 'nope' })).envelope.error.code).toBe('invalid_input')
  })

  it('relays a confirmed desktop install and goes stale when the release changes', async () => {
    healthyRoutes()
    let version = '3.6.0'
    route('GET /api/desktop-updates/status', () => ({ body: { currentVersion: '3.5.0', latest: { version }, available: true, checkedAt: 'x', window: { connected: true } } }))
    route('POST /api/desktop-updates/apply', (req) => ({ status: 202, body: { accepted: true, version: req.body.version, restart: req.body.restart, requestId: 'q' } }))
    const args = { action: 'updates', op: 'apply', options: { target: 'desktop', restart: 'never' } }
    const first = await sys(args)
    expect(first.envelope.error.code).toBe('confirmation_required')
    expect(first.envelope.error.preview.effect).toContain('3.6.0')
    version = '3.6.1'
    const stale = await sys({ ...args, confirm: first.envelope.error.confirmToken })
    expect(stale.envelope.error.code).toBe('stale')
    const done = await sys({ ...args, confirm: stale.envelope.error.confirmToken })
    expect(done.envelope.ok).toBe(true)
    expect(calls('POST /api/desktop-updates/apply')[0].body).toEqual({ version: '3.6.1', restart: 'never' })
  })

  it('starts a confirmed Core update', async () => {
    healthyRoutes()
    route('GET /api/core-update/status', { body: { currentVersion: '6.10.0', latestVersion: '6.11.0', updateAvailable: true } })
    route('POST /api/core-update/update', { status: 202, body: { accepted: true } })
    const args = { action: 'updates', op: 'apply', options: { target: 'core' } }
    const first = await sys(args)
    const done = await sys({ ...args, confirm: first.envelope.error.confirmToken })
    expect(done.envelope.summary).toContain('6.11.0')
    expect(calls('POST /api/core-update/update')).toHaveLength(1)
  })
})

describe('continuity', () => {
  it('lists interrupted work with refs and next calls', async () => {
    route('GET /api/continuity/resume-offers', { body: { offers: [{ conversationId: 'm1', title: 'Fix login', trigger: 'update', startedAt: '2026-11-20T10:00:00Z' }], runs: [{ projectId: 'p1', runId: 'r9' }], bootedAt: 'b' } })
    route('GET /api/continuity/active-work', { body: { missions: 0, runs: 0, total: 0 } })
    const { envelope } = await sys({ action: 'continuity' })
    expect(envelope.data.offers[0].mission).toBe('mission:m1')
    expect(envelope.data.pausedRuns).toEqual(['run:shop-api/r9'])
    expect(envelope.data.next.map((n: any) => n.tool)).toEqual(['specrails_system', 'specrails_runs'])
  })

  it('resumes after confirmation with the app\'s idempotent queue id', async () => {
    route('GET /api/continuity/resume-offers', { body: { offers: [{ conversationId: 'm1', trigger: 'crash', startedAt: '2026-11-20T10:00:00Z' }], runs: [] } })
    route('POST /api/agent/conversations/m1/send', { body: { accepted: true } })
    route('POST /api/continuity/resume-offers/settle', { body: { settled: 1 } })
    const first = await sys({ action: 'continuity', op: 'resume' })
    expect(first.envelope.error.code).toBe('confirmation_required')
    const done = await sys({ action: 'continuity', op: 'resume', confirm: first.envelope.error.confirmToken })
    expect(done.envelope.data.resumed).toEqual(['mission:m1'])
    const sent = calls('POST /api/agent/conversations/m1/send')[0].body as Record<string, string>
    expect(sent.queueId).toBe(`resume-m1-${Date.parse('2026-11-20T10:00:00Z')}`)
    expect(sent.text).toContain('stopped unexpectedly')
    expect(calls('POST /api/continuity/resume-offers/settle')[0].body).toEqual({ conversationIds: ['m1'] })
  })
})

describe('worktrees', () => {
  const ITEM = { id: 'w1', projectId: 'p1', kind: 'run', branch: 'feat/x', worktreePath: '/w/1', head: 'a'.repeat(40), trackedChanges: 0, untrackedFiles: 0, unpushedCommits: 0, runId: 'r1', ticketId: 4 }

  it('lists with refs and removes after a head-bound confirmation', async () => {
    let head = 'a'.repeat(40)
    route('GET /api/worktrees/retained', () => ({ body: { items: [{ ...ITEM, head }] } }))
    route('GET /api/worktrees/quarantines', { body: { items: [] } })
    route('POST /api/worktrees/retained/remove', { body: { results: [{ projectId: 'p1', id: 'w1', status: 'removed' }] } })
    const list = await sys({ action: 'worktrees' })
    expect(list.envelope.data.items[0]).toMatchObject({ project: 'project:shop-api', run: 'run:shop-api/r1', spec: 'spec:shop-api/4' })
    const first = await sys({ action: 'worktrees', op: 'remove', id: 'w1' })
    expect(first.envelope.error.preview.effect).toContain('feat/x')
    head = 'b'.repeat(40)
    expect((await sys({ action: 'worktrees', op: 'remove', id: 'w1', confirm: first.envelope.error.confirmToken })).envelope.error.code).toBe('stale')
    const retry = await sys({ action: 'worktrees', op: 'remove', id: 'w1' })
    const done = await sys({ action: 'worktrees', op: 'remove', id: 'w1', confirm: retry.envelope.error.confirmToken })
    expect(done.envelope.summary).toBe('Removed 1 of 1 worktrees.')
    expect(calls('POST /api/worktrees/retained/remove')[0].body).toEqual({ items: [{ projectId: 'p1', id: 'w1', deleteBranch: false, head: 'b'.repeat(40) }] })
  })
})

describe('background processes', () => {
  it('lists, reads logs and stops only after confirmation, with the owner threaded', async () => {
    route(`GET ${P}/background-processes`, { body: { processes: [{ pid: 42, processId: 'e1', chatId: 'm1', status: 'running', command: 'npm run dev' }] } })
    route(`GET ${P}/background-processes/42/logs`, { body: { lines: ['ready on :3000'], process: { status: 'running' } } })
    route(`DELETE ${P}/background-processes/42`, { status: 202, body: { status: 'stopping', process: {} } })
    expect((await sys({ action: 'background' })).envelope.data.items[0]).toMatchObject({ pid: 42, mission: 'mission:m1' })
    const logs = await sys({ action: 'background', op: 'logs', id: '42' })
    expect(logs.envelope.untrusted).toContain('/data/lines')
    expect(calls(`GET ${P}/background-processes/42/logs`)[0].query).toMatchObject({ chatId: 'm1', processId: 'e1' })
    const first = await sys({ action: 'background', op: 'kill', id: '42' })
    expect(first.envelope.error.preview.effect).toContain('npm run dev')
    await sys({ action: 'background', op: 'kill', id: '42', confirm: first.envelope.error.confirmToken })
    expect(calls(`DELETE ${P}/background-processes/42`)).toHaveLength(1)
  })
})

describe('terminals', () => {
  const session = (id: string) => ({ id, projectId: 'p1', name: 'zsh', cwd: '/tmp/v2-shop-api', currentCwd: null, exited: false, buffer: { snapshot: () => Buffer.from('\x1b[32mok\x1b[0m\r\nline 2\r\n') } })

  it('strips terminal escapes', () => {
    expect(terminalText(Buffer.from('\x1b]0;title\x07\x1b[1;31mred\x1b[0m\rover\r\n'))).toBe('redover\n')
  })

  it('lists and reads the latest output as untrusted text', async () => {
    terminal.sessions.set('t1', session('t1'))
    route(`GET ${P}/terminals`, { body: { sessions: [{ id: 't1', name: 'zsh' }], limit: 10 } })
    route(`GET ${P}/terminals/t1/marks`, { body: { marks: [{ command: 'ls', exitCode: 0 }] } })
    expect((await sys({ action: 'terminals' })).envelope.data.items).toHaveLength(1)
    const read = await sys({ action: 'terminals', op: 'read', id: 't1' })
    expect(read.envelope.data.text).toBe('ok\nline 2\n')
    expect(read.envelope.untrusted).toContain('/data/text')
    expect((await sys({ action: 'terminals', op: 'read', id: 'missing' })).envelope.error.code).toBe('not_found')
  })

  it('runs a command only after an irreversible confirmation', async () => {
    terminal.sessions.set('t1', session('t1'))
    const args = { action: 'terminals', op: 'run', id: 't1', options: { command: 'npm test' } }
    const first = await sys(args)
    expect(first.envelope.error.code).toBe('confirmation_required')
    expect(first.envelope.error.preview.effect).toContain('npm test')
    expect(terminal.written).toHaveLength(0)
    await sys({ ...args, confirm: first.envelope.error.confirmToken })
    expect(terminal.written).toEqual([['t1', 'npm test\r']])
    expect((await sys({ ...args, options: { command: 'a\nb' } })).envelope.error.code).toBe('invalid_input')
  })

  it('opens a terminal when none is named', async () => {
    route(`POST ${P}/terminals`, () => { terminal.sessions.set('t2', session('t2')); return { status: 201, body: { session: { id: 't2' } } } })
    const args = { action: 'terminals', op: 'run', options: { command: 'git status' } }
    const first = await sys(args)
    expect(first.envelope.error.preview.effect).toContain('new terminal')
    await sys({ ...args, confirm: first.envelope.error.confirmToken })
    expect(terminal.written).toEqual([['t2', 'git status\r']])
  })
})

describe('browser and docs', () => {
  it('captures the viewport of the only session', async () => {
    route(`GET ${P}/browser/sessions`, { body: { sessions: [{ id: 'b1', url: 'http://localhost:3000', title: 'App', viewportWidth: 1024, viewportHeight: 700 }] } })
    route(`POST ${P}/browser/sessions/b1/capture`, { body: { screenshot: { id: 'a1', filename: 'shot.png' }, domAttachment: { id: 'a2', filename: 'dom.html' }, screenshotDataUrl: 'data:image/png;base64,AAAA' } })
    const { envelope } = await sys({ action: 'browser', op: 'capture' })
    expect(calls(`POST ${P}/browser/sessions/b1/capture`)[0].body).toMatchObject({ rect: { x: 0, y: 0, width: 1024, height: 700 } })
    expect(envelope.data.screenshot).toMatchObject({ id: 'a1', name: 'shot.png' })
    expect(JSON.stringify(envelope)).not.toContain('base64')
  })

  it('searches and reads docs in the reply language, paged', async () => {
    route('GET /api/docs/search', { body: { results: [{ category: 'getting-started', slug: 'install', title: 'Install' }] } })
    route('GET /api/docs/getting-started/install', { body: { title: 'Install', content: 'x'.repeat(30_000) } })
    const search = await sys({ action: 'docs', query: 'install', lang: 'es' })
    expect(search.envelope.data.items[0].topic).toBe('getting-started/install')
    expect(calls('GET /api/docs/search')[0].query).toMatchObject({ q: 'install', lang: 'es' })
    const page = await sys({ action: 'docs', topic: 'getting-started/install' })
    expect(page.envelope.page.truncated).toBe(true)
    expect(approxTokens(JSON.stringify(page.envelope))).toBeLessThan(6000)
    const next = await sys({ action: 'docs', topic: 'getting-started/install', cursor: page.envelope.page.cursor })
    expect(next.envelope.data.text.length).toBeGreaterThan(0)
  })
})

describe('machine installs and triage', () => {
  it('revokes a remembered install', async () => {
    route('GET /api/machine-installs', { body: { approvals: [{ command: 'brew install uv' }] } })
    route('DELETE /api/machine-installs', { body: { ok: true, approvals: [] } })
    // specrails_settings(machine_installs) serves it.
    expect((await sys({ action: 'machine_installs' })).envelope.data.values.approvals).toEqual([{ command: 'brew install uv' }])
    await sys({ action: 'machine_installs', op: 'revoke', options: { command: 'brew install uv' } })
    expect(calls('DELETE /api/machine-installs')[0].body).toEqual({ command: 'brew install uv' })
  })

  it('triages through the support playbook without the project list in summary', async () => {
    route('GET /api/core-update/status', { body: { currentVersion: '6.10.0' } })
    const { envelope } = await sys({ action: 'triage', query: 'codex login fails' })
    expect(envelope.data.topic).toBe('provider_cli')
    expect(envelope.data.diagnostics.projects).toBeUndefined()
    expect(approxTokens(JSON.stringify(envelope))).toBeLessThan(1500)
  })
})
