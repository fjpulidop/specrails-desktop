import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { secureDbFile, secureDir } from './util/secure-fs'
import type { BackgroundProcess, BackgroundProcessLogLine, BackgroundProcessLogSnapshot } from './transient-children'

export const BACKGROUND_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const BACKGROUND_HISTORY_MAX_LINES = 10_000
export const BACKGROUND_HISTORY_MAX_LINE_CHARS = 4000
export interface BackgroundHistoryPolicy { retentionMs: number; maxFinishedRuns: number; maxLines: number; maxTextBytes: number }
const defaultPolicy: BackgroundHistoryPolicy = { retentionMs: BACKGROUND_HISTORY_RETENTION_MS, maxFinishedRuns: 1000, maxLines: BACKGROUND_HISTORY_MAX_LINES, maxTextBytes: 256 * 1024 * 1024 }
interface ProcessRow { process_id: string; metadata: string; next_sequence: number; clipped: number; line_count: number; text_bytes: number }
export interface BackgroundProcessWrite { process: BackgroundProcess; nextSequence: number; clipped: boolean; lines: readonly BackgroundProcessLogLine[] }
const activeStatuses = "('starting','running','stopping')"

/** Log volume stays in its own SQLite file so batched writes cannot hold the
 * mission/conversation database lock. Only execution UUIDs identify history;
 * opening this store never probes, adopts or signals an old operating-system PID. */
export class BackgroundProcessStore {
  readonly db: Database.Database
  readonly policy: BackgroundHistoryPolicy
  private lastPrune = 0
  private ownerToken = randomUUID()

