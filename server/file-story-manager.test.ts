import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDb, type DbInstance } from './db'
import { recordProvenanceForJob, type StoredPatch } from './file-provenance'
import { getContribution } from './file-story'
import { FileStoryManager, buildStorySystemPrompt } from './file-story-manager'
import type { GenerateOutput } from './file-summary-manager'

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1,2 @@',
  '+const added = true',
  ' const kept = 1',
  '',
].join('\n')

const GEN_OUT: GenerateOutput = {
  summary: 'This change added the login button.',
  model: 'claude-haiku-4-5',
  provider: 'claude',
  costUsd: 0.002,
  tokensIn: 100,
  tokensOut: 40,
  durationMs: 900,
}

let db: DbInstance
let broadcast: ReturnType<typeof vi.fn>

function seedIntervention(withPatch = true): number {
  const patches = withPatch
    ? new Map<string, StoredPatch>([['src/app.ts', { patch: PATCH, truncated: false }]])
    : undefined
  const rows = recordProvenanceForJob(db, 'p1', 'job-1', 7, [{ path: 'src/app.ts', status: 'M' }], 1000, patches)
  return rows[0].id
}

function makeManager(overrides: Partial<ConstructorParameters<typeof FileStoryManager>[0]> = {}) {
  return new FileStoryManager({
    db,
    broadcast: broadcast as never,
    generate: vi.fn(async () => GEN_OUT),
    monthToDateSpend: () => 0,
    monthlyBudgetUsd: () => 5,
    language: () => 'en',
    providerId: () => 'claude',
    getTicketSpec: (id) => (id === 7 ? { id, title: 'Login screen', status: 'done' } : undefined),
    ...overrides,
  })
}

beforeEach(() => {
  db = initDb(':memory:')
  broadcast = vi.fn()
})

afterEach(() => {
  db.close()
})

describe('buildStorySystemPrompt', () => {
  it('switches language', () => {
    expect(buildStorySystemPrompt('en')).toMatch(/non-developer/)
    expect(buildStorySystemPrompt('es')).toMatch(/no desarrolladora/)
  })
})

