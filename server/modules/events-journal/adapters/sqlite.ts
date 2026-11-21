import { randomBytes } from 'crypto'
import type { DbInstance } from '../../../db/types'
import { refKey, type Attention, type JournalData, type JournalEvent, type JournalRefKind } from '../domain'
import type { AppendRow, JournalFilter, JournalStore } from '../ports'

/**
 * The journal table lives in the app-level database (`desktop.sqlite`) next to
 * the project registry: one append-only table for every project, keyed by a
 * monotonic `seq` (AUTOINCREMENT, so a deleted seq is never reused and a cursor
 * stays meaningful across restarts and compaction). The schema is owned here
 * and created idempotently on first use.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events_journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    project_id TEXT,
    ref_kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    prev_status TEXT,
    hold TEXT,
    attention TEXT,
    settled INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    detail TEXT,
    data TEXT,
    source TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_journal_ref ON events_journal(ref_kind, ref_id, seq);
  CREATE INDEX IF NOT EXISTS events_journal_project ON events_journal(project_id, seq);
  CREATE INDEX IF NOT EXISTS events_journal_attention ON events_journal(seq) WHERE attention IS NOT NULL;
  CREATE TABLE IF NOT EXISTS events_journal_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

/** Refs per query; a wait names a handful. */
export const MAX_FILTER_REFS = 50

interface StoredRow {
  seq: number
  at: string
  project_id: string | null
  ref_kind: string
  ref_id: string
  kind: string
  status: string
  prev_status: string | null
  hold: string | null
  attention: string | null
  settled: number
  title: string | null
  detail: string | null
  data: string | null
  source: string
}

function parseData(text: string | null): JournalData | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' ? value as JournalData : null
  } catch {
    return null
  }
}

function toEvent(row: StoredRow): JournalEvent {
  return {
    seq: row.seq, at: row.at, projectId: row.project_id,
    refKind: row.ref_kind as JournalRefKind, refId: row.ref_id, kind: row.kind,
    status: row.status, prevStatus: row.prev_status, hold: row.hold, attention: row.attention as Attention | null,
    settled: row.settled === 1, title: row.title, detail: row.detail, data: parseData(row.data), source: row.source,
  }
}

/** SQL for a filter (parameterized). */
export function filterSql(filter: JournalFilter): { where: string; params: unknown[] } {
  const params: unknown[] = []
  const clauses: string[] = []
  if (filter.projectId) { clauses.push('project_id = ?'); params.push(filter.projectId) }
  const own: string[] = []
  const refs = (filter.refs ?? []).slice(0, MAX_FILTER_REFS)
  if (refs.length) {
    own.push(`(${refs.map(() => '(ref_kind = ? AND ref_id = ?)').join(' OR ')})`)
    for (const ref of refs) params.push(ref.kind, ref.id)
  }
  if (filter.match === 'settled') own.push('(settled = 1 OR attention IS NOT NULL)')
  if (filter.match === 'attention') own.push('attention IS NOT NULL')
  const ownSql = own.length ? own.join(' AND ') : '1'
  clauses.push(filter.alsoAttention ? `((${ownSql}) OR attention IS NOT NULL)` : `(${ownSql})`)
  return { where: clauses.join(' AND '), params }
}