  constructor(readonly file: string, policy: Partial<BackgroundHistoryPolicy> = {}) {
    this.policy = { ...defaultPolicy, ...policy }
    for (const value of Object.values(this.policy)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Background history limits must be positive integers.')
    if (file !== ':memory:') { fs.mkdirSync(path.dirname(file), { recursive: true }); secureDir(path.dirname(file)) }
    this.db = new Database(file)
    try {
      this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON')
      this.db.pragma('busy_timeout = 1000'); this.db.pragma('journal_size_limit = 10000000')
      const version = this.db.pragma('user_version', { simple: true }) as number
      if (version > 1) throw new Error('Background history was written by a newer Specrails version.')
      if (version < 1) this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE background_process_runs (
            process_id TEXT PRIMARY KEY,
            pid INTEGER NOT NULL,
            project_id TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('starting','running','stopping','exited','killed','failed','interrupted')),
            metadata TEXT NOT NULL,
            next_sequence INTEGER NOT NULL DEFAULT 0,
            clipped INTEGER NOT NULL DEFAULT 0,
            line_count INTEGER NOT NULL DEFAULT 0,
            text_bytes INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX background_process_owner ON background_process_runs(project_id, chat_id, started_at DESC);
          CREATE INDEX background_process_retention ON background_process_runs(status, updated_at);
          CREATE TABLE background_process_lines (
            process_id TEXT NOT NULL REFERENCES background_process_runs(process_id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            at INTEGER NOT NULL,
            source TEXT NOT NULL CHECK(source IN ('stdout','stderr')),
            line TEXT NOT NULL,
            partial INTEGER NOT NULL,
            text_bytes INTEGER NOT NULL,
            PRIMARY KEY(process_id, sequence)
          ) WITHOUT ROWID;
          PRAGMA user_version = 1;
        `)
      })()
      this.db.exec('CREATE TABLE IF NOT EXISTS background_process_session_owner (slot INTEGER PRIMARY KEY CHECK(slot=1), pid INTEGER NOT NULL, token TEXT NOT NULL)')
      this.db.transaction(() => {
        const owner = this.db.prepare('SELECT pid,token FROM background_process_session_owner WHERE slot=1').get() as { pid: number; token: string } | undefined
        if (owner) {
          let dead = false
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0) } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH' }
          }
          if (!dead) throw new Error('Background process history is already owned by another active Specrails server.')
        }
        this.db.prepare('INSERT OR REPLACE INTO background_process_session_owner(slot,pid,token) VALUES(1,?,?)').run(process.pid, this.ownerToken)
        this.recover()
        this.prune(true)
      }).immediate()
      secureDbFile(file)
    } catch (error) { this.db.close(); throw error }
  }

  private recover(): void {
    const now = Date.now()
    const rows = this.db.prepare(`SELECT process_id, metadata FROM background_process_runs WHERE status IN ${activeStatuses}`).all() as ProcessRow[]
    const update = this.db.prepare("UPDATE background_process_runs SET status='interrupted', metadata=?, updated_at=? WHERE process_id=?")
    this.db.transaction(() => {
      for (const row of rows) {
        const process = JSON.parse(row.metadata) as BackgroundProcess
        process.status = 'interrupted'; process.recoveredAt = now
        process.error = 'Specrails restarted before process exit could be confirmed. This historical process is not attached to this session.'
        update.run(JSON.stringify(process), now, row.process_id)
      }
    })()
  }

  write(input: BackgroundProcessWrite): void {
    const { process } = input
    const lines = input.lines.map(line => ({ ...line, partial: line.partial === true ? 1 : 0, text_bytes: Buffer.byteLength(line.line, 'utf8') }))
    this.db.transaction(() => {
      const result = this.db.prepare(`INSERT INTO background_process_runs(process_id,pid,project_id,chat_id,started_at,updated_at,status,metadata,next_sequence,clipped)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(process_id) DO UPDATE SET updated_at=excluded.updated_at,status=excluded.status,metadata=excluded.metadata,
          next_sequence=MAX(background_process_runs.next_sequence,excluded.next_sequence),clipped=MAX(background_process_runs.clipped,excluded.clipped)
        WHERE background_process_runs.pid=excluded.pid AND background_process_runs.project_id=excluded.project_id AND background_process_runs.chat_id=excluded.chat_id`)
        .run(process.processId, process.pid, process.projectId, process.chatId, process.startedAt, Date.now(), process.status, JSON.stringify(process), input.nextSequence, input.clipped ? 1 : 0)
      if (!result.changes) throw new Error('Background process history identity does not match its original owner.')
      if (lines.length) this.db.prepare(`INSERT INTO background_process_lines(process_id,sequence,at,source,line,partial,text_bytes)
        SELECT ?,json_extract(value,'$.sequence'),json_extract(value,'$.at'),json_extract(value,'$.source'),json_extract(value,'$.line'),json_extract(value,'$.partial'),json_extract(value,'$.text_bytes') FROM json_each(?) WHERE 1
        ON CONFLICT(process_id,sequence) DO UPDATE SET line=excluded.line,partial=excluded.partial,text_bytes=excluded.text_bytes`)
        .run(process.processId, JSON.stringify(lines))
      this.db.prepare(`DELETE FROM background_process_lines WHERE process_id=? AND sequence NOT IN
        (SELECT sequence FROM background_process_lines WHERE process_id=? ORDER BY sequence DESC LIMIT ?)`)
        .run(process.processId, process.processId, this.policy.maxLines)
      this.recount(process.processId)
      this.prune(false)
    })()
  }

  private recount(processId: string): void {
    this.db.prepare(`UPDATE background_process_runs SET line_count=(SELECT COUNT(*) FROM background_process_lines WHERE process_id=?),
      text_bytes=(SELECT COALESCE(SUM(text_bytes),0) FROM background_process_lines WHERE process_id=?) WHERE process_id=?`).run(processId, processId, processId)
  }

  /** Retention prunes records/text, then SQLite reuses its freed pages. The
   * finite text ceiling therefore also bounds repeated long-running sessions. */
  prune(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastPrune < 1000) {
      const totals = this.db.prepare(`SELECT COALESCE(SUM(text_bytes),0) AS bytes,SUM(CASE WHEN status NOT IN ${activeStatuses} THEN 1 ELSE 0 END) AS finished FROM background_process_runs`).get() as { bytes: number; finished: number }
      if (totals.bytes <= this.policy.maxTextBytes && totals.finished <= this.policy.maxFinishedRuns) return
    }
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM background_process_runs WHERE status NOT IN ${activeStatuses} AND updated_at < ?`).run(now - this.policy.retentionMs)
      this.db.prepare(`DELETE FROM background_process_runs WHERE process_id IN (SELECT process_id FROM background_process_runs WHERE status NOT IN ${activeStatuses}
        ORDER BY updated_at DESC,started_at DESC,process_id DESC LIMIT -1 OFFSET ?)`).run(this.policy.maxFinishedRuns)
      let total = (this.db.prepare('SELECT COALESCE(SUM(text_bytes),0) AS bytes FROM background_process_runs').get() as { bytes: number }).bytes
      if (total > this.policy.maxTextBytes) {
        const rows = this.db.prepare(`SELECT process_id,text_bytes,status FROM background_process_runs ORDER BY CASE WHEN status IN ${activeStatuses} THEN 1 ELSE 0 END,updated_at,started_at`).all() as Array<{ process_id: string; text_bytes: number; status: string }>
        for (const row of rows) {
          if (total <= this.policy.maxTextBytes) break
          if (!['starting','running','stopping'].includes(row.status)) {
            this.db.prepare('DELETE FROM background_process_runs WHERE process_id=?').run(row.process_id)
            total -= row.text_bytes
          } else {
            this.db.prepare(`DELETE FROM background_process_lines WHERE process_id=? AND sequence IN (
              SELECT sequence FROM (SELECT sequence,SUM(text_bytes) OVER (ORDER BY sequence)-text_bytes AS preceding_bytes FROM background_process_lines WHERE process_id=?) WHERE preceding_bytes < ?)`)
              .run(row.process_id, row.process_id, total - this.policy.maxTextBytes)
            this.recount(row.process_id)
            const remaining = (this.db.prepare('SELECT text_bytes FROM background_process_runs WHERE process_id=?').get(row.process_id) as { text_bytes: number }).text_bytes
            total -= row.text_bytes - remaining
          }
        }
      }
    })()
    this.lastPrune = now
  }

