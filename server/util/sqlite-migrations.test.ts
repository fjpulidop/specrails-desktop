import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyNumberedMigrations } from './sqlite-migrations'
import { initDb } from '../db'
import { initDesktopDb } from '../desktop-db'

describe('startup migrations', () => {
  afterEach(() => vi.restoreAllMocks())

  it('rechecks a stale migration snapshot after another connection completes the same migration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-migration-race-'))
    const filename = path.join(dir, 'jobs.sqlite')
    const first = new Database(filename)
    const other = new Database(filename)
    try {
      first.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); CREATE TABLE example (id INTEGER)')
      const originalPrepare = first.prepare.bind(first)
      vi.spyOn(first, 'prepare').mockImplementation((sql: string) => {
        const statement = originalPrepare(sql)
        if (sql === 'SELECT version FROM schema_migrations') {
          const read = statement.all.bind(statement)
          vi.spyOn(statement, 'all').mockImplementation(() => {
            const staleVersions = read()
            other.transaction(() => {
              other.exec('ALTER TABLE example ADD COLUMN name TEXT; INSERT INTO schema_migrations VALUES (1)')
            }).immediate()
            return staleVersions
          })
        }
        return statement
      })
      expect(() => applyNumberedMigrations(first, [(db) => db.exec('ALTER TABLE example ADD COLUMN name TEXT')])).not.toThrow()
      expect(first.prepare('SELECT version FROM schema_migrations').get()).toEqual({ version: 1 })
    } finally {
      first.close()
      other.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rolls back a failed body and its version together, then retries cleanly', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)')
      expect(() => applyNumberedMigrations(db, [(connection) => {
        connection.exec('CREATE TABLE example (id INTEGER)')
        throw new Error('interrupted migration')
      }])).toThrow('interrupted migration')
      expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual([])
      applyNumberedMigrations(db, [(connection) => connection.exec('CREATE TABLE example (id INTEGER)')])
      expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual([{ version: 1 }])
    } finally { db.close() }
  })

  it.each([['project', initDb], ['desktop', initDesktopDb]] as const)('closes the %s handle when startup fails', (_kind, initialize) => {
    const close = vi.spyOn(Database.prototype, 'close')
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(() => { throw new Error('database unavailable') })
    expect(() => initialize(':memory:')).toThrow('database unavailable')
    expect(close).toHaveBeenCalledOnce()
  })
})