export function createSqliteJournalStore(db: DbInstance): JournalStore {
  db.exec(SCHEMA)
  const insert = db.prepare(`
    INSERT INTO events_journal (at, project_id, ref_kind, ref_id, kind, status, prev_status, hold, attention, settled, title, detail, data, source)
    VALUES (@at, @projectId, @refKind, @refId, @kind, @status, @prevStatus, @hold, @attention, @settled, @title, @detail, @data, @source)
  `)
  const latestOfRef = db.prepare('SELECT * FROM events_journal WHERE ref_kind = ? AND ref_id = ? ORDER BY seq DESC LIMIT 1')
  const head = db.prepare('SELECT MAX(seq) AS seq FROM events_journal')
  const oldest = db.prepare('SELECT MIN(seq) AS seq FROM events_journal')
  const getMeta = db.prepare('SELECT value FROM events_journal_meta WHERE key = ?')
  const setMeta = db.prepare('INSERT INTO events_journal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  const firstAtOrAfter = db.prepare('SELECT seq FROM events_journal WHERE at >= ? ORDER BY seq ASC LIMIT 1')
  const nthNewest = db.prepare('SELECT seq FROM events_journal ORDER BY seq DESC LIMIT 1 OFFSET ?')
  const deleteThrough = db.prepare('DELETE FROM events_journal WHERE seq <= ?')
  const compactRange = db.prepare(`
    DELETE FROM events_journal
    WHERE seq > ? AND seq < ? AND attention IS NULL
      AND EXISTS (SELECT 1 FROM events_journal later
                  WHERE later.ref_kind = events_journal.ref_kind AND later.ref_id = events_journal.ref_id AND later.seq > events_journal.seq)
  `)

  const appendTx = db.transaction((rows: readonly AppendRow[]): JournalEvent[] => rows.map((row) => {
    const info = insert.run({
      at: row.at, projectId: row.projectId, refKind: row.refKind, refId: row.refId, kind: row.kind, status: row.status,
      prevStatus: row.prevStatus, hold: row.hold, attention: row.attention, settled: row.settled ? 1 : 0,
      title: row.title, detail: row.detail, data: row.data ? JSON.stringify(row.data) : null, source: row.source,
    })
    return { ...row, seq: Number(info.lastInsertRowid) }
  }))

  let epochValue: string | null = null

  return {
    append: (rows) => rows.length ? appendTx(rows) : [],

    read(afterSeq, filter, limit) {
      const { where, params } = filterSql(filter)
      const rows = db.prepare(`SELECT * FROM events_journal WHERE seq > ? AND ${where} ORDER BY seq ASC LIMIT ?`).all(afterSeq, ...params, limit) as StoredRow[]
      return rows.map(toEvent)
    },

    tail(filter, limit) {
      const { where, params } = filterSql(filter)
      const rows = db.prepare(`SELECT * FROM events_journal WHERE ${where} ORDER BY seq DESC LIMIT ?`).all(...params, limit) as StoredRow[]
      return rows.reverse().map(toEvent)
    },

    latest(refs) {
      const found = new Map<string, JournalEvent>()
      for (const ref of refs.slice(0, MAX_FILTER_REFS)) {
        const row = latestOfRef.get(ref.kind, ref.id) as StoredRow | undefined
        if (row) found.set(refKey(ref.kind, ref.id), toEvent(row))
      }
      return found
    },

    bounds() {
      const top = (head.get() as { seq: number | null }).seq ?? 0
      const low = (oldest.get() as { seq: number | null }).seq ?? 0
      // An empty table keeps the AUTOINCREMENT high-water mark as its head.
      if (!top) {
        const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events_journal'").get() as { seq: number } | undefined
        return { head: seqRow?.seq ?? 0, oldest: 0 }
      }
      return { head: top, oldest: low }
    },

    epoch() {
      if (epochValue) return epochValue
      const row = getMeta.get('epoch') as { value: string } | undefined
      if (row) return (epochValue = row.value)
      const minted = randomBytes(6).toString('hex')
      setMeta.run('epoch', minted)
      return (epochValue = minted)
    },

    compact(policy, nowMs) {
      return db.transaction(() => {
        let deleted = 0
        // 1. Age: everything before the first row young enough to keep (rows are appended in time order).
        const keepAge = firstAtOrAfter.get(new Date(nowMs - policy.maxAgeMs).toISOString()) as { seq: number } | undefined
        if (keepAge) deleted += deleteThrough.run(keepAge.seq - 1).changes
        else deleted += deleteThrough.run(Number.MAX_SAFE_INTEGER).changes
        // 2. Row cap: the oldest beyond `maxRows`.
        const cut = nthNewest.get(policy.maxRows) as { seq: number } | undefined
        if (cut) deleted += deleteThrough.run(cut.seq).changes
        // 3. Compaction: intermediate rows (superseded, nobody had to act) older than compactAfterMs.
        const from = Number((getMeta.get('compacted_through') as { value: string } | undefined)?.value ?? 0)
        const young = firstAtOrAfter.get(new Date(nowMs - policy.compactAfterMs).toISOString()) as { seq: number } | undefined
        const until = young?.seq ?? (((head.get() as { seq: number | null }).seq ?? 0) + 1)
        if (until - 1 > from) {
          deleted += compactRange.run(from, until).changes
          setMeta.run('compacted_through', String(until - 1))
        }
        return deleted
      }).immediate()
    },
  }
}
