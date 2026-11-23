import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../auth', () => ({ loadOrGenerateToken: () => 'v2-rails-test-token-no-filesystem-access' }))
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createHarness, call } from '../__fixtures__/harness'
import { registerV2Tool } from '../core/registry'
import { ConfirmationLedger } from '../core/confirm'
import { approxTokens } from '../core/size-guard'
import { v2Catalog } from '../index'
import { railsTool } from './rails'

// specrails_rails through the shared harness: the rails list, settings writes
// over the existing /rails routes, the confirmed removal and the forecast.

type Reply = { status?: number; body: unknown }
let routes: Map<string, Reply>
let calls: Array<{ method: string; path: string; body: unknown }>
let client: Client
const P = '/projects/p1'

const SNAPSHOT = {
  rails: [
    { railIndex: 0, ticketIds: [12], mode: 'implement', aiEngine: 'codex', profileName: null, name: 'Auth', availability: 'busy' },
    { railIndex: 1, ticketIds: [], mode: 'implement', availability: 'free' },
    { railIndex: 2, ticketIds: [7], mode: 'implement', availability: 'pending_decision' },
  ],
  activeJobs: {}, activeLoopRuns: { 0: { loopRunId: 'r1', provider: 'codex', hold: { kind: 'question', since: 'x' } } },
  prDeliveries: { 2: { id: 'd7', decision: 'on_review' } }, reviewWip: { limit: 3, pending: [{}], reached: false },
}