  get(pid: number, processId?: string): BackgroundProcess | null {
    this.prune()
    const row = (processId
      ? this.db.prepare('SELECT metadata FROM background_process_runs WHERE pid=? AND process_id=?').get(pid, processId)
      : this.db.prepare('SELECT metadata FROM background_process_runs WHERE pid=? ORDER BY started_at DESC,rowid DESC LIMIT 1').get(pid)) as Pick<ProcessRow, 'metadata'> | undefined
    return row ? JSON.parse(row.metadata) as BackgroundProcess : null
  }

  list(filter: { projectId?: string; chatId?: string; includeFinished?: boolean } = {}): BackgroundProcess[] {
    this.prune()
    const clauses: string[] = [], params: unknown[] = []
    if (filter.projectId) { clauses.push('project_id=?'); params.push(filter.projectId) }
    if (filter.chatId) { clauses.push('chat_id=?'); params.push(filter.chatId) }
    if (!filter.includeFinished) clauses.push(`status IN ${activeStatuses}`)
    const rows = this.db.prepare(`SELECT metadata FROM background_process_runs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY started_at,rowid`).all(...params) as Pick<ProcessRow, 'metadata'>[]
    return rows.map(row => JSON.parse(row.metadata) as BackgroundProcess)
  }

  logs(pid: number, filter: { processId?: string; projectId?: string; chatId?: string; limit?: number } = {}): BackgroundProcessLogSnapshot | null {
    const process = this.get(pid, filter.processId)
    if (!process || (filter.projectId && process.projectId !== filter.projectId) || (filter.chatId && process.chatId !== filter.chatId)) return null
    const row = this.db.prepare('SELECT next_sequence,clipped,line_count FROM background_process_runs WHERE process_id=?').get(process.processId) as ProcessRow
    const limit = typeof filter.limit === 'number' && Number.isFinite(filter.limit) ? Math.max(1, Math.min(this.policy.maxLines, Math.floor(filter.limit))) : 2000
    const lines = (this.db.prepare('SELECT sequence,at,source,line,partial FROM background_process_lines WHERE process_id=? ORDER BY sequence DESC LIMIT ?').all(process.processId, limit) as Array<Omit<BackgroundProcessLogLine, 'partial'> & { partial: number }>)
      .reverse().map(line => ({ ...line, partial: line.partial === 1 }))
    const droppedLines = Math.max(0, row.next_sequence - lines.length)
    return { process, lines, nextSequence: row.next_sequence, truncated: droppedLines > 0 || !!row.clipped, droppedLines,
      maxLines: this.policy.maxLines, maxLineChars: BACKGROUND_HISTORY_MAX_LINE_CHARS, retentionMs: this.policy.retentionMs }
  }

  close(): void {
    if (!this.db.open) return
    try {
      this.db.prepare('DELETE FROM background_process_session_owner WHERE slot=1 AND token=?').run(this.ownerToken)
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } finally { this.db.close() }
  }

  purge(filter: { projectId?: string; chatId?: string }): void {
    if (!filter.projectId && !filter.chatId) throw new Error('A conversation or project is required to purge background history.')
    const clauses: string[] = [], params: string[] = []
    if (filter.projectId) { clauses.push('project_id=?'); params.push(filter.projectId) }
    if (filter.chatId) { clauses.push('chat_id=?'); params.push(filter.chatId) }
    this.db.prepare(`DELETE FROM background_process_runs WHERE ${clauses.join(' AND ')}`).run(...params)
  }
}
