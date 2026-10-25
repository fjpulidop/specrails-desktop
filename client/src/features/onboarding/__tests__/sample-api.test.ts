import { describe, expect, it, vi, beforeEach } from 'vitest'
import { launchFirstSpec, createSampleProject, removeSampleProject, SampleApiError } from '../lib/sample-api'
import type { SamplePreset } from '../lib/sample-model'

const cloud: SamplePreset = { provider: 'claude', model: 'haiku', local: false, loopId: 'factory:sdd-quick-openspec', runCapUsd: 1 }
const local: SamplePreset = { provider: 'local-lan', model: 'qwen3-coder', local: true, loopId: 'factory:sdd-quick-openspec', runCapUsd: null }

type Call = { url: string; method: string; body: unknown }
function mockRails(opts: { rails?: unknown[]; launch?: { ok: boolean; status?: number; body?: unknown } } = {}) {
  const calls: Call[] = []
  global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
    if (method === 'GET') return { ok: true, json: async () => ({ rails: opts.rails ?? [{ railIndex: 0, availability: 'free', ticketIds: [] }] }) }
    if (url.endsWith('/launch')) return { ok: opts.launch?.ok ?? true, status: opts.launch?.status ?? 202, json: async () => opts.launch?.body ?? { loopRunIds: ['r1'] } }
    return { ok: true, json: async () => ({ rail: { railIndex: 3 } }) }
  })
  return calls
}

describe('launchFirstSpec (the cost-bounded preset)', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('assigns the first spec to a free rail, then launches Quick SDD on the cheapest model with the per-run cap', async () => {
    const calls = mockRails()
    await expect(launchFirstSpec('p1', 11, cloud)).resolves.toEqual({ ok: true })
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^.*\/api\/projects\/p1/, '')}`)).toEqual(['GET /rails', 'PUT /rails/0/tickets', 'POST /rails/0/launch'])
    expect(calls[1].body).toEqual({ ticketIds: [11] })
    expect(calls[2].body).toEqual({ loopId: 'factory:sdd-quick-openspec', aiEngine: 'claude', model: 'haiku', runCapUsd: 1 })
  })

  it('sends no cap for a local engine (no marginal cost)', async () => {
    const calls = mockRails()
    await launchFirstSpec('p1', 11, local)
    expect(calls[2].body).toEqual({ loopId: 'factory:sdd-quick-openspec', aiEngine: 'local-lan', model: 'qwen3-coder' })
  })

  it('creates a rail when none is free', async () => {
    const calls = mockRails({ rails: [{ railIndex: 0, availability: 'busy', ticketIds: [5] }] })
    await expect(launchFirstSpec('p1', 11, cloud)).resolves.toEqual({ ok: true })
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'PUT', 'POST'])
    expect(calls[2].url).toContain('/rails/3/tickets')
  })

  it('maps a daily-budget rejection and any other failure', async () => {
    mockRails({ launch: { ok: false, status: 409, body: { error: 'daily_budget_exceeded', period: 'day', budgetUsd: 5, spentUsd: 5, resetsAt: null } } })
    expect(await launchFirstSpec('p1', 11, cloud)).toEqual({ ok: false, code: 'over_budget' })
    mockRails({ launch: { ok: false, status: 409, body: { error: 'pr_decision_pending', detail: 'Decide the pending PR first' } } })
    expect(await launchFirstSpec('p1', 11, cloud)).toEqual({ ok: false, code: 'failed', detail: 'Decide the pending PR first' })
    global.fetch = vi.fn().mockRejectedValue(new Error('offline'))
    expect(await launchFirstSpec('p1', 11, cloud)).toEqual({ ok: false, code: 'failed' })
  })
})

describe('create / remove', () => {
  it('surfaces the server error code', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'path_exists', detail: 'That folder already exists' }) })
    await expect(createSampleProject({ locale: 'en', path: '/h/x' })).rejects.toMatchObject({ code: 'path_exists' })
    await expect(removeSampleProject(true)).rejects.toBeInstanceOf(SampleApiError)
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain('?deleteFolder=1')
  })
})
