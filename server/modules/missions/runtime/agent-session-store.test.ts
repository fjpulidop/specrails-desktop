import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { createAgentConversation } from '../../agents/runtime/agent-store'
import {
  advanceSessionCursor,
  conversationSessionState,
  ensureSessionCursor,
  getSessionCursor,
  listActiveSessionCursors,
  setResidentState,
  settleOrphanedSessionCursors,
} from './agent-session-store'

describe('settleOrphanedSessionCursors', () => {
  let db: DbInstance
  beforeEach(() => { db = initDesktopDb(':memory:') })
  afterEach(() => { db.close() })

  it('[spec:mission-archive/stale-session-state-after-a-restart] settles every live cursor to idle across conversations, keeping the journal cursor', () => {
    const first = createAgentConversation(db).id
    const second = createAgentConversation(db).id
    const flow = `flow:${first}:abc`
    ensureSessionCursor(db, first, first, 'global')
    ensureSessionCursor(db, first, flow, 'global')
    ensureSessionCursor(db, second, second, 'p1')
    setResidentState(db, first, 'idle', false, 0)
    setResidentState(db, first, 'turn', true, 0, flow)
    advanceSessionCursor(db, first, 115, flow)
    setResidentState(db, second, 'idle', false, 3)

    expect(listActiveSessionCursors(db).map((row) => row.conversationId).sort()).toEqual([first, second].sort())
    expect(settleOrphanedSessionCursors(db)).toBe(2)

    expect(getSessionCursor(db, first, flow)).toMatchObject({ residentPhase: 'idle', processAlive: false, liveSubagents: 0, lastSeq: 115 })
    expect(getSessionCursor(db, second)).toMatchObject({ residentPhase: 'idle', processAlive: false, liveSubagents: 0 })
    expect(conversationSessionState(db, first)).toEqual({ residentPhase: 'idle', processAlive: false, liveSubagents: 0 })
    expect(listActiveSessionCursors(db)).toEqual([])
  })

  it('settles a resident process left alive between turns and leaves already-idle cursors alone', () => {
    const id = createAgentConversation(db).id
    const other = createAgentConversation(db).id
    ensureSessionCursor(db, id, id, 'global')
    ensureSessionCursor(db, other, other, 'global')
    setResidentState(db, id, 'idle', true, 0)

    expect(settleOrphanedSessionCursors(db)).toBe(1)
    expect(getSessionCursor(db, id)?.processAlive).toBe(false)
    expect(settleOrphanedSessionCursors(db)).toBe(0)
  })
})
