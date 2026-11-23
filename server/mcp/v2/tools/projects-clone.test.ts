import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../auth', () => ({ loadOrGenerateToken: () => 'v2-projects-clone-test-token' }))
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createHarness, call, type Harness } from '../__fixtures__/harness'
import { registerV2Surface } from '../index'
import { buildToolSpecs } from '../../tools/catalog'
import { addProject } from '../../../desktop-db'
import { eventJournalFor, stopEventJournal } from '../../../modules/events-journal'
import { _forgetRunningClonesForTest } from '../core/clone-jobs'
import { startDesktop, type FakeDesktop } from './__fixtures__/wp2-desktop'
import type { WsMessage } from '../../../types'

// specrails_projects(clone) beyond a client's call timeout: inline when Git is
// quick, otherwise 202 with clone:<id>, journal-backed progress, a settling
// specrails_wait, and an honest failure after a restart.

type Res = { status(code: number): { json(body: unknown): void }; json(body: unknown): void }
type Req = { body: Record<string, unknown> }

let h: Harness
let desktop: FakeDesktop
let client: Client
let release: (() => void) | null = null

beforeEach(async () => {
  h = createHarness({ projects: [{ id: 'p1', slug: 'shop-api', name: 'Shop API', path: '/tmp/v2-shop-api' }] })
  desktop = await startDesktop(h)
  registerV2Surface(h.server, h.ctx, buildToolSpecs(), { inApp: false })
  client = await h.connect()
  desktop.on('POST', '/projects', (req: Req, res: Res) => {
    addProject(h.db, { id: 'p8', slug: 'repo', name: 'repo', path: String(req.body.path) } as never)
    res.status(201).json({ project: { id: 'p8', slug: 'repo', name: 'repo', path: req.body.path } })
  })
})
afterEach(async () => {
  release?.()
  release = null
  await client.close()
  await desktop.close()
  stopEventJournal(h.db)
  _forgetRunningClonesForTest()
})

const projects = (args: Record<string, unknown>) => call(client, 'specrails_projects', args)
const wait = (args: Record<string, unknown>) => call(client, 'specrails_wait', args)
/** A clone route that answers only when the test releases it; its progress frames go through the app bus. */
function slowClone(outcome: { status: number; body: (req: Req) => unknown }) {
  let seen: Req | null = null
  desktop.on('POST', '/repositories/clone', (req: Req, res: Res) => {
    seen = req
    release = () => { release = null; res.status(outcome.status).json(outcome.body(req)) }
  })
  return { cloneId: () => String(seen?.body.cloneId ?? '') }
}
const publish = (msg: Record<string, unknown>) => h.ctx.eventBus.publish(msg as unknown as WsMessage)
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

