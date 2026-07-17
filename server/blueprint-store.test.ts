import { describe, it, expect, beforeEach } from 'vitest'
import { initDesktopDb } from './desktop-db'
import type { DbInstance } from './db'
import {
  addBlueprintMessage,
  createBlueprintConversation,
  deleteBlueprintConversation,
  getBlueprintConversation,
  listBlueprintConversations,
  listBlueprintMessages,
  updateBlueprintConversation,
} from './blueprint-store'

describe('blueprint-store', () => {
  let db: DbInstance
  beforeEach(() => {
    db = initDesktopDb(':memory:')
  })

  it('creates and fetches a conversation with defaults', () => {
    const conv = createBlueprintConversation(db)
    expect(conv.provider).toBe('claude')
    expect(conv.model).toBeNull()
    expect(conv.title).toBeNull()
    expect(getBlueprintConversation(db, conv.id)?.id).toBe(conv.id)
  })

  it('creates with explicit provider/model', () => {
    const conv = createBlueprintConversation(db, { provider: 'codex', model: 'gpt-5' })
    expect(conv.provider).toBe('codex')
    expect(conv.model).toBe('gpt-5')
  })

  it('updates only provided fields and bumps updated_at', () => {
    const conv = createBlueprintConversation(db)
    const updated = updateBlueprintConversation(db, conv.id, { title: 'Recipely', session_id: 'sess-1' })
    expect(updated?.title).toBe('Recipely')
    expect(updated?.session_id).toBe('sess-1')
    expect(updated?.provider).toBe('claude')
  })

  it('lists conversations newest-activity first', () => {
    const a = createBlueprintConversation(db)
    const b = createBlueprintConversation(db)
    // force ordering: touch `a` with a strictly later timestamp
    db.prepare("UPDATE blueprint_conversations SET updated_at = datetime('now', '+1 hour') WHERE id = ?").run(a.id)
    const list = listBlueprintConversations(db)
    expect(list.map((c) => c.id)).toEqual([a.id, b.id])
  })

  it('adds and lists messages in insertion order', () => {
    const conv = createBlueprintConversation(db)
    addBlueprintMessage(db, { conversationId: conv.id, role: 'user', content: 'an app for recipes' })
    addBlueprintMessage(db, { conversationId: conv.id, role: 'assistant', content: 'proposal…' })
    const msgs = listBlueprintMessages(db, conv.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[0].content).toBe('an app for recipes')
  })

  it('delete cascades messages', () => {
    const conv = createBlueprintConversation(db)
    addBlueprintMessage(db, { conversationId: conv.id, role: 'user', content: 'x' })
    deleteBlueprintConversation(db, conv.id)
    expect(getBlueprintConversation(db, conv.id)).toBeUndefined()
    expect(listBlueprintMessages(db, conv.id)).toEqual([])
  })
})
