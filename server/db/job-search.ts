// Job-log search index (CD6, migration 86): an FTS5 trigram index over what a
// person remembers about a run, NOT its raw token stream.
//
//   - field `command`  the job's command line
//   - field `loop`     the loop's name (loop runs share their job's id)
//   - field `phase`    phase / step titles the run went through
//   - field `failure`  the failure kind of a failed / blocked / stalled run
//   - field `detail`   the diagnosis' one-sentence detail and host-blocker text
//
// Layout: `job_search_docs` is the ordinary table (indexed by job_id so a
// re-index is a cheap delete + insert); `job_search_fts` is an external-content
// FTS5 table over it, kept in sync by triggers. Everything lives in the
// project's own database, so projects never see each other's runs.
//
// Population is incremental (`indexJob` at create/settle, `indexJobPhase` per
// phase event) and `rebuildJobSearchIndex` is the idempotent backfill the
// migration runs. Indexing is best-effort: a failure here must never fail a
// settle, so every hook goes through `safeIndexJob`.
import type { DbInstance } from './types'
import {
  FALLBACK_SCAN_ROWS, MARK_END, MARK_START, TRIGRAM_MIN_CHARS,
  ftsPhrase, parseMarkedSnippet, windowMarked, type SearchSnippet,
} from '../util/search-snippet'

export type JobSearchField = 'command' | 'loop' | 'phase' | 'failure' | 'detail'

/** Longest text kept per document. */
export const JOB_SEARCH_MAX_TEXT = 300
/** Phase documents kept per job. */
export const JOB_SEARCH_MAX_PHASES = 30
/** Documents kept per project; beyond it the oldest tenth is dropped. */
export const JOB_SEARCH_MAX_DOCS = 30_000
/** Jobs the backfill indexes (newest first). */
export const JOB_SEARCH_BACKFILL_JOBS = 5_000
export const JOB_SEARCH_DEFAULT_LIMIT = 8
export const JOB_SEARCH_MAX_LIMIT = 30

