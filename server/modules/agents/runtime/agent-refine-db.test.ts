import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import {
  createRefineSession,
  getRefineSession,
  listRefineSessionsForAgent,
  updateRefineSession,
  deleteRefineSession,
  pruneStaleRefineSessions,
} from './agent-refine-db'

describe('agent-refine-db', () => {
  let db: DbInstance

  beforeEach(() => {
    db = initDb(':memory:')
  })

  function seed(id: string, agentId = 'custom-foo'): void {
    createRefineSession(db, {
      id,
      agentId,
      baseVersion: 1,
      baseBodyHash: 'abc',
      autoTest: true,
    })
  }

  describe('createRefineSession', () => {
    it('persists a row with idle defaults', () => {
      seed('s1')
      const row = getRefineSession(db, 's1')!
      expect(row.id).toBe('s1')
      expect(row.agent_id).toBe('custom-foo')
      expect(row.session_id).toBeNull()
      expect(row.draft_body).toBeNull()
      expect(row.history).toEqual([])
      expect(row.phase).toBe('idle')
      expect(row.status).toBe('idle')
      expect(row.auto_test).toBe(1)
      expect(row.last_test_at).toBeNull()
      expect(row.last_test_hash).toBeNull()
    })

    it('persists autoTest=false correctly', () => {
      createRefineSession(db, {
        id: 's2',
        agentId: 'custom-bar',
        baseVersion: 0,
        baseBodyHash: 'h',
        autoTest: false,
      })
      expect(getRefineSession(db, 's2')!.auto_test).toBe(0)
    })
  })

  describe('getRefineSession', () => {
    it('returns undefined for missing id', () => {
      expect(getRefineSession(db, 'nope')).toBeUndefined()
    })

    it('parses history JSON back into an array', () => {
      seed('s1')
      updateRefineSession(db, 's1', {
        history: [
          { role: 'user', content: 'hi', timestamp: 1 },
          { role: 'assistant', content: 'ok', timestamp: 2 },
        ],
      })
      const row = getRefineSession(db, 's1')!
      expect(row.history).toHaveLength(2)
      expect(row.history[0].role).toBe('user')
      expect(row.history[1].content).toBe('ok')
    })

    it('falls back to empty history if JSON is corrupted', () => {
      seed('s1')
      // Forcefully corrupt the column.
      db.prepare(`UPDATE agent_refine_sessions SET history_json = '{not json' WHERE id = ?`).run('s1')
      const row = getRefineSession(db, 's1')!
      expect(row.history).toEqual([])
    })
  })

  describe('updateRefineSession', () => {
    it('updates only the supplied fields and refreshes updated_at', async () => {
      seed('s1')
      const before = getRefineSession(db, 's1')!
      // Wait at least one ms so updated_at strictly increases.
      await new Promise((r) => setTimeout(r, 5))
      updateRefineSession(db, 's1', { phase: 'drafting', draft_body: 'partial' })
      const after = getRefineSession(db, 's1')!
      expect(after.phase).toBe('drafting')
      expect(after.draft_body).toBe('partial')
      expect(after.status).toBe(before.status)
      expect(after.updated_at).toBeGreaterThan(before.updated_at)
    })

    it('supports nullable fields explicitly', () => {
      seed('s1')
      updateRefineSession(db, 's1', { session_id: 'sess-x' })
      expect(getRefineSession(db, 's1')!.session_id).toBe('sess-x')
      updateRefineSession(db, 's1', { session_id: null })
      expect(getRefineSession(db, 's1')!.session_id).toBeNull()
    })

    it('is a no-op when the patch is empty', () => {
      seed('s1')
      const before = getRefineSession(db, 's1')!
      updateRefineSession(db, 's1', {})
      const after = getRefineSession(db, 's1')!
      expect(after.updated_at).toBe(before.updated_at)
    })
  })

  describe('listRefineSessionsForAgent', () => {
    it('returns sessions for the agent ordered by updated_at desc', async () => {
      createRefineSession(db, { id: 's1', agentId: 'custom-a', baseVersion: 0, baseBodyHash: 'h', autoTest: true })
      await new Promise((r) => setTimeout(r, 3))
      createRefineSession(db, { id: 's2', agentId: 'custom-a', baseVersion: 0, baseBodyHash: 'h', autoTest: true })
      createRefineSession(db, { id: 's3', agentId: 'custom-other', baseVersion: 0, baseBodyHash: 'h', autoTest: true })
      const rows = listRefineSessionsForAgent(db, 'custom-a')
      expect(rows.map((r) => r.id)).toEqual(['s2', 's1'])
    })
  })

  describe('deleteRefineSession', () => {
    it('removes the row', () => {
      seed('s1')
      deleteRefineSession(db, 's1')
      expect(getRefineSession(db, 's1')).toBeUndefined()
    })

    it('is a no-op for a missing id', () => {
      expect(() => deleteRefineSession(db, 'nope')).not.toThrow()
    })
  })

  describe('pruneStaleRefineSessions', () => {
    it('deletes cancelled and error rows older than 24h', () => {
      seed('old-cancel')
      seed('old-err')
      seed('new-cancel')
      const day = 24 * 60 * 60 * 1000
      const past = Date.now() - day - 10_000
      const recent = Date.now() - 60_000
      db.prepare(`UPDATE agent_refine_sessions SET status='cancelled', updated_at=? WHERE id='old-cancel'`).run(past)
      db.prepare(`UPDATE agent_refine_sessions SET status='error',     updated_at=? WHERE id='old-err'`).run(past)
      db.prepare(`UPDATE agent_refine_sessions SET status='cancelled', updated_at=? WHERE id='new-cancel'`).run(recent)
      const removed = pruneStaleRefineSessions(db)
      expect(removed).toBeGreaterThanOrEqual(2)
      expect(getRefineSession(db, 'old-cancel')).toBeUndefined()
      expect(getRefineSession(db, 'old-err')).toBeUndefined()
      expect(getRefineSession(db, 'new-cancel')).toBeDefined()
    })

    it('marks stuck streaming rows as error and prunes them', () => {
      seed('stuck')
      const past = Date.now() - 25 * 60 * 60 * 1000
      db.prepare(`UPDATE agent_refine_sessions SET status='streaming', updated_at=? WHERE id='stuck'`).run(past)
      pruneStaleRefineSessions(db)
      expect(getRefineSession(db, 'stuck')).toBeUndefined()
    })

    it('retains ready and applied rows even when old', () => {
      seed('ready-old')
      seed('applied-old')
      const past = Date.now() - 30 * 24 * 60 * 60 * 1000
      db.prepare(`UPDATE agent_refine_sessions SET status='ready',   updated_at=? WHERE id='ready-old'`).run(past)
      db.prepare(`UPDATE agent_refine_sessions SET status='applied', updated_at=? WHERE id='applied-old'`).run(past)
      pruneStaleRefineSessions(db)
      expect(getRefineSession(db, 'ready-old')).toBeDefined()
      expect(getRefineSession(db, 'applied-old')).toBeDefined()
    })

    it('returns 0 when nothing matches', () => {
      seed('s1')
      // Status 'idle' is in the prune set but row is fresh — should not be pruned.
      expect(pruneStaleRefineSessions(db)).toBe(0)
    })
  })
})
