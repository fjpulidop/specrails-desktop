import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { applyMigrations } from '../../../db/migrations'
import { isLegacySlashCommand, readLegacyLaunchSummary, recordLegacyLaunch } from './legacy-launch-telemetry'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())

describe('observed legacy launch telemetry', () => {
  it('recognizes bare and namespaced slash commands without counting absolute executable paths', () => {
    expect(['/implement #1', '/specrails:verify', '  /sr:quick-sdd', '$implement #2', '$batch', '  $opsx-apply change'].every(isLegacySlashCommand)).toBe(true)
    expect(['Fix this', '/usr/bin/node', 'Look at /implement', '$(echo command)', '$HOME/bin/tool', '$implement/extra'].some(isLegacySlashCommand)).toBe(false)
  })
  it('is append-only, run-idempotent and distinguishes paths for the same run', () => {
    expect(readLegacyLaunchSummary(db)).toEqual({ total: 0, byKind: { legacy_loop_traversal: 0, queue_manager_slash: 0, merge_back: 0 }, lastAt: null })
    const event = { kind: 'legacy_loop_traversal' as const, projectId: 'p1', runId: 'r1', at: '2026-09-26T10:00:00Z' }
    recordLegacyLaunch(db, event); recordLegacyLaunch(db, event)
    recordLegacyLaunch(db, { ...event, kind: 'merge_back' })
    applyMigrations(db)
    expect(readLegacyLaunchSummary(db)).toMatchObject({ total: 2, byKind: { legacy_loop_traversal: 1, merge_back: 1 } })
  })
  it('normalizes timezone offsets before comparing an inclusive time window', () => {
    recordLegacyLaunch(db, { kind: 'queue_manager_slash', projectId: 'p1', at: '2026-09-26T14:00:00+02:00' })
    recordLegacyLaunch(db, { kind: 'queue_manager_slash', projectId: 'p1', at: '2026-09-26T11:59:59Z' })
    expect(readLegacyLaunchSummary(db, '2026-09-26T08:00:00-04:00')).toMatchObject({ total: 1, lastAt: '2026-09-26T12:00:00.000Z' })
    expect(readLegacyLaunchSummary(db)).toMatchObject({ total: 2 })
  })
  it('rejects invalid input and keeps project databases isolated', () => {
    expect(() => recordLegacyLaunch(db, { kind: 'merge_back', projectId: '' })).toThrow('projectId')
    expect(() => recordLegacyLaunch(db, { kind: 'merge_back', projectId: 'p1', runId: '' })).toThrow('runId')
    expect(() => readLegacyLaunchSummary(db, 'invalid')).toThrow('timestamp')
    recordLegacyLaunch(db, { kind: 'merge_back', projectId: 'p1', runId: 'r1' })
    const other = initDb(':memory:')
    try { expect(readLegacyLaunchSummary(other).total).toBe(0) } finally { other.close() }
  })
})
