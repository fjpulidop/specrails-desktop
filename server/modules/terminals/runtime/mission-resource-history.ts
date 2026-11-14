import type { DbInstance } from '../../../db'
import { shouldRecordSample, type MissionResourceSample, type MissionResourceTotals } from '../domain/mission-resources'

/** Newest samples kept per mission: 30 minutes at the 3 s cadence is plenty for the popover chart. */
export const MISSION_RESOURCE_HISTORY_MAX = 600
export const MISSION_RESOURCE_SAMPLE_MS = 3000

interface SampleRow { at: number; cpu_percent: number; memory_bytes: number; process_count: number }

export interface MissionResourceHistoryStore {
  append(conversationId: string, sample: MissionResourceSample): void
  delete(conversationId: string): void
  /** Remove only IDs absent from both conversation stores, including their trash. */
  prune(conversationExists: (conversationId: string) => boolean): void
  /** Oldest first, at most `limit` newest rows. */
  list(conversationId: string, limit?: number): MissionResourceSample[]
  last(conversationId: string): MissionResourceSample | null
}

/** SQLite history in the project's own database (table `mission_resource_samples`, migrations 89–90). */
export function createMissionResourceHistoryStore(db: DbInstance, maxPerConversation = MISSION_RESOURCE_HISTORY_MAX): MissionResourceHistoryStore {
  const insert = db.prepare('INSERT OR REPLACE INTO mission_resource_samples (conversation_id, at, cpu_percent, memory_bytes, process_count) VALUES (?, ?, ?, ?, ?)')
  const trim = db.prepare(`DELETE FROM mission_resource_samples WHERE conversation_id = ? AND at <= (
    SELECT at FROM mission_resource_samples WHERE conversation_id = ? ORDER BY at DESC LIMIT 1 OFFSET ?)`)
  const newest = db.prepare('SELECT at, cpu_percent, memory_bytes, process_count FROM mission_resource_samples WHERE conversation_id = ? ORDER BY at DESC LIMIT ?')
  const toSample = (row: SampleRow): MissionResourceSample => ({ at: row.at, cpuPercent: row.cpu_percent, memoryBytes: row.memory_bytes, processCount: row.process_count })

  const remove = db.prepare('DELETE FROM mission_resource_samples WHERE conversation_id = ?')
  const conversations = db.prepare('SELECT DISTINCT conversation_id FROM mission_resource_samples')

  return {
    delete(conversationId) { remove.run(conversationId) },
    prune(conversationExists) {
      // Resolve existence before writing: a failed desktop read must not delete history.
      const orphanIds = (conversations.all() as Array<{ conversation_id: string }>)
        .map(row => row.conversation_id).filter(id => !conversationExists(id))
      db.transaction(() => { for (const id of orphanIds) remove.run(id) })()
    },
    append(conversationId, sample) {
      db.transaction(() => {
        insert.run(conversationId, sample.at, sample.cpuPercent, sample.memoryBytes, sample.processCount)
        trim.run(conversationId, conversationId, maxPerConversation)
      })()
    },
    list(conversationId, limit = maxPerConversation) {
      return (newest.all(conversationId, Math.max(1, Math.floor(limit))) as SampleRow[]).reverse().map(toSample)
    },
    last(conversationId) {
      const row = newest.get(conversationId, 1) as SampleRow | undefined
      return row ? toSample(row) : null
    },
  }
}

export interface MissionResourceRecorderDeps {
  store: MissionResourceHistoryStore
  /** Conversations that may be working right now (live turn). Must only return this project's conversations. */
  listActiveConversations: () => string[]
  /** Totals for a conversation, or null when metering is unavailable. Called once per conversation per tick. */
  measure: (conversationId: string) => Promise<MissionResourceTotals | null>
  /** Rechecked after asynchronous measurement to prevent resurrecting deleted history. */
  conversationExists?: (conversationId: string) => boolean
  intervalMs?: number
  now?: () => number
  onError?: (error: unknown) => void
}

/**
 * Samples every working mission on a fixed cadence and persists the history. A conversation stays watched
 * after its turn ends until its processes drop to zero, so the closing point is recorded. Timer-only: no
 * work happens when nothing is active, ticks never overlap, and `stop()` is idempotent.
 */
export function createMissionResourceRecorder(deps: MissionResourceRecorderDeps) {
  const intervalMs = deps.intervalMs ?? MISSION_RESOURCE_SAMPLE_MS
  const now = deps.now ?? Date.now
  const onError = deps.onError ?? ((error: unknown) => console.warn('[mission-resources] sample failed:', error))
  const draining = new Set<string>()
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let stopped = false

  async function tick(): Promise<void> {
    if (running || stopped) return
    running = true
    try {
      const targets = new Set([...deps.listActiveConversations(), ...draining])
      for (const conversationId of targets) {
        try {
          const totals = await deps.measure(conversationId)
          if (stopped) return // The project may already have closed its database.
          if (deps.conversationExists && !deps.conversationExists(conversationId)) { draining.delete(conversationId); continue }
          if (!totals) { draining.delete(conversationId); continue }
          const last = deps.store.last(conversationId)
          if (shouldRecordSample(last, totals)) {
            deps.store.append(conversationId, { at: now(), cpuPercent: totals.cpuPercent, memoryBytes: totals.memoryBytes, processCount: totals.processCount })
          }
          if (totals.processCount > 0) draining.add(conversationId)
          else draining.delete(conversationId)
        } catch (error) {
          draining.delete(conversationId)
          onError(error)
        }
      }
    } finally {
      running = false
    }
  }

  return {
    tick,
    start() {
      if (timer) return
      stopped = false
      timer = setInterval(() => { void tick() }, intervalMs)
      timer.unref?.()
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      draining.clear()
    },
  }
}
