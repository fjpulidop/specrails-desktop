import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDesktopDb, addProject } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import {
  addAgentMessage, archiveAgentConversation, createAgentConversation, getAgentConversation,
  softDeleteAgentConversation, restoreAgentConversation, listExpiredAgentConversationIds, AGENT_TRASH_RETENTION_MS,
  listAgentConversations, listAgentMessages, unarchiveAgentConversation, updateAgentConversation,
} from './agent-store'

describe('mission archive store', () => {
  let db: DbInstance
  const now = new Date('2026-01-02T03:04:05.000Z')
  beforeEach(() => { db = initDesktopDb(':memory:') })
  afterEach(() => { db.close() })

  it('[spec:mission-archive/persistent-reversible-archive] archives idempotently without changing history, pin, session or activity', () => {
    addProject(db, { id: 'p', slug: 'p', name: 'Project', path: '/project' })
    const mission = createAgentConversation(db, { pinnedProjectId: 'p', tierLevel: 2 })
    updateAgentConversation(db, mission.id, { session_id: 'session' })
    addAgentMessage(db, { conversationId: mission.id, role: 'user', content: 'Keep history', attachmentIds: ['attachment'] })
    const before = getAgentConversation(db, mission.id)!
    const history = listAgentMessages(db, mission.id)
    expect(before.archivedAt).toBeNull()
    expect(archiveAgentConversation(db, mission.id, now)).toEqual({ ...before, archivedAt: now.toISOString() })
    expect(archiveAgentConversation(db, mission.id, new Date('2027-01-01'))).toEqual({ ...before, archivedAt: now.toISOString() })
    expect(listAgentMessages(db, mission.id)).toEqual(history)
    expect(unarchiveAgentConversation(db, mission.id)).toEqual(before)
    expect(unarchiveAgentConversation(db, mission.id)).toEqual(before)
  })

  it('returns null for unknown and trashed IDs without restoring trash', () => {
    const mission = createAgentConversation(db)
    db.prepare('UPDATE agent_conversations SET deleted_at = ? WHERE id = ?').run(now.toISOString(), mission.id)
    expect(archiveAgentConversation(db, 'missing', now)).toBeNull()
    expect(unarchiveAgentConversation(db, 'missing')).toBeNull()
    expect(archiveAgentConversation(db, mission.id, now)).toBeNull()
    expect(unarchiveAgentConversation(db, mission.id)).toBeNull()
    expect(getAgentConversation(db, mission.id)?.deleted_at).toBe(now.toISOString())
  })

  it('[spec:mission-archive/delete-requires-archive-and-preserves-trash] requires archive for soft delete, retains first stamps and restores to Archived', () => {
    const c = createAgentConversation(db)
    expect(softDeleteAgentConversation(db, c.id, now)).toBe(false)
    expect(getAgentConversation(db, c.id)?.deleted_at).toBeNull()
    archiveAgentConversation(db, c.id, now)
    expect(softDeleteAgentConversation(db, c.id, now)).toBe(true)
    expect(softDeleteAgentConversation(db, c.id, new Date('2027-01-01'))).toBe(true)
    expect(getAgentConversation(db, c.id)?.deleted_at).toBe(now.toISOString())
    expect(restoreAgentConversation(db, c.id)?.archivedAt).toBe(now.toISOString())
    expect(listAgentConversations(db, { archiveScope: 'archived' }).map((row) => row.id)).toEqual([c.id])
  })

  it('preserves legacy trash restore and the exact 30-day expiry boundary', () => {
    const c = createAgentConversation(db)
    db.prepare('UPDATE agent_conversations SET deleted_at = ? WHERE id = ?').run(now.toISOString(), c.id)
    expect(listExpiredAgentConversationIds(db, new Date(now.getTime() + AGENT_TRASH_RETENTION_MS - 1))).toEqual([])
    expect(listExpiredAgentConversationIds(db, new Date(now.getTime() + AGENT_TRASH_RETENTION_MS))).toEqual([c.id])
    expect(restoreAgentConversation(db, c.id)?.archivedAt).toBeNull()
    expect(listAgentConversations(db).map((row) => row.id)).toEqual([c.id])
  })

  it('[spec:mission-archive/archive-scoped-lists] scopes every list without trash and preserves activity ordering and numeric limits', () => {
    const older = createAgentConversation(db)
    const archived = createAgentConversation(db)
    const newer = createAgentConversation(db)
    const trash = createAgentConversation(db)
    db.prepare('UPDATE agent_conversations SET updated_at = ? WHERE id = ?').run('2026-01-01', older.id)
    db.prepare('UPDATE agent_conversations SET updated_at = ? WHERE id = ?').run('2026-01-02', archived.id)
    db.prepare('UPDATE agent_conversations SET updated_at = ? WHERE id = ?').run('2026-01-03', newer.id)
    db.prepare('UPDATE agent_conversations SET deleted_at = ?, archived_at = ? WHERE id = ?').run(now.toISOString(), now.toISOString(), trash.id)
    archiveAgentConversation(db, archived.id, now)
    expect(listAgentConversations(db).map((row) => row.id)).toEqual([newer.id, older.id])
    expect(listAgentConversations(db, { archiveScope: 'active' }).map((row) => row.id)).toEqual([newer.id, older.id])
    expect(listAgentConversations(db, { archiveScope: 'archived' }).map((row) => row.id)).toEqual([archived.id])
    expect(listAgentConversations(db, { archiveScope: 'all' }).map((row) => row.id)).toEqual([newer.id, archived.id, older.id])
    expect(listAgentConversations(db, 1).map((row) => row.id)).toEqual([newer.id])
    expect(listAgentConversations(db, { archiveScope: 'all', limit: 2 }).map((row) => row.id)).toEqual([newer.id, archived.id])
    expect(listAgentConversations(db, { limit: 0 })).toEqual([])
  })
})
