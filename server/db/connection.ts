import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { secureDir, secureDbFile } from '../util/secure-fs'
import { applyMigrations } from './migrations'
import type { DbInstance } from './types'

export function initDb(dbPath: string): DbInstance {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath)
    fs.mkdirSync(dir, { recursive: true })
    secureDir(dir) // H-13: owner-only data dir
  }

  const db = new Database(dbPath)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    // Under load, QueueManager / ChatManager / FileSummaryManager write the same
    // per-project DB concurrently with /analytics reads. Wait up to 5s on a lock
    // instead of throwing SQLITE_BUSY, and cap the WAL so a long checkpoint can't
    // grow it without bound.
    db.pragma('busy_timeout = 5000')
    db.pragma('journal_size_limit = 10000000') // ~10 MB

    applyMigrations(db)

    // H-13: restrict the db + its WAL sidecars to 0600 (jobs.sqlite holds chat
    // transcripts and verbatim terminal command history). After migrations the
    // WAL/SHM files exist, so this covers them too.
    secureDbFile(dbPath)

    // Orphan sweep: cancel any in-flight proposals from a previous server session
    db.prepare(
      "UPDATE proposals SET status = 'cancelled', updated_at = ? WHERE status IN ('exploring', 'refining')"
    ).run(new Date().toISOString())
  } catch (err) {
    db.close()
    throw err
  }
  return db
}
