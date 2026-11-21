import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { enableStatementCache } from './statement-cache'
import { initDb } from './connection'

function db(limit?: number) {
  const raw = new Database(':memory:')
  raw.exec('CREATE TABLE t (a INTEGER)')
  raw.exec('INSERT INTO t VALUES (1), (2), (3)')
  return enableStatementCache(raw, limit)
}

describe('statement cache', () => {
  it('reuses the prepared statement for the same SQL', () => {
    const conn = db()
    const first = conn.prepare('SELECT a FROM t ORDER BY a')
    expect(conn.prepare('SELECT a FROM t ORDER BY a')).toBe(first)
    expect(conn.prepare('SELECT a FROM t WHERE a = ?').get(2)).toEqual({ a: 2 })
  })

  it('hands a fresh statement to a caller while the cached one is iterating', () => {
    const conn = db()
    const sql = 'SELECT a FROM t ORDER BY a'
    const seen: number[] = []
    for (const row of conn.prepare(sql).iterate() as Iterable<{ a: number }>) {
      // Re-entrant use of the same SQL during the iteration must not throw "busy".
      seen.push(row.a, (conn.prepare(sql).all() as Array<{ a: number }>).length)
    }
    expect(seen).toEqual([1, 3, 2, 3, 3, 3])
  })

  it('keeps at most `limit` distinct SQL texts, dropping the least recently used', () => {
    const conn = db(2)
    const a = conn.prepare('SELECT 1')
    conn.prepare('SELECT 2')
    expect(conn.prepare('SELECT 1')).toBe(a)
    conn.prepare('SELECT 3') // evicts SELECT 2 (least recently used)
    expect(conn.prepare('SELECT 1')).toBe(a)
    const before = conn.prepare('SELECT 3')
    expect(conn.prepare('SELECT 3')).toBe(before)
  })

  it('sees schema changes made after a statement was cached', () => {
    const conn = db()
    expect(conn.prepare('SELECT * FROM t LIMIT 1').get()).toEqual({ a: 1 })
    conn.exec('ALTER TABLE t ADD COLUMN b TEXT DEFAULT \'x\'')
    expect(conn.prepare('SELECT * FROM t LIMIT 1').get()).toEqual({ a: 1, b: 'x' })
  })

  it('is enabled on every project connection', () => {
    const conn = initDb(':memory:')
    expect(conn.prepare('SELECT 1 AS one')).toBe(conn.prepare('SELECT 1 AS one'))
    conn.close()
  })
})