describe('FileStoryManager.explain', () => {
  it('generates, persists, records the invocation, and broadcasts', async () => {
    const provenanceId = seedIntervention()
    const generate = vi.fn(async () => GEN_OUT)
    const mgr = makeManager({ generate })

    const result = await mgr.explain({ projectId: 'p1', relPath: 'src/app.ts', provenanceId })
    expect(result).toBe('generated')

    // Prompt composition: spec title + kind + diff.
    const input = generate.mock.calls[0][0] as { relPath: string; contents: string }
    expect(input.relPath).toBe('src/app.ts')
    expect(JSON.parse(input.contents)).toMatchObject({ ticket: { currentTitle: 'Login screen' }, changeKind: 'modified', evidence: { kind: 'diff', truncated: false } })
    expect(JSON.parse(input.contents).patch).toContain('+const added = true')

    // Persisted.
    expect(getContribution(db, provenanceId)?.summary).toBe('This change added the login button.')

    // ai_invocations row on the file-summary surface (shared Code-section budget).
    const inv = db.prepare(`SELECT surface, status, model, total_cost_usd, ticket_id FROM ai_invocations`).get() as {
      surface: string; status: string; model: string; total_cost_usd: number; ticket_id: number
    }
    expect(inv.surface).toBe('file-summary')
    expect(inv.status).toBe('success')
    expect(inv.total_cost_usd).toBeCloseTo(0.002)
    expect(inv.ticket_id).toBe(7)

    // WS: story updated + spending invalidated.
    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toContain('file.story_updated')
    expect(types).toContain('spending.invalidated')
    const storyMsg = broadcast.mock.calls.map((c) => c[0] as { type: string; ok?: boolean; provenanceId?: number; path?: string })
      .find((m) => m.type === 'file.story_updated')!
    expect(storyMsg.ok).toBe(true)
    expect(storyMsg.provenanceId).toBe(provenanceId)
    expect(storyMsg.path).toBe('src/app.ts')
  })

  it('skips on budget (and honours overrideBudget)', async () => {
    const provenanceId = seedIntervention()
    const generate = vi.fn(async () => GEN_OUT)
    const mgr = makeManager({ generate, monthToDateSpend: () => 10, monthlyBudgetUsd: () => 5 })

    expect(await mgr.explain({ projectId: 'p1', relPath: 'src/app.ts', provenanceId })).toBe('skipped:budget')
    expect(generate).not.toHaveBeenCalled()

    expect(await mgr.explain({ projectId: 'p1', relPath: 'src/app.ts', provenanceId, overrideBudget: true }))
      .toBe('generated')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('returns skipped:not-found for an unknown or mismatched intervention', async () => {
    const provenanceId = seedIntervention()
    const mgr = makeManager()
    expect(await mgr.explain({ projectId: 'p1', relPath: 'src/app.ts', provenanceId: 9999 })).toBe('skipped:not-found')
    // Right id, wrong path — must not leak another file's diff.
    expect(await mgr.explain({ projectId: 'p1', relPath: 'other.ts', provenanceId })).toBe('skipped:not-found')
  })

  it('records a failed invocation (with partial usage) and broadcasts failure', async () => {
    const provenanceId = seedIntervention()
    const err = new Error('generator timeout') as Error & { partial?: Partial<GenerateOutput> }
    err.partial = { provider: 'claude', model: 'haiku', costUsd: 0.001, tokensIn: 50, tokensOut: 0, durationMs: 500, costEstimated: true }
    const mgr = makeManager({ generate: vi.fn(async () => { throw err }) })

    expect(await mgr.explain({ projectId: 'p1', relPath: 'src/app.ts', provenanceId })).toBe('failed')
    expect(getContribution(db, provenanceId)?.summary).toBeNull()

    const inv = db.prepare(`SELECT status, total_cost_usd, total_cost_usd_estimated FROM ai_invocations`).get() as {
      status: string; total_cost_usd: number; total_cost_usd_estimated: number
    }
    expect(inv.status).toBe('failed')
    expect(inv.total_cost_usd).toBeCloseTo(0.001)
    expect(inv.total_cost_usd_estimated).toBe(1)

    const storyMsg = broadcast.mock.calls.map((c) => c[0] as { type: string; ok?: boolean; reason?: string })
      .find((m) => m.type === 'file.story_updated')!
    expect(storyMsg.ok).toBe(false)
    expect(storyMsg.reason).toBe('generator timeout')
  })

  it('dedupes concurrent explains for the same intervention', async () => {
    const provenanceId = seedIntervention()
    let resolveGen: (v: GenerateOutput) => void
    const generate = vi.fn(() => new Promise<GenerateOutput>((res) => { resolveGen = res }))
    const mgr = makeManager({ generate })

    const p1 = mgr.explain({ projectId: 'p1', relPath: 'src/app.ts', provenanceId })
    const p2 = mgr.explain({ projectId: 'p1', relPath: 'src/app.ts', provenanceId })
    resolveGen!(GEN_OUT)
    expect(await p1).toBe('generated')
    expect(await p2).toBe('generated')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('does not generate an explanation without stored patch evidence', async () => {
    const provenanceId = seedIntervention(false)
    const generate = vi.fn(async () => GEN_OUT)
    const mgr = makeManager({ generate })
    expect(await mgr.explain({ projectId: 'p1', relPath: 'src/app.ts', provenanceId })).toBe('skipped:no-evidence')
    expect(generate).not.toHaveBeenCalled()
  })

  it('bounds a runaway generated paragraph', async () => {
    const provenanceId = seedIntervention()
    const mgr = makeManager({ generate: vi.fn(async () => ({ ...GEN_OUT, summary: 'x'.repeat(5000) })) })
    expect(await mgr.explain({ projectId: 'p1', relPath: 'src/app.ts', provenanceId })).toBe('generated')
    expect(getContribution(db, provenanceId)!.summary!.length).toBe(2000)
  })
})
