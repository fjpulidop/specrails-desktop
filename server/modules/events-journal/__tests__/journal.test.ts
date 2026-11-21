import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { MobileEventBus } from '../../../mobile/mobile-event-bus'
import type { DbInstance } from '../../../db/types'
import { createSqliteJournalStore } from '../adapters/sqlite'
import { createEventJournal, matchesFilter, type EventJournal } from '../application'
import type { JournalDraft } from '../domain'
import type { JournalFilter } from '../ports'
import { eventJournalFor, stopEventJournal } from '../runtime'

const open: Array<{ close(): void }> = []
afterEach(() => { for (const item of open.splice(0)) { try { item.close() } catch { /* already closed */ } } })

function setup(options: { now?: () => number; db?: DbInstance } = {}): { db: DbInstance; journal: EventJournal } {
  const db = options.db ?? new Database(':memory:')
  const journal = createEventJournal({ store: createSqliteJournalStore(db), compactIntervalMs: 0, now: options.now })
  open.push(journal, db)
  return { db, journal }
}

const started = (jobId: string, projectId = 'p1') => ({ type: 'rail.job_started', projectId, railIndex: 0, jobId, mode: 'implement' })
const completed = (jobId: string, status = 'completed', projectId = 'p1') => ({ type: 'rail.job_completed', projectId, railIndex: 0, jobId, status, ticketIds: [] })
const asked = (loopRunId: string, interruptId = 'i1', projectId = 'p1') => ({ type: 'loop.run_paused', projectId, loopRunId, reason: 'q', question: { interruptId, kind: 'question', text: 'Proceed?', options: [{ id: 'yes', label: 'Yes' }] } })

function draft(i: number, overrides: Partial<JournalDraft> = {}): JournalDraft {
  return { projectId: `p${i % 100}`, refKind: 'run', refId: `r${i}`, kind: 'run.status', status: i % 7 === 0 ? 'failed' : 'running', hold: null, attention: i % 7 === 0 ? 'failed' : null, settled: i % 7 === 0, title: null, detail: null, data: null, source: 'test', ...overrides }
}

