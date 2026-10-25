import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { setDetectedProvidersSupplier } from '../../../provider-selection'
import { TRIAGE_PROMPT_VERSION, triageTicketText, type TriageInputs, type TriageLoopOption } from '../domain/triage'
import { readStore } from './ticket-store'
import { SpecTriageService, cheapestModelForProvider, hashTriageInputs, resolveTriageEngine, type SpecTriageDeps } from './triage'
import { TriageModelError, type TriageModelResult } from './triage-runner'

const LOOPS: TriageLoopOption[] = [
  { id: 'factory:implement', name: 'Implement', description: 'full' },
  { id: 'factory:sdd-quick-openspec', name: 'Quick SDD', description: 'light' },
]

const ANSWER = JSON.stringify({
  size: 'S', filesLikely: ['server/a.ts'], publicInterfaces: false, dataModel: false, securitySurface: false,
  recommendedLoop: 'factory:sdd-quick-openspec', rationale: 'Single file', confidence: 'high',
})

function result(text = ANSWER): TriageModelResult {
  return { text, model: 'claude-haiku-5-5', provider: 'claude', costUsd: 0.0123, costEstimated: false, tokensIn: 900, tokensOut: 80, durationMs: 1200 }
}

function ticket(id: number, extra: Record<string, unknown> = {}) {
  return {
    id, title: `Spec ${id} rail selector`, description: 'Do the thing', status: 'todo', priority: 'medium', labels: ['rails'],
    assignee: null, prerequisites: [], metadata: {}, origin_conversation_id: null, is_epic: false, parent_epic_id: null,
    execution_order: null, short_summary: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    created_by: 'user', source: 'manual', ...extra,
  }
}

