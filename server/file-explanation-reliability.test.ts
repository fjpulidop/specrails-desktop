import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from './db'
import { FileSummaryManager, readSummary, writeSummary, summaryFilePath, CURRENT_PROMPT_VERSION, isSummaryMetadataStale, __resetDesktopSummaryStateForTests, type GenerateOutput, type SummaryLanguage } from './file-summary-manager'
import { FileStoryManager } from './file-story-manager'
import { getFileStory, getContribution, setContributionSummary, migrateFileStoryMetadata } from './file-story'
import { recordProvenanceForJob } from './file-provenance'

const output = (summary = 'Visible responsibility'): GenerateOutput => ({ summary, model: 'fixture', provider: 'claude', costUsd: 0.001, tokensIn: 1, tokensOut: 1, durationMs: 1 })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const patch = 'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n'
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
let db: DbInstance
let root: string
let dbClosed = false
const managers: FileSummaryManager[] = []
beforeEach(() => { __resetDesktopSummaryStateForTests(); db = initDb(':memory:'); dbClosed = false; root = mkdtempSync(join(os.tmpdir(), 'file-explanation-')) })
afterEach(() => { managers.splice(0).forEach(m => m.dispose()); if (!dbClosed) db.close(); rmSync(root, { recursive: true, force: true }); __resetDesktopSummaryStateForTests() })
function manager(overrides: Partial<ConstructorParameters<typeof FileSummaryManager>[0]> = {}, concurrency = 1) {
  const generate = vi.fn(async () => output()); const broadcast = vi.fn()
  const deps = { db, generate, broadcast, monthToDateSpend: () => 0, monthlyBudgetUsd: () => 5, ...overrides }
  const scheduler = new FileSummaryManager(deps, { perProjectConcurrency: concurrency }); managers.push(scheduler)
  return { scheduler, generate, broadcast, deps }
}
function request(relPath = 'app.ts') { return { projectPath: root, projectId: 'p', projectSlug: 'p', repositoryId: 'api', relPath, triggeredBy: { kind: 'user' as const, id: 'fixture', ticketId: null } } }
function intervention(index = 1, truncated = false) {
  return recordProvenanceForJob(db, 'p', 'job-' + index, index, [{ path: 'app.ts', status: 'M' }], index,
    new Map([['app.ts', { patch, truncated }]]), 'api')[0]!.id
}
const explainRequest = (provenanceId: number) => ({ projectId: 'p', repository: { repositoryId: 'api' }, relPath: 'app.ts', provenanceId })