describe('event journal', () => {
  it('appends classified transitions in order and drops repeats', () => {
    const { journal } = setup()
    journal.ingest(started('j1'))
    journal.ingest(started('j1'))
    journal.ingest({ type: 'log', line: 'noise' })
    journal.ingest(asked('j1'))
    journal.ingest(asked('j1'))
    journal.ingest(completed('j1'))
    const { events } = journal.read(0, {}, 50)
    expect(events.map((e) => [e.kind, e.status, e.hold, e.prevStatus])).toEqual([
      ['run.status', 'running', null, null],
      ['run.hold', 'running', 'question', 'running'],
      ['run.status', 'completed', null, 'running'],
    ])
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('never lets a queue snapshot override a hold or a finished run', () => {
    const { journal } = setup()
    journal.ingest(asked('j1'))
    journal.ingest(completed('j2'))
    journal.ingest({ type: 'queue', projectId: 'p1', jobs: [{ id: 'j1', status: 'running' }, { id: 'j2', status: 'running' }, { id: 'j3', status: 'queued' }], activeJobId: null, paused: false, timestamp: 't' })
    const { events } = journal.read(0, {}, 50)
    expect(events.map((e) => `${e.refId}:${e.status}:${e.hold}`)).toEqual(['j1:running:question', 'j2:completed:null', 'j3:queued:queued'])
  })

  it('filters by refs, project, settled and attention identically in SQL and in memory', () => {
    const { journal } = setup()
    const drafts = Array.from({ length: 300 }, (_, i) => draft(i, { refId: `r${i % 40}`, status: `s${i}` }))
    journal.record(drafts)
    const all = journal.read(0, {}, 1000).events
    const filters: JournalFilter[] = [
      {}, { projectId: 'p3' }, { match: 'settled' }, { match: 'attention' },
      { refs: [{ kind: 'run', id: 'r7' }, { kind: 'run', id: 'r8' }] },
      { refs: [{ kind: 'run', id: 'r8' }], match: 'settled', alsoAttention: true },
      { refs: [{ kind: 'run', id: 'r8' }], projectId: 'p8', match: 'all', alsoAttention: true },
    ]
    for (const filter of filters) {
      expect(journal.read(0, filter, 1000).events.map((e) => e.seq), JSON.stringify(filter)).toEqual(all.filter((e) => matchesFilter(filter, e)).map((e) => e.seq))
    }
  })

  it('pages with a cursor that stays put when nothing matched', () => {
    const { journal } = setup()
    journal.record(Array.from({ length: 30 }, (_, i) => draft(i + 1, { attention: null, settled: false })))
    const first = journal.read(0, {}, 10)
    expect(first.events).toHaveLength(10)
    expect(first.more).toBe(true)
    expect(first.cursorSeq).toBe(10)
    const none = journal.read(0, { match: 'attention' }, 10)
    expect(none).toMatchObject({ events: [], more: false, cursorSeq: 30 })
  })

  it('wakes a waiter within 500 ms of a matching broadcast and ignores others', async () => {
    const { journal } = setup()
    const bus = new MobileEventBus()
    journal.attach(bus)
    journal.attach(bus) // idempotent
    const head = journal.bounds().head
    const waiting = journal.waitFor({ afterSeq: head, filter: { refs: [{ kind: 'run', id: 'j9' }], match: 'settled' }, limit: 8, timeoutMs: 5_000, settleMs: 20 })
    setTimeout(() => bus.publish(started('j9') as never), 10)
    setTimeout(() => bus.publish(completed('other') as never), 20)
    const sent = Date.now() + 40
    setTimeout(() => bus.publish(completed('j9') as never), 40)
    const outcome = await waiting
    const latency = Date.now() - sent
    expect(outcome.reason).toBe('event')
    expect(outcome.events.map((e) => [e.refId, e.status])).toEqual([['j9', 'completed']])
    expect(latency).toBeLessThan(500)
  })

  it('times out, aborts and interrupts without events', async () => {
    const { journal } = setup()
    expect((await journal.waitFor({ afterSeq: 0, filter: {}, limit: 5, timeoutMs: 30 })).reason).toBe('timeout')
    const controller = new AbortController()
    const aborted = journal.waitFor({ afterSeq: 0, filter: {}, limit: 5, timeoutMs: 5_000, signal: controller.signal })
    controller.abort()
    expect((await aborted).reason).toBe('aborted')
    let wake = () => {}
    const interrupted = journal.waitFor({ afterSeq: 0, filter: {}, limit: 5, timeoutMs: 5_000, interrupt: (fn) => { wake = fn; return () => {} } })
    wake()
    expect((await interrupted).reason).toBe('interrupted')
    const progress: number[] = []
    await journal.waitFor({ afterSeq: 0, filter: {}, limit: 5, timeoutMs: 70, onProgress: (ms) => progress.push(ms), progressEveryMs: 20 })
    expect(progress.length).toBeGreaterThanOrEqual(2)
  })

  it('answers at once when matching rows already follow the cursor', async () => {
    const { journal } = setup()
    journal.ingest(completed('j1'))
    const outcome = await journal.waitFor({ afterSeq: 0, filter: { match: 'settled' }, limit: 5, timeoutMs: 5_000 })
    expect(outcome).toMatchObject({ reason: 'event', waitedMs: 0 })
  })

  it('resumes a cursor across a restart of the process and database', () => {
    const { db, journal } = setup()
    journal.ingest(started('j1'))
    journal.ingest(asked('j1'))
    const epoch = journal.epoch()
    const cursor = journal.read(0, {}, 10).cursorSeq
    journal.close()
    const image = db.serialize()
    db.close()

    const reopened = new Database(image)
    const { journal: after } = setup({ db: reopened })
    expect(after.epoch()).toBe(epoch)
    // The same state after restart is not a new transition (the last row is re-read).
    after.ingest(asked('j1'))
    after.ingest(completed('j1'))
    const page = after.read(cursor, {}, 10)
    expect(page.events.map((e) => [e.seq, e.status, e.prevStatus])).toEqual([[3, 'completed', 'running']])
  })

  it('applies age, row cap and compaction, keeping decisions and the latest state of each ref', () => {
    let clock = Date.parse('2026-11-01T00:00:00Z')
    const { db, journal } = setup({ now: () => clock })
    const store = createSqliteJournalStore(db)
    journal.record([draft(1, { refId: 'old', status: 'running' })])
    journal.flush()
    clock += 8 * 24 * 3600_000
    journal.record([
      draft(2, { refId: 'a', status: 'queued' }), draft(3, { refId: 'a', status: 'running' }),
      draft(4, { refId: 'a', status: 'running', hold: 'question', attention: 'question' }),
      draft(5, { refId: 'a', status: 'completed', settled: true }),
      draft(6, { refId: 'b', status: 'running' }),
    ])
    journal.flush()
    clock += 2 * 24 * 3600_000
    const deleted = store.compact({ maxAgeMs: 7 * 24 * 3600_000, maxRows: 1000, compactAfterMs: 24 * 3600_000 }, clock)
    expect(deleted).toBe(3) // the 8-day-old row, a:queued, a:running
    expect(journal.read(0, {}, 50).events.map((e) => `${e.refId}:${e.status}:${e.hold ?? ''}`)).toEqual(['a:running:question', 'a:completed:', 'b:running:'])
    expect(store.compact({ maxAgeMs: 30 * 24 * 3600_000, maxRows: 2, compactAfterMs: 24 * 3600_000 }, clock)).toBe(1)
    expect(journal.bounds()).toEqual({ head: 6, oldest: 5 })
    // seq never goes back after deletions.
    journal.record([draft(7, { refId: 'c' })])
    journal.flush()
    expect(journal.bounds().head).toBe(7)
  })

  it('survives a closed database without throwing into the broadcast loop', () => {
    const { db, journal } = setup()
    db.close()
    expect(() => { journal.ingest(started('j1')); journal.flush() }).not.toThrow()
  })

  it('shares one journal per database through the runtime registry', () => {
    const db = new Database(':memory:')
    open.push(db)
    const bus = new MobileEventBus()
    const journal = eventJournalFor(db, bus)
    expect(eventJournalFor(db)).toBe(journal)
    bus.publish(started('j1') as never)
    expect(journal.read(0, {}, 5).events).toHaveLength(1)
    stopEventJournal(db)
    bus.publish(started('j2') as never)
    expect(eventJournalFor(db).read(0, {}, 5).events).toHaveLength(1)
    stopEventJournal(db)
  })

  it('stays cheap at 100 projects and 10k runs (200k rows)', () => {
    const { db, journal } = setup()
    const store = createSqliteJournalStore(db)
    const t0 = performance.now()
    for (let batch = 0; batch < 20; batch++) {
      journal.record(Array.from({ length: 10_000 }, (_, i) => draft(batch * 10_000 + i, { refId: `r${(batch * 10_000 + i) % 10_000}`, status: `s${batch}` })))
      journal.flush()
    }
    const ingestMs = performance.now() - t0
    const head = journal.bounds().head
    expect(head).toBe(200_000)

    const time = (fn: () => unknown) => { const s = performance.now(); fn(); return performance.now() - s }
    const reads = {
      refsAfterCursor: time(() => journal.read(head - 50_000, { refs: [{ kind: 'run', id: 'r42' }, { kind: 'run', id: 'r4242' }], match: 'settled' }, 8)),
      projectTail: time(() => journal.tail({ projectId: 'p42' }, 25)),
      attentionAfterCursor: time(() => journal.read(head - 1_000, { match: 'attention' }, 25)),
      attentionTail: time(() => journal.tail({ match: 'attention' }, 25)),
      latestOf20: time(() => journal.latest(Array.from({ length: 20 }, (_, i) => ({ kind: 'run', id: `r${i * 13}` })))),
    }
    const compactMs = time(() => store.compact({ maxAgeMs: 7 * 24 * 3600_000, maxRows: 200_000, compactAfterMs: -1 }, Date.now()))
    console.log(`[events-journal] ingest 200k rows ${ingestMs.toFixed(0)} ms; reads (ms) ${JSON.stringify(Object.fromEntries(Object.entries(reads).map(([k, v]) => [k, Number(v.toFixed(2))])))}; compaction ${compactMs.toFixed(0)} ms`)
    for (const ms of Object.values(reads)) expect(ms).toBeLessThan(50)
    // Compaction leaves the latest row of each of the 10k refs plus the attention rows.
    const left = (db.prepare('SELECT COUNT(*) AS n FROM events_journal').get() as { n: number }).n
    expect(left).toBeLessThan(60_000)
  }, 60_000)
})