beforeAll(async () => {
  const harness = createHarness()
  harness.ctx.sessionState = { activeProjectId: 'p1', sessionKey: 'session-r' } as never
  registerV2Tool(harness.server, harness.ctx, railsTool, { catalog: v2Catalog(), ledger: new ConfirmationLedger() })
  client = await harness.connect()
})
beforeEach(() => {
  calls = []
  routes = new Map([[`GET ${P}/rails`, { body: SNAPSHOT }]])
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const full = String(url).replace(/^http:\/\/127\.0\.0\.1:\d+\/api/, '')
    const method = init?.method ?? 'GET'
    calls.push({ method, path: full, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const reply = routes.get(`${method} ${full.split('?')[0]}`) ?? { status: 404, body: { error: 'not_found' } }
    return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, text: async () => JSON.stringify(reply.body) }
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

const rails = (args: Record<string, unknown>) => call(client, 'specrails_rails', args)
const writes = () => calls.filter((entry) => entry.method !== 'GET')

describe('specrails_rails', () => {
  it('lists rails with availability, specs, the active run and the pending delivery as refs', async () => {
    const { envelope, text } = await rails({ action: 'list' })
    expect(envelope.summary).toBe('3 rails: 1 free, 1 busy, 1 waiting for a decision.')
    expect(envelope.data.items).toEqual([
      { ref: 'rail:shop-api/0', index: 0, label: 'Rail 1 Auth', availability: 'busy', specs: ['spec:shop-api/12'], mode: 'implement', engine: 'codex', profile: null, run: 'run:shop-api/r1', hold: 'question', provider: 'codex' },
      { ref: 'rail:shop-api/1', index: 1, label: 'Rail 2', availability: 'free', specs: [], mode: 'implement', engine: null, profile: null },
      { ref: 'rail:shop-api/2', index: 2, label: 'Rail 3', availability: 'pending_decision', specs: ['spec:shop-api/7'], mode: 'implement', engine: null, profile: null, delivery: 'delivery:shop-api/d7', decision: 'on_review' },
    ])
    expect(envelope.data.reviewWip).toEqual({ limit: 3, pending: 1, reached: false })
    expect(approxTokens(text)).toBeLessThan(1500)
  })

  it('creates a rail and applies its settings in one call', async () => {
    routes.set(`POST ${P}/rails`, { status: 201, body: { rail: { railIndex: 1 } } })
    routes.set(`PUT ${P}/rails/1/tickets`, { body: {} })
    routes.set(`PUT ${P}/rails/1/engine`, { body: {} })
    const { envelope } = await rails({ action: 'create', name: 'Docs', config: { specIds: ['spec:shop-api/4', 5], engine: 'claude' } })
    expect(envelope.ok).toBe(true)
    expect(writes()).toEqual([
      { method: 'POST', path: `${P}/rails`, body: { name: 'Docs' } },
      { method: 'PUT', path: `${P}/rails/1/tickets`, body: { ticketIds: [4, 5] } },
      { method: 'PUT', path: `${P}/rails/1/engine`, body: { aiEngine: 'claude' } },
    ])
    expect(envelope.refs).toEqual({ rail: 'rail:shop-api/1' })
  })

  it('configures settings, keeps the specs on a mode change and refuses launch-time options', async () => {
    for (const leaf of ['tickets', 'profile', 'name']) routes.set(`PUT ${P}/rails/0/${leaf}`, { body: {} })
    await rails({ action: 'configure', rail: 0, config: { mode: 'loop', profile: null, name: 'Auth API' } })
    expect(writes()).toEqual([
      { method: 'PUT', path: `${P}/rails/0/tickets`, body: { ticketIds: [12], mode: 'loop' } },
      { method: 'PUT', path: `${P}/rails/0/profile`, body: { profileName: null } },
      { method: 'PUT', path: `${P}/rails/0/name`, body: { name: 'Auth API' } },
    ])
    const refused = await rails({ action: 'configure', rail: 'rail:shop-api/0', config: { model: 'opus', targetPr: 4 } })
    expect(refused.envelope.error).toMatchObject({ code: 'invalid_input' })
    expect(refused.envelope.error.message).toContain('specrails_runs(launch)')
    expect((await rails({ action: 'configure', rail: 0, config: { bogus: 1 } })).envelope.error.code).toBe('invalid_input')
    expect((await rails({ action: 'configure', rail: 0 })).envelope.error.code).toBe('invalid_input')
  })

  it('removes a rail only after confirmation, stale once the rail changed', async () => {
    routes.set(`DELETE ${P}/rails/1`, { body: { ok: true, railIndex: 1 } })
    const first = await rails({ action: 'remove', rail: 1 })
    expect(first.envelope.error).toMatchObject({ code: 'confirmation_required', preview: { reversible: false, refs: ['rail:shop-api/1'] } })
    routes.set(`GET ${P}/rails`, { body: { ...SNAPSHOT, rails: SNAPSHOT.rails.map((rail) => rail.railIndex === 1 ? { ...rail, ticketIds: [9] } : rail) } })
    const stale = await rails({ action: 'remove', rail: 1, confirm: first.envelope.error.confirmToken })
    expect(stale.envelope.error.code).toBe('stale')
    expect(writes()).toHaveLength(0)
    await rails({ action: 'remove', rail: 1, confirm: stale.envelope.error.confirmToken })
    expect(writes()).toEqual([{ method: 'DELETE', path: `${P}/rails/1`, body: undefined }])
  })

  it('renames, prepares and releases worktrees, reads overlaps and the forecast', async () => {
    routes.set(`PUT ${P}/rails/1/name`, { body: {} })
    routes.set(`POST ${P}/rails/worktree-preparation`, { body: { preparing: 2 } })
    routes.set(`POST ${P}/rails/worktree-preparation/release`, { body: { released: 2 } })
    routes.set(`GET ${P}/rails/0/launch-overlaps`, { body: { overlaps: [{ railIndex: 2, files: ['src/auth.ts'] }] } })
    routes.set(`GET ${P}/rails/2/launch-overlaps`, { body: { overlaps: [] } })
    routes.set(`GET ${P}/launch-forecast`, { body: { time: { p25Ms: 300_000, p75Ms: 600_000 }, cost: { lowUsd: 1, highUsd: 2.5 }, minSamples: 5 } })
    await rails({ action: 'rename', rail: 1, name: 'Docs' })
    expect(writes().at(-1)?.body).toEqual({ name: 'Docs' })
    expect((await rails({ action: 'prepare_worktrees', options: { count: 2 } })).envelope.summary).toContain('2 worktree')
    expect((await rails({ action: 'release_worktrees' })).envelope.ok).toBe(true)
    const overlaps = await rails({ action: 'overlaps' })
    expect(overlaps.envelope.data.items.map((item: { rail: string }) => item.rail)).toEqual(['rail:shop-api/0', 'rail:shop-api/2'])
    expect(overlaps.envelope.summary).toContain('1 other rail')
    const forecast = await rails({ action: 'forecast', rail: 0 })
    expect(calls.at(-1)?.path).toBe(`${P}/launch-forecast?loopId=factory%3Aimplement&provider=codex`)
    expect(forecast.envelope.summary).toBe('Rail 1 Auth: usually 5–10 min, 1.00–2.50 USD.')
    expect((await rails({ action: 'forecast' })).envelope.error.code).toBe('invalid_input')
    expect((await rails({ action: 'rename', rail: 9, name: 'x' })).envelope.error.code).toBe('not_found')
  })
})
