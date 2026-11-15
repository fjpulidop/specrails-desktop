import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { applyMigrations } from '../../../db/migrations'
import { initDb } from '../../../db'
import type { DbInstance } from '../../../db'
import { createMissionResourceHistoryStore, createMissionResourceRecorder, type MissionResourceHistoryStore } from './mission-resource-history'

let db: DbInstance
let store: MissionResourceHistoryStore
const sample = (at: number, procs = 1) => ({ at, cpuPercent: at / 10, memoryBytes: at * 100, processCount: procs })

beforeEach(() => {
  db = initDb(':memory:')
  db.prepare("INSERT INTO chat_conversations (id) VALUES ('c1'), ('c2')").run()
  store = createMissionResourceHistoryStore(db, 5)
})

afterEach(() => { db.close() })

describe('mission resource history store', () => {
  it('[spec:mission-resources/server-recording-persists-bounded-mission-history] appends, lists oldest first and returns the last sample', () => {
    store.append('c1', sample(2)); store.append('c1', sample(1)); store.append('c2', sample(9))
    expect(store.list('c1').map((s) => s.at)).toEqual([1, 2])
    expect(store.last('c1')?.at).toBe(2)
    expect(store.last('nobody')).toBeNull()
    expect(store.list('c1', 1).map((s) => s.at)).toEqual([2])
  })

  it('[spec:mission-resources/server-recording-persists-bounded-mission-history] keeps only the newest samples per conversation and leaves others alone', () => {
    for (let at = 1; at <= 8; at++) store.append('c1', sample(at))
    store.append('c2', sample(1))
    expect(store.list('c1').map((s) => s.at)).toEqual([4, 5, 6, 7, 8])
    expect(store.list('c2')).toHaveLength(1)
  })

  it('[spec:mission-resources/server-recording-persists-bounded-mission-history] upgrades migration 89 without losing samples and persists desktop missions across reopening', () => {
    const dir = mkdtempSync(path.join(process.cwd(), '.resource-history-test-'))
    const file = path.join(dir, 'project.sqlite')
    let persisted = initDb(file)
    try {
      // Recreate the v89 table and marker, as installed before the fix.
      persisted.exec(`
        DROP TRIGGER mission_resource_samples_chat_delete;
        DROP TABLE mission_resource_samples;
        CREATE TABLE mission_resource_samples (
          conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
          at INTEGER NOT NULL, cpu_percent REAL NOT NULL,
          memory_bytes INTEGER NOT NULL, process_count INTEGER NOT NULL,
          PRIMARY KEY (conversation_id, at)
        ) WITHOUT ROWID;
        DELETE FROM schema_migrations WHERE version = 90;
        INSERT INTO chat_conversations (id) VALUES ('legacy');
        INSERT INTO mission_resource_samples VALUES ('legacy', 1000, 5, 100, 1);
      `)
      applyMigrations(persisted)
      const upgraded = createMissionResourceHistoryStore(persisted)
      expect(upgraded.list('legacy')).toEqual([{ at: 1000, cpuPercent: 5, memoryBytes: 100, processCount: 1 }])
      upgraded.append('desktop-mission', sample(2000))
      persisted.close()
      persisted = initDb(file)
      const reopened = createMissionResourceHistoryStore(persisted)
      expect(reopened.list('desktop-mission')).toEqual([sample(2000)])
      persisted.prepare("DELETE FROM chat_conversations WHERE id = 'legacy'").run()
      expect(reopened.list('legacy')).toEqual([])
      expect(persisted.pragma('foreign_key_check')).toEqual([])
    } finally {
      persisted.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('[spec:mission-resources/resource-history-follows-permanent-mission-deletion] deletes only the requested mission, idempotently', () => {
    store.append('c1', sample(1)); store.append('c2', sample(2))
    store.delete('c1'); store.delete('c1')
    expect(store.list('c1')).toEqual([])
    expect(store.list('c2')).toEqual([sample(2)])
  })

  it('[spec:mission-resources/resource-history-follows-permanent-mission-deletion] prunes missing conversations and preserves all samples if existence lookup fails', () => {
    store.append('c1', sample(1)); store.append('c2', sample(2))
    expect(() => store.prune(id => {
      if (id === 'c2') throw new Error('desktop unavailable')
      return false
    })).toThrow('desktop unavailable')
    expect(store.list('c1')).toHaveLength(1)
    store.prune(id => id === 'c2')
    expect(store.list('c1')).toEqual([])
    expect(store.list('c2')).toEqual([sample(2)])
  })

  it('[spec:mission-resources/server-recording-persists-bounded-mission-history] replaces a sample taken at the same instant', () => {
    store.append('c1', sample(1)); store.append('c1', { ...sample(1), processCount: 4 })
    expect(store.list('c1')).toHaveLength(1)
    expect(store.last('c1')?.processCount).toBe(4)
  })

  it('[spec:mission-resources/resource-history-follows-permanent-mission-deletion] drops a project chat history with the chat and accepts desktop mission IDs', () => {
    store.append('c1', sample(1))
    db.prepare("DELETE FROM chat_conversations WHERE id = 'c1'").run()
    expect(store.list('c1')).toEqual([])
    store.append('desktop-mission', sample(1))
    expect(store.list('desktop-mission')).toEqual([sample(1)])
  })
})

describe('mission resource recorder', () => {
  const totals = (processCount: number) => ({ cpuPercent: processCount * 2, memoryBytes: processCount * 1000, processCount })

  function setup(measured: Array<ReturnType<typeof totals> | null>, active: string[][]) {
    let clock = 0
    let n = 0
    const measure = vi.fn(async () => measured[Math.min(n++, measured.length - 1)])
    let tickNo = 0
    const recorder = createMissionResourceRecorder({
      store, measure, now: () => (clock += 3000), onError: () => {},
      listActiveConversations: () => active[Math.min(tickNo++, active.length - 1)],
    })
    return { recorder, measure }
  }

  it('[spec:mission-resources/server-recording-persists-bounded-mission-history] records while active, then one closing zero after the turn ends, then nothing', async () => {
    const { recorder, measure } = setup([totals(3), totals(2), totals(0), totals(0)], [['c1'], [], [], []])
    await recorder.tick(); await recorder.tick(); await recorder.tick(); await recorder.tick()
    expect(store.list('c1').map((s) => s.processCount)).toEqual([3, 2, 0])
    expect(measure).toHaveBeenCalledTimes(3) // idle once it settled at zero
  })

  it('[spec:mission-resources/server-recording-persists-bounded-mission-history] records nothing for an active conversation that owns no process', async () => {
    const { recorder } = setup([totals(0)], [['c1']])
    await recorder.tick()
    expect(store.list('c1')).toEqual([])
  })

  it('[spec:mission-resources/recorder-lifecycle-prevents-stale-writes] skips ticks that overlap, survives a failing conversation and metering being unavailable', async () => {
    let release: (t: ReturnType<typeof totals>) => void = () => {}
    const measure = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(null)
      .mockResolvedValue(totals(1))
    const onError = vi.fn()
    const recorder = createMissionResourceRecorder({ store, measure, now: () => 5000, onError, listActiveConversations: () => ['c1'] })
    const first = recorder.tick()
    await recorder.tick() // overlaps: ignored
    expect(measure).toHaveBeenCalledTimes(1)
    release(totals(1)); await first
    await recorder.tick() // throws -> reported, not fatal
    expect(onError).toHaveBeenCalledTimes(1)
    await recorder.tick() // metering unavailable -> nothing recorded
    expect(store.list('c1')).toHaveLength(1)
  })

  it('[spec:mission-resources/recorder-lifecycle-prevents-stale-writes] does not touch the store when stopped during an in-flight measurement', async () => {
    let release!: (value: ReturnType<typeof totals>) => void
    const pending = new Promise<ReturnType<typeof totals>>((resolve) => { release = resolve })
    const last = vi.spyOn(store, 'last')
    const append = vi.spyOn(store, 'append')
    const recorder = createMissionResourceRecorder({ store, measure: () => pending, listActiveConversations: () => ['c1'] })
    const tick = recorder.tick()
    recorder.stop()
    release(totals(1))
    await tick
    expect(last).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })

  it('[spec:mission-resources/recorder-lifecycle-prevents-stale-writes] does not recreate history when permanently deleted during measurement or draining', async () => {
    store.append('c1', sample(1))
    let exists = true
    let release!: (value: ReturnType<typeof totals>) => void
    const measure = vi.fn().mockResolvedValueOnce(totals(1))
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const recorder = createMissionResourceRecorder({
      store, measure, listActiveConversations: () => ['c1'], conversationExists: () => exists,
    })
    await recorder.tick() // starts draining
    const pending = recorder.tick()
    exists = false
    store.delete('c1')
    release(totals(1))
    await pending
    expect(store.list('c1')).toEqual([])
  })

  it('[spec:mission-resources/recorder-lifecycle-prevents-stale-writes] starts and stops its timer idempotently', () => {
    vi.useFakeTimers()
    try {
      const measure = vi.fn(async () => totals(1))
      const recorder = createMissionResourceRecorder({ store, measure, intervalMs: 1000, now: () => 1, listActiveConversations: () => ['c1'] })
      recorder.start(); recorder.start()
      vi.advanceTimersByTime(3000)
      expect(measure.mock.calls.length).toBeGreaterThanOrEqual(1)
      recorder.stop(); recorder.stop()
      const calls = measure.mock.calls.length
      vi.advanceTimersByTime(5000)
      expect(measure.mock.calls.length).toBe(calls)
    } finally { vi.useRealTimers() }
  })
})
