import type { DbInstance } from './types'

/** Distinct SQL texts kept per connection (dynamic `IN (?, ?, …)` lists vary). */
export const STATEMENT_CACHE_LIMIT = 256

type Statement = ReturnType<DbInstance['prepare']>

/**
 * Reuse prepared statements on one connection. Cross-project read models (live
 * board, inbox, budgets, analytics) prepare the same SQL for every project on
 * every request, and preparing cost more than running the query.
 *
 * The cache belongs to the connection (no data, only compiled SQL) and is
 * dropped with it. A statement still being iterated is never handed out twice:
 * that caller gets a fresh one. SQLite recompiles a cached statement by itself
 * after a schema change. The repository never toggles statement modes
 * (`pluck`/`raw`/`expand`/`bind`), so a reused statement behaves like a new one.
 */
export function enableStatementCache(db: DbInstance, limit: number = STATEMENT_CACHE_LIMIT): DbInstance {
  const prepare = db.prepare.bind(db) as (sql: string) => Statement
  const cache = new Map<string, Statement>()
  const cached = (sql: string): Statement => {
    const hit = cache.get(sql)
    if (hit) {
      if (hit.busy) return prepare(sql)
      // Most recently used last: eviction drops the oldest.
      cache.delete(sql)
      cache.set(sql, hit)
      return hit
    }
    const statement = prepare(sql)
    cache.set(sql, statement)
    if (cache.size > limit) cache.delete(cache.keys().next().value as string)
    return statement
  }
  Object.defineProperty(db, 'prepare', { value: cached, configurable: true, writable: true })
  return db
}