describe('projects(clone) in the background', () => {
  it('answers done inline when Git is quick (same data as before, plus the clone ref)', async () => {
    desktop.on('POST', '/repositories/clone', (req: Req, res: Res) => { res.status(201).json({ path: req.body.destination }) })
    const { envelope } = await projects({ action: 'clone', url: 'https://github.com/acme/repo', path: '/tmp/clones/repo' })
    expect(envelope.data).toMatchObject({ path: '/tmp/clones/repo', project: { ref: 'project:repo', slug: 'repo' } })
    expect(envelope.refs.clone).toMatch(/^clone:[0-9a-f-]{36}$/)
    const clonePost = desktop.calls.find((c) => c.path === '/repositories/clone')!
    expect(clonePost.body).toMatchObject({ url: 'https://github.com/acme/repo', destination: '/tmp/clones/repo', cloneId: envelope.refs.clone.slice('clone:'.length) })
    // The journal holds the clone: get answers from it after the call.
    const got = await projects({ action: 'get', ref: envelope.refs.clone })
    expect(got.envelope.data).toMatchObject({ status: 'succeeded', path: '/tmp/clones/repo', project: 'project:repo' })
  })

  it('a refusal inside the wait is the route\'s own error, as before', async () => {
    desktop.on('POST', '/repositories/clone', (_req: Req, res: Res) => { res.status(409).json({ error: 'The destination already exists. Choose a new folder.', code: 'clone_destination_exists' }) })
    const { envelope } = await projects({ action: 'clone', url: 'https://github.com/acme/repo', path: '/tmp/clones/repo' })
    expect(envelope.ok).toBe(false)
    expect(envelope.error.message).toMatch(/already exists/)
  })

  it('answers 202 with clone:<id> past waitMs; progress lands in the journal; wait settles with the new project', async () => {
    const route = slowClone({ status: 201, body: (req) => ({ path: req.body.destination }) })
    const accepted = await projects({ action: 'clone', url: 'https://github.com/acme/repo', path: '/tmp/clones/big', options: { waitMs: 50 } })
    expect(accepted.envelope.data).toMatchObject({ status: 'running', accepted: true, path: '/tmp/clones/big' })
    const ref = accepted.envelope.data.ref as string
    expect(ref).toBe(`clone:${route.cloneId()}`)
    expect(accepted.envelope.summary).toContain(`specrails_wait(until, refs:["${ref}"])`)
    expect((await projects({ action: 'list' })).envelope.data.cloning).toEqual([{ ref, path: '/tmp/clones/big' }])

    // Git progress (the clone route's frames) → journal rows → get shows it.
    publish({ type: 'repository.clone_progress', cloneId: route.cloneId(), phase: 'receiving', percent: 40 })
    await settle()
    const running = await projects({ action: 'get', ref })
    expect(running.envelope.data).toMatchObject({ status: 'running', phase: 'receiving', percent: 40 })
    expect(running.envelope.summary).toContain('receiving 40%')
    const changed = await wait({ action: 'events', refs: [ref] })
    expect(changed.envelope.data.items.map((item: { status: string }) => item.status)).toEqual(['running', 'running'])

    // A blocked wait wakes when the clone finishes and registers the project.
    const pending = wait({ action: 'until', refs: [ref], timeoutMs: 5000 })
    await settle()
    release!()
    const woke = await pending
    expect(woke.envelope.data.timedOut).toBe(false)
    expect(woke.envelope.data.fired[0]).toMatchObject({ ref, status: 'succeeded', data: { path: '/tmp/clones/big', projectId: 'p8', slug: 'repo' }, next: { tool: 'specrails_projects', args: { action: 'get', ref } } })
    expect((await projects({ action: 'get', ref })).envelope.data).toMatchObject({ status: 'succeeded', project: 'project:repo' })
    expect((await projects({ action: 'list' })).envelope.data.cloning).toBeUndefined()
    // An already-settled clone answers wait at once.
    expect((await wait({ action: 'until', refs: [ref], timeoutMs: 5000 })).envelope.data.fired[0]).toMatchObject({ ref, status: 'succeeded' })
  })

  it('a client that disconnects does not stop the clone', async () => {
    slowClone({ status: 201, body: (req) => ({ path: req.body.destination }) })
    const ref = (await projects({ action: 'clone', url: 'https://github.com/acme/repo', path: '/tmp/clones/kept', options: { waitMs: 20 } })).envelope.data.ref as string
    await client.close()
    release!()
    await settle(); await settle()
    const row = eventJournalFor(h.db, h.ctx.eventBus).latest([{ kind: 'clone', id: ref.slice('clone:'.length) }]).values().next().value
    expect(row).toMatchObject({ status: 'completed', settled: true })
  })

  it('a failed background clone settles as failed with the route\'s reason', async () => {
    slowClone({ status: 502, body: () => ({ error: 'Clone failed or timed out. Check the repository, network and Git credentials on this computer, then retry.', code: 'clone_failed' }) })
    const ref = (await projects({ action: 'clone', url: 'https://github.com/acme/repo', path: '/tmp/clones/bad', options: { waitMs: 20 } })).envelope.data.ref as string
    const pending = wait({ action: 'until', refs: [ref], timeoutMs: 5000 })
    await settle()
    release!()
    const woke = await pending
    expect(woke.envelope.data.fired[0]).toMatchObject({ ref, status: 'failed', needs: 'failed', detail: expect.stringMatching(/Clone failed or timed out/) })
    const got = await projects({ action: 'get', ref })
    expect(got.envelope.data).toMatchObject({ status: 'failed', code: 'clone_failed', reason: expect.stringMatching(/Git credentials/) })
    expect(got.envelope.summary).toMatch(/failed/)
  })

  it('after a restart, a clone left running is reported interrupted (get and wait), never running forever', async () => {
    slowClone({ status: 201, body: (req) => ({ path: req.body.destination }) })
    const ref = (await projects({ action: 'clone', url: 'https://github.com/acme/repo', path: '/tmp/clones/cut', options: { waitMs: 20 } })).envelope.data.ref as string
    // The process that ran it is gone: the running set is empty, the journal row still says running.
    _forgetRunningClonesForTest()
    const woke = await wait({ action: 'until', refs: [ref], timeoutMs: 5000 })
    expect(woke.envelope.data.timedOut).toBe(false)
    expect(woke.envelope.data.fired[0]).toMatchObject({ ref, status: 'failed', detail: expect.stringMatching(/Interrupted: Specrails restarted.*\/tmp\/clones\/cut may hold a partial clone/) })
    expect((await projects({ action: 'get', ref })).envelope.data).toMatchObject({ status: 'failed', code: 'interrupted' })
    // A clone this computer never started is not found.
    expect((await projects({ action: 'get', ref: 'clone:00000000-0000-0000-0000-000000000000' })).envelope.error.code).toBe('not_found')
  })
})