export function createJobSearchSchema(db: DbInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_search_docs (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      field  TEXT NOT NULL,
      text   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_search_docs_job ON job_search_docs(job_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS job_search_fts USING fts5(
      text,
      content='job_search_docs',
      content_rowid='id',
      tokenize='trigram remove_diacritics 1'
    );
    CREATE TRIGGER IF NOT EXISTS job_search_docs_ai AFTER INSERT ON job_search_docs BEGIN
      INSERT INTO job_search_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS job_search_docs_ad AFTER DELETE ON job_search_docs BEGIN
      INSERT INTO job_search_fts(job_search_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS job_search_docs_au AFTER UPDATE ON job_search_docs BEGIN
      INSERT INTO job_search_fts(job_search_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO job_search_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `)
}

function clip(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > JOB_SEARCH_MAX_TEXT ? `${flat.slice(0, JOB_SEARCH_MAX_TEXT - 1)}…` : flat
}

function diagnosisDocs(raw: unknown): Array<[JobSearchField, string]> {
  if (typeof raw !== 'string' || !raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!parsed || typeof parsed !== 'object') return []
  const d = parsed as Record<string, unknown>
  const docs: Array<[JobSearchField, string]> = []
  const kind = clip(typeof d.kind === 'string' ? d.kind.replace(/_/g, ' ') : null)
  if (kind) docs.push(['failure', kind])
  const phase = clip(d.phase)
  if (phase) docs.push(['phase', phase])
  const detail = clip(d.detail)
  if (detail) docs.push(['detail', detail])
  const blocker = d.blocker
  if (blocker && typeof blocker === 'object') {
    const b = blocker as Record<string, unknown>
    const reason = clip(b.reason)
    if (reason) docs.push(['detail', reason])
    const action = clip(b.requiredAction)
    if (action) docs.push(['detail', action])
  }
  return docs
}

function collectDocs(db: DbInstance, jobId: string): Array<[JobSearchField, string]> | null {
  const job = db.prepare('SELECT command FROM jobs WHERE id = ?').get(jobId) as { command: string } | undefined
  if (!job) return null
  const docs: Array<[JobSearchField, string]> = []
  const command = clip(job.command)
  if (command) docs.push(['command', command])
  const run = db.prepare('SELECT loop_name, failure_diagnosis FROM loop_runs WHERE id = ?').get(jobId) as
    | { loop_name: string | null; failure_diagnosis: string | null } | undefined
  const loop = clip(run?.loop_name)
  if (loop) docs.push(['loop', loop])
  const seen = new Set<string>()
  const phases = db.prepare('SELECT phase FROM job_phases WHERE job_id = ? ORDER BY updated_at LIMIT ?').all(jobId, JOB_SEARCH_MAX_PHASES) as Array<{ phase: string }>
  for (const { phase } of phases) {
    const text = clip(phase)
    if (text && !seen.has(text)) { seen.add(text); docs.push(['phase', text]) }
  }
  for (const doc of diagnosisDocs(run?.failure_diagnosis)) {
    if (doc[0] === 'phase') {
      if (seen.has(doc[1])) continue
      seen.add(doc[1])
    }
    docs.push(doc)
  }
  return docs
}

/** Drop the oldest tenth when the project is over budget; forget deleted jobs. */
export function pruneJobSearch(db: DbInstance): void {
  db.prepare('DELETE FROM job_search_docs WHERE job_id NOT IN (SELECT id FROM jobs)').run()
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM job_search_docs').get() as { n: number }
  if (n <= JOB_SEARCH_MAX_DOCS) return
  const drop = Math.ceil(JOB_SEARCH_MAX_DOCS / 10)
  db.prepare('DELETE FROM job_search_docs WHERE id IN (SELECT id FROM job_search_docs ORDER BY id LIMIT ?)').run(drop)
}

/** Replace every document of one job with what the database knows now. Idempotent. */
export function indexJob(db: DbInstance, jobId: string, opts: { prune?: boolean } = {}): void {
  const docs = collectDocs(db, jobId)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM job_search_docs WHERE job_id = ?').run(jobId)
    if (docs) {
      const insert = db.prepare('INSERT INTO job_search_docs (job_id, field, text) VALUES (?, ?, ?)')
      for (const [field, text] of docs) insert.run(jobId, field, text)
    }
    if (opts.prune !== false) pruneJobSearch(db)
  })
  tx()
}

/** Add one phase title (a phase event) without rebuilding the job's documents. */
export function indexJobPhase(db: DbInstance, jobId: string, phase: string): void {
  const text = clip(phase)
  if (!text) return
  const existing = db.prepare("SELECT COUNT(*) AS n, SUM(text = ?) AS same FROM job_search_docs WHERE job_id = ? AND field = 'phase'").get(text, jobId) as { n: number; same: number | null }
  if ((existing.same ?? 0) > 0 || existing.n >= JOB_SEARCH_MAX_PHASES) return
  db.prepare("INSERT INTO job_search_docs (job_id, field, text) VALUES (?, 'phase', ?)").run(jobId, text)
}

/** Best-effort hook: indexing never fails the write that triggered it. */
export function safeIndexJob(db: DbInstance, jobId: string): void {
  try { indexJob(db, jobId) } catch { /* index is derived data; the backfill repairs it */ }
}

export function safeIndexJobPhase(db: DbInstance, jobId: string, phase: string): void {
  try { indexJobPhase(db, jobId, phase) } catch { /* see safeIndexJob */ }
}

/** Forget the documents of jobs about to be deleted. */
export function safeRemoveJobSearch(db: DbInstance, where: { jobId: string } | { selectIds: string; params: unknown[] }): void {
  try {
    if ('jobId' in where) db.prepare('DELETE FROM job_search_docs WHERE job_id = ?').run(where.jobId)
    else db.prepare(`DELETE FROM job_search_docs WHERE job_id IN (${where.selectIds})`).run(...where.params)
  } catch { /* table absent on a hand-built database */ }
}

/** One-time (re-runnable) backfill: rebuild the whole index from jobs, phases and loop runs. */
export function rebuildJobSearchIndex(db: DbInstance): number {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM job_search_docs').run()
    const ids = db.prepare('SELECT id FROM jobs ORDER BY started_at DESC LIMIT ?').all(JOB_SEARCH_BACKFILL_JOBS) as Array<{ id: string }>
    for (const { id } of ids) indexJob(db, id, { prune: false })
    return ids.length
  })
  return tx() as number
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface JobSearchHit {
  jobId: string
  command: string
  status: string
  startedAt: string
  /** Which field matched best. */
  field: JobSearchField
  snippet: SearchSnippet
}

interface HitRow {
  job_id: string
  field: JobSearchField
  marked: string
  command: string
  status: string
  started_at: string
}

export function searchJobs(db: DbInstance, rawQuery: string, limit = JOB_SEARCH_DEFAULT_LIMIT): JobSearchHit[] {
  const query = rawQuery.trim()
  if (!query) return []
  const cap = Math.max(1, Math.min(JOB_SEARCH_MAX_LIMIT, Math.floor(limit)))
  let rows: HitRow[]
  if ([...query].length >= TRIGRAM_MIN_CHARS) {
    rows = db.prepare(
      `WITH hits AS (
         SELECT d.job_id AS job_id, d.field AS field,
                bm25(job_search_fts) AS rank,
                highlight(job_search_fts, 0, ?, ?) AS marked
         FROM job_search_fts JOIN job_search_docs d ON d.id = job_search_fts.rowid
         WHERE job_search_fts MATCH ?
       ),
       ranked AS (
         SELECT job_id, field, rank, marked,
                row_number() OVER (PARTITION BY job_id ORDER BY rank, field) AS rn
         FROM hits
       )
       SELECT r.job_id, r.field, r.marked, j.command, j.status, j.started_at
       FROM ranked r JOIN jobs j ON j.id = r.job_id
       WHERE r.rn = 1
       ORDER BY r.rank, j.started_at DESC
       LIMIT ?`,
    ).all(MARK_START, MARK_END, ftsPhrase(query), cap) as HitRow[]
  } else {
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`)
    const scan = db.prepare(
      `SELECT d.job_id AS job_id, d.field AS field, d.text AS text, j.command, j.status, j.started_at
       FROM job_search_docs d JOIN jobs j ON j.id = d.job_id
       WHERE d.text LIKE ? ESCAPE '\\'
       ORDER BY d.id DESC LIMIT ?`,
    ).all(`%${escaped}%`, FALLBACK_SCAN_ROWS) as Array<Omit<HitRow, 'marked'> & { text: string }>
    const needle = query.toLowerCase()
    const seen = new Set<string>()
    rows = []
    for (const row of scan) {
      if (seen.has(row.job_id)) continue
      seen.add(row.job_id)
      const at = row.text.toLowerCase().indexOf(needle)
      const marked = at < 0
        ? row.text
        : row.text.slice(0, at) + MARK_START + row.text.slice(at, at + needle.length) + MARK_END + row.text.slice(at + needle.length)
      rows.push({ ...row, marked })
      if (rows.length >= cap) break
    }
  }
  return rows.map((r) => ({
    jobId: r.job_id,
    command: r.command,
    status: r.status,
    startedAt: r.started_at,
    field: r.field,
    snippet: parseMarkedSnippet(windowMarked(r.marked)),
  }))
}