describe('explanation source snapshots and disposal', () => {
  it('hashes the bytes read after queue admission, not the earlier hash check', async () => {
    writeFileSync(join(root, 'app.ts'), 'old')
    const release = deferred<boolean>()
    const { scheduler } = manager({ generate: vi.fn(async input => output(input.contents)) })
    const blocker = scheduler.scheduleTask({ projectId: 'p', relPath: 'blocker' }, () => release.promise)
    const pending = scheduler.enqueue(request())
    await vi.waitFor(() => expect((scheduler as unknown as { queues: Map<string, unknown[]> }).queues.get('p')).toHaveLength(1))
    writeFileSync(join(root, 'app.ts'), 'new')
    release.resolve(true); await blocker; expect(await pending).toBe('enqueued')
    expect(readSummary(root, 'app.ts')).toMatchObject({ summary: 'new', fileHash: hash('new'), generatedBy: { promptVersion: CURRENT_PROMPT_VERSION } })
  })

  it('revalidates a queued file replaced by an escaping symlink before generation', async () => {
    writeFileSync(join(root, 'app.ts'), 'old')
    const outside = join(os.tmpdir(), 'summary-outside-' + Date.now() + '.txt')
    writeFileSync(outside, 'private external data')
    const release = deferred<boolean>()
    const { scheduler, generate } = manager()
    try {
      const blocker = scheduler.scheduleTask({ projectId: 'p', relPath: 'blocker' }, () => release.promise)
      const pending = scheduler.enqueue(request())
      await vi.waitFor(() => expect((scheduler as unknown as { queues: Map<string, unknown[]> }).queues.get('p')).toHaveLength(1))
      rmSync(join(root, 'app.ts')); symlinkSync(outside, join(root, 'app.ts'))
      release.resolve(true); await blocker
      expect(await pending).toBe('skipped:not-found')
      expect(generate).not.toHaveBeenCalled()
    } finally { rmSync(outside, { force: true }) }
  })

  it('publishes stale when source changes while the provider runs', async () => {
    writeFileSync(join(root, 'app.ts'), 'before')
    const release = deferred<GenerateOutput>(), started = deferred<void>()
    const { scheduler, broadcast } = manager({ generate: async () => { started.resolve(); return release.promise } })
    const pending = scheduler.enqueue(request()); await started.promise
    writeFileSync(join(root, 'app.ts'), 'after'); release.resolve(output('Explains before'))
    expect(await pending).toBe('enqueued')
    expect(readSummary(root, 'app.ts')?.fileHash).toBe(hash('before'))
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'file.summary_updated', stale: true, repositoryId: 'api' }))
  })

  it('settles disposal during asynchronous admission and rejects later work', async () => {
    writeFileSync(join(root, 'app.ts'), 'source')
    const { scheduler, generate } = manager()
    const pending = scheduler.enqueue(request()); scheduler.dispose(); db.close(); dbClosed = true
    expect(await pending).toBe('skipped:not-found')
    expect(await scheduler.enqueue(request())).toBe('skipped:not-found')
    await scheduler.flush(); expect(generate).not.toHaveBeenCalled()
  })

  it('settles queued work even if a skipped-event transport throws during disposal', async () => {
    const release = deferred<boolean>()
    const { scheduler } = manager({ broadcast: () => { throw new Error('closed transport') } })
    const blocker = scheduler.scheduleTask({ projectId: 'p', relPath: 'blocker' }, () => release.promise)
    writeFileSync(join(root, 'app.ts'), 'source')
    const pending = scheduler.enqueue(request())
    await vi.waitFor(() => expect((scheduler as unknown as { queues: Map<string, unknown[]> }).queues.get('p')).toHaveLength(1))
    scheduler.dispose(); expect(await pending).toBe('skipped:not-found')
    release.resolve(true); await blocker
  })

  it('keeps legacy caches readable while detecting prompt and language freshness', () => {
    const legacy = { schemaVersion: 1 as const, path: 'app.ts', fileHash: hash('source'), summary: 'Old explanation', language: 'en' as const, generatedAt: '2026-01-01T00:00:00Z', generatedBy: { model: 'fixture', promptVersion: 1 }, triggeredBy: { kind: 'user' as const, id: 'old', ticketId: null } }
    writeSummary(root, 'app.ts', legacy)
    expect(readSummary(root, 'app.ts')).toEqual(legacy)
    const file = summaryFilePath(root, 'app.ts')
    writeFileSync(file, JSON.stringify({ ...legacy, path: 'another.ts' })); expect(readSummary(root, 'app.ts')).toBeNull()
    writeFileSync(file, JSON.stringify({ ...legacy, generatedAt: 'not-a-date' })); expect(readSummary(root, 'app.ts')).toBeNull()
    writeSummary(root, 'app.ts', legacy)
    expect(isSummaryMetadataStale(legacy, 'en')).toBe(true)
    expect(isSummaryMetadataStale({ ...legacy, generatedBy: { ...legacy.generatedBy, promptVersion: CURRENT_PROMPT_VERSION } }, 'es')).toBe(true)
  })
})