describe('SpecTriageService', () => {
  let dir: string
  let file: string
  let db: DbInstance
  let broadcast: ReturnType<typeof vi.fn>
  let runModel: ReturnType<typeof vi.fn>
  let notify: ReturnType<typeof vi.fn>

  const writeTickets = (tickets: ReturnType<typeof ticket>[]) => {
    fs.writeFileSync(file, JSON.stringify({
      schema_version: '1.5', revision: Date.now(), last_updated: new Date().toISOString(),
      next_id: 100, tickets: Object.fromEntries(tickets.map((t) => [String(t.id), t])),
    }))
  }
  const service = (overrides: Partial<SpecTriageDeps> = {}) => new SpecTriageService({
    project: { id: 'p1', slug: 'p1', path: dir, provider: 'claude', providers: ['claude'] },
    db, ticketsPath: () => file, broadcast, notifyDesktopWrite: notify,
    resolveEngine: () => ({ ok: true, engine: { provider: 'claude', model: 'haiku' } }),
    runModel, repoMap: () => null, loops: () => LOOPS, autoEnabled: () => true, debounceMs: 5,
    now: () => new Date('2026-10-22T10:00:00.000Z'),
    ...overrides,
  })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'))
    file = path.join(dir, 'local-tickets.json')
    db = initDb(':memory:')
    broadcast = vi.fn()
    notify = vi.fn()
    runModel = vi.fn(async () => result())
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('stores a ready triage, records the real cost on the triage surface and keeps updated_at', async () => {
    writeTickets([ticket(1)])
    const outcome = await service().triageNow(1)
    expect(outcome).toMatchObject({ kind: 'stored', triage: { status: 'ready', size: 'S', recommendedLoop: 'factory:sdd-quick-openspec', costUsd: 0.0123, model: 'claude-haiku-5-5' } })
    const stored = readStore(file).tickets['1']
    expect(stored.metadata.triage).toMatchObject({ status: 'ready', computedAt: '2026-10-22T10:00:00.000Z' })
    expect(stored.metadata.triage!.inputsHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(stored.updated_at).toBe('2026-10-01T00:00:00.000Z')
    const rows = db.prepare(`SELECT surface, ticket_id, status, total_cost_usd, model FROM ai_invocations`).all()
    expect(rows).toEqual([{ surface: 'triage', ticket_id: 1, status: 'success', total_cost_usd: 0.0123, model: 'claude-haiku-5-5' }])
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket_updated', projectId: 'p1' }))
    expect(notify).toHaveBeenCalledWith(readStore(file).revision)
  })

  it('never invents values when no model is available', async () => {
    writeTickets([ticket(1)])
    const outcome = await service({ resolveEngine: () => ({ ok: false, reason: 'provider_not_detected:claude' }) }).triageNow(1)
    expect(runModel).not.toHaveBeenCalled()
    const triage = readStore(file).tickets['1'].metadata.triage
    expect(outcome.kind).toBe('stored')
    expect(triage).toEqual({ status: 'unavailable', reason: 'provider_not_detected:claude', inputsHash: expect.stringMatching(/^sha256:/), computedAt: '2026-10-22T10:00:00.000Z' })
    expect(triage).not.toHaveProperty('size')
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_invocations').get()).toEqual({ n: 0 })
  })

  it('skips an unchanged inputs hash unless forced', async () => {
    writeTickets([ticket(1)])
    const svc = service()
    await svc.triageNow(1)
    expect(await svc.triageNow(1)).toMatchObject({ kind: 'unchanged' })
    expect(runModel).toHaveBeenCalledTimes(1)
    expect(await svc.triageNow(1, { force: true })).toMatchObject({ kind: 'stored' })
    expect(runModel).toHaveBeenCalledTimes(2)
  })

  it('records an unrepairable answer as failed with its real cost', async () => {
    writeTickets([ticket(1)])
    runModel.mockResolvedValueOnce(result('I think it is medium sized.'))
    await service().triageNow(1)
    expect(readStore(file).tickets['1'].metadata.triage).toMatchObject({ status: 'failed', error: 'invalid_output:no_json_object', costUsd: 0.0123 })
    expect(db.prepare('SELECT status, total_cost_usd FROM ai_invocations').get()).toEqual({ status: 'failed', total_cost_usd: 0.0123 })
  })

  it('keeps the partial usage of a provider failure', async () => {
    writeTickets([ticket(1)])
    runModel.mockRejectedValueOnce(new TriageModelError('claude exit code=1', { ...result(), costUsd: 0.004 }))
    await service().triageNow(1)
    expect(readStore(file).tickets['1'].metadata.triage).toMatchObject({ status: 'failed', error: 'claude exit code=1', costUsd: 0.004 })
    expect(db.prepare('SELECT status, total_cost_usd FROM ai_invocations').get()).toEqual({ status: 'failed', total_cost_usd: 0.004 })
  })

  it('refuses cancelled specs, epics and unknown ids', async () => {
    writeTickets([ticket(1, { status: 'cancelled' }), ticket(2, { is_epic: true })])
    const svc = service()
    expect(await svc.triageNow(1)).toEqual({ kind: 'not_applicable', reason: 'cancelled' })
    expect(await svc.triageNow(2)).toEqual({ kind: 'not_applicable', reason: 'epic' })
    expect(await svc.triageNow(9)).toEqual({ kind: 'not_found' })
  })

  it('debounces triggers and only triages new or edited draft/todo specs', async () => {
    writeTickets([ticket(1), ticket(2), ticket(3, { status: 'in_progress' })])
    const svc = service()
    svc.start()
    // Spec 4 created, spec 1 edited, spec 3 edited but in progress, spec 2 untouched.
    writeTickets([
      ticket(1, { description: 'Edited' }), ticket(2), ticket(3, { status: 'in_progress', description: 'Edited' }), ticket(4, { status: 'draft' }),
    ])
    for (let i = 0; i < 3; i++) svc.observe({ type: 'ticket_updated', projectId: 'p1', ticket: { id: 0 }, timestamp: '' } as never)
    svc.observe({ type: 'queue', jobs: [] } as never)
    await vi.waitFor(() => expect(runModel).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(readStore(file).tickets['4'].metadata.triage).toBeDefined())
    const titles = runModel.mock.calls.map(([req]) => JSON.parse(req.userPrompt.split('\n').slice(1).join('\n')).spec.title)
    expect(titles.sort()).toEqual(['Spec 1 rail selector', 'Spec 4 rail selector'])
    expect(readStore(file).tickets['2'].metadata.triage).toBeUndefined()
    expect(readStore(file).tickets['3'].metadata.triage).toBeUndefined()
    // Our own triage write is observed too: the signatures did not change, no new run.
    svc.observe({ type: 'ticket_updated', projectId: 'p1', ticket: { id: 4 }, timestamp: '' } as never)
    await new Promise((r) => setTimeout(r, 30))
    expect(runModel).toHaveBeenCalledTimes(2)
    svc.dispose()
  })

  it('does nothing automatically when the kill switch is off', async () => {
    writeTickets([])
    const svc = service({ autoEnabled: () => false })
    svc.start()
    writeTickets([ticket(1)])
    svc.observe({ type: 'ticket_created', projectId: 'p1', ticket: { id: 1 }, timestamp: '' } as never)
    await new Promise((r) => setTimeout(r, 30))
    expect(runModel).not.toHaveBeenCalled()
  })

  it('stops after dispose', async () => {
    writeTickets([ticket(1)])
    const svc = service()
    svc.dispose()
    expect(await svc.triageNow(1)).toEqual({ kind: 'disposed' })
  })

  it('uses files touched by similar specs from file_provenance', async () => {
    writeTickets([ticket(1), ticket(2, { title: 'Spec 2 rail selector polish' })])
    db.prepare(`INSERT INTO file_provenance (file_path, ticket_id, job_id, kind, at) VALUES (?, ?, ?, ?, ?)`).run('client/RailRow.tsx', 2, 'j', 'modified', 1)
    await service().triageNow(1)
    expect(runModel.mock.calls[0][0].userPrompt).toContain('"filesTouchedBySimilarSpecs":["client/RailRow.tsx"]')
  })
})

describe('hashTriageInputs', () => {
  const inputs = (engine: string | null): TriageInputs => ({
    promptVersion: TRIAGE_PROMPT_VERSION, ticket: triageTicketText({ title: 'T', labels: ['b', 'a'] }), repoMap: null,
    similarFiles: [], loops: LOOPS, engine,
  })
  it('is stable and sensitive to the engine', () => {
    expect(hashTriageInputs(inputs('claude:haiku'))).toBe(hashTriageInputs({ ...inputs('claude:haiku'), ticket: triageTicketText({ labels: ['a', 'b'], title: 'T' }) }))
    expect(hashTriageInputs(inputs('claude:haiku'))).not.toBe(hashTriageInputs(inputs('claude:sonnet')))
  })
})

describe('triage engine', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-engine-')) })
  afterEach(() => {
    setDetectedProvidersSupplier(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('defaults to the cheapest priced model of the primary provider', () => {
    expect(cheapestModelForProvider('claude')).toBe('haiku')
    expect(cheapestModelForProvider('gemini')).toBe('gemini-2.5-flash-lite')
    setDetectedProvidersSupplier(() => ['claude'])
    expect(resolveTriageEngine({ id: 'p', slug: 'p', path: dir, provider: 'claude', providers: ['claude'] }))
      .toEqual({ ok: true, engine: { provider: 'claude', model: 'haiku' } })
  })

  it('is unavailable when the primary provider is not detected', () => {
    setDetectedProvidersSupplier(() => ['nonexistent-engine'])
    expect(resolveTriageEngine({ id: 'p', slug: 'p', path: dir, provider: 'nonexistent-engine', providers: [] }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/^provider_not_registered:/) })
  })
})
