import { afterEach, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { readRuntimeExpiration, recordRuntimeExpiration, readRuntimeRetentionPolicy, saveRuntimeRetentionPolicy, type RuntimeExpirationRecord } from './agent-runtime-retention-records'
const databases: DbInstance[] = []
function database() { const db = initDb(':memory:'); databases.push(db); return db }
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const record: RuntimeExpirationRecord = { runId: 'run', expiredAt: '2026-09-27T00:00:00Z', disposition: 'settled', previousStatus: 'succeeded', quarantineToken: 'owned-token', summary: { costUsd: null, completed: true } }
it('preserves an immutable expiration identity on idempotent restart', () => {
  const db = database(); expect(readRuntimeExpiration(db, 'run')).toBeNull()
  recordRuntimeExpiration(db, record)
  recordRuntimeExpiration(db, { ...record, summary: { changed: true } })
  expect(readRuntimeExpiration(db, 'run')).toEqual(record)
  expect(() => recordRuntimeExpiration(db, { ...record, quarantineToken: 'replacement' })).toThrow('identity')
  expect(readRuntimeExpiration(db, 'run')).toEqual(record)
})
it('isolates retention settings and expired histories per project', () => {
  const one = database(), two = database()
  expect(readRuntimeRetentionPolicy(one)).toEqual({ days: null })
  saveRuntimeRetentionPolicy(one, { days: 90 }); recordRuntimeExpiration(one, record)
  expect(readRuntimeRetentionPolicy(one)).toEqual({ days: 90 })
  expect(readRuntimeRetentionPolicy(two)).toEqual({ days: null })
  expect(readRuntimeExpiration(two, 'run')).toBeNull()
  saveRuntimeRetentionPolicy(one, { days: null })
  expect(readRuntimeRetentionPolicy(one)).toEqual({ days: null })
})
it('rejects invalid configuration without altering the previous policy', () => {
  const db = database(); saveRuntimeRetentionPolicy(db, { days: 30 })
  expect(() => saveRuntimeRetentionPolicy(db, { days: 0 })).toThrow()
  expect(readRuntimeRetentionPolicy(db)).toEqual({ days: 30 })
})