describe('story evidence and shared generation lifecycle', () => {
  it('shares reserved spend with summaries and rechecks budget when dequeued', async () => {
    writeFileSync(join(root, 'app.ts'), 'source')
    let spend = 4.995
    const release = deferred<GenerateOutput>(), started = deferred<void>()
    const { scheduler } = manager({ monthToDateSpend: () => spend, generate: async () => { started.resolve(); await release.promise; spend = 5; return output() } })
    const generate = vi.fn(async () => output())
    const story = new FileStoryManager({ db, scheduler, generate, broadcast: vi.fn(), monthToDateSpend: () => spend, monthlyBudgetUsd: () => 5 })
    const summary = scheduler.enqueue(request()); await started.promise
    const pendingStory = story.explain(explainRequest(intervention()))
    release.resolve(output()); await summary
    expect(await pendingStory).toBe('skipped:budget'); expect(generate).not.toHaveBeenCalled()
  })

  it('bounds distinct story workers and aborts them before a closed DB can be touched', async () => {
    const { scheduler } = manager({}, 2)
    const signals: AbortSignal[] = []
    const broadcast = vi.fn()
    const story = new FileStoryManager({ db, scheduler, broadcast, monthToDateSpend: () => 0, monthlyBudgetUsd: () => 5,
      generate: (_input, signal) => { signals.push(signal!); return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) } })
    const pending = Array.from({ length: 20 }, (_, i) => story.explain(explainRequest(intervention(i + 1))))
    expect(signals).toHaveLength(2)
    scheduler.dispose(); db.close(); dbClosed = true
    const outcomes = await Promise.all(pending)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(outcomes.filter(value => value === 'failed')).toHaveLength(2)
    expect(outcomes.filter(value => value === 'skipped:not-found')).toHaveLength(18)
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('caches exact evidence, marks changed language/title stale and supports explicit regeneration', async () => {
    const { scheduler } = manager()
    let language: SummaryLanguage = 'en', title = 'Original title'
    const generate = vi.fn(async () => output())
    const getTicket = () => ({ title })
    const story = new FileStoryManager({ db, scheduler, generate, getTicketSpec: getTicket, language: () => language, broadcast: vi.fn(), monthToDateSpend: () => 0, monthlyBudgetUsd: () => 5 })
    const id = intervention(1, true), req = explainRequest(id)
    expect(await story.explain(req)).toBe('generated')
    expect(await story.explain(req)).toBe('skipped:hash'); expect(generate).toHaveBeenCalledTimes(1)
    expect(getFileStory(db, 'app.ts', getTicket, req.repository, language)[0]).toMatchObject({ summaryLanguage: 'en', summaryPromptVersion: 2, summaryStale: false, evidence: { kind: 'diff', truncated: true }, summaryEvidence: { kind: 'diff', truncated: true } })
    language = 'es'
    expect(getFileStory(db, 'app.ts', getTicket, req.repository, language)[0]?.summaryStale).toBe(true)
    expect(await story.explain(req)).toBe('generated')
    title = 'Changed context'
    expect(getFileStory(db, 'app.ts', getTicket, req.repository, language)[0]?.summaryStale).toBe(true)
    expect(await story.explain(req)).toBe('generated')
    expect(await story.explain({ ...req, force: true })).toBe('generated'); expect(generate).toHaveBeenCalledTimes(4)
    expect(getContribution(db, id)?.summary_language).toBe('es')
    migrateFileStoryMetadata(db) // additive/idempotent, no cache deletion
    expect(getContribution(db, id)?.summary).toBe('Visible responsibility')
  })

  it('preserves a previous explanation if writing its new metadata fails', () => {
    const id = intervention()
    expect(setContributionSummary(db, id, 'Previous explanation', 'fixture')).toBe(true)
    db.exec(`CREATE TRIGGER fail_story_metadata BEFORE UPDATE OF summary_language ON file_story_contributions BEGIN SELECT RAISE(ABORT, 'metadata unavailable'); END`)
    expect(setContributionSummary(db, id, 'Replacement', 'fixture', new Date().toISOString(), { language: 'en', promptVersion: 2, inputHash: 'hash', evidence: { kind: 'diff', truncated: false } })).toBe(false)
    expect(getContribution(db, id)?.summary).toBe('Previous explanation')
  })

  it('discloses excerpt-only evidence and does not generate when evidence is absent', async () => {
    const { scheduler } = manager()
    const generate = vi.fn(async () => output())
    const story = new FileStoryManager({ db, scheduler, generate, broadcast: vi.fn(), monthToDateSpend: () => 0, monthlyBudgetUsd: () => 5 })
    const id = intervention()
    db.prepare('DELETE FROM file_provenance_diffs WHERE provenance_id = ?').run(id)
    expect(await story.explain(explainRequest(id))).toBe('generated')
    expect(getFileStory(db, 'app.ts', undefined, { repositoryId: 'api' })[0]?.evidence).toEqual({ kind: 'excerpt', truncated: true })
    db.prepare('UPDATE file_story_contributions SET patch_excerpt = NULL WHERE provenance_id = ?').run(id)
    expect(await story.explain({ ...explainRequest(id), force: true })).toBe('skipped:no-evidence')
    expect(generate).toHaveBeenCalledTimes(1)
  })
})
