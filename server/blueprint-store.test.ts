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

describe('blueprint-store durable snapshots (harden-project-builder-snapshots)', () => {
  let db: DbInstance
  beforeEach(() => {
    db = initDesktopDb(':memory:')
  })
  const bp = {
    blueprintVersion: 1,
    product: { name: 'Recipely', pitch: 'p', audience: 'a' },
    coreFlow: 'flow',
    platform: 'web',
    stack: { language: 'ts', framework: 'next', db: 'sqlite' },
    assumptions: [],
    milestones: [{ id: 'm1', title: 't', goal: 'g', status: 'planned' as const, plannedSpecs: [] }],
    specsComplete: false,
    m1Specs: [],
  }

  it('saveBlueprintSnapshot stores the pair, clears a pending issue, and reads back normalized', async () => {
    const { saveBlueprintSnapshot, getBlueprintSnapshot, saveBlueprintSnapshotIssue } = await import('./blueprint-store')
    const conv = createBlueprintConversation(db)
    expect(getBlueprintSnapshot(db, conv.id)).toEqual({ blueprint: null, rawBlueprint: null, snapshotUpdatedAt: null, issue: null })
    saveBlueprintSnapshotIssue(db, conv.id, { reason: 'invalid_json', detail: 'boom', at: 'now' })
    expect(getBlueprintSnapshot(db, conv.id).issue).toEqual({ reason: 'invalid_json', detail: 'boom', at: 'now' })
    saveBlueprintSnapshot(db, conv.id, { blueprint: bp, rawBlueprint: { ...bp, extra: 1 } })
    const read = getBlueprintSnapshot(db, conv.id)
    expect(read.blueprint?.product.name).toBe('Recipely')
    expect((read.rawBlueprint as { extra: number }).extra).toBe(1)
    expect(read.issue).toBeNull()
    expect(read.snapshotUpdatedAt).toBeTruthy()
  })

  it('corrupt JSON columns read as null instead of throwing', async () => {
    const { getBlueprintSnapshot } = await import('./blueprint-store')
    const conv = createBlueprintConversation(db)
    db.prepare('UPDATE blueprint_conversations SET blueprint_json = ?, raw_blueprint_json = ?, snapshot_issue_json = ? WHERE id = ?').run('{nope', '{nope', '{nope', conv.id)
    expect(getBlueprintSnapshot(db, conv.id)).toEqual({ blueprint: null, rawBlueprint: null, snapshotUpdatedAt: null, issue: null })
  })

  it('addBlueprintMessage keeps the unstripped raw reply', () => {
    const conv = createBlueprintConversation(db)
    const m = addBlueprintMessage(db, { conversationId: conv.id, role: 'assistant', content: '', rawContent: '```blueprint-draft\n{}\n```' })
    expect(m.content).toBe('')
    expect(m.raw_content).toContain('blueprint-draft')
    const plain = addBlueprintMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })
    expect(plain.raw_content).toBeNull()
  })

  it('listResumableBlueprintConversations: unfinished conversations with an assistant reply, newest first, with a snapshot summary', async () => {
    const { listResumableBlueprintConversations, saveBlueprintSnapshot, markBlueprintCommitted, saveBlueprintSnapshotIssue } = await import('./blueprint-store')
    const empty = createBlueprintConversation(db) // bootstrap noise: no messages
    const userOnly = createBlueprintConversation(db)
    addBlueprintMessage(db, { conversationId: userOnly.id, role: 'user', content: 'hi' })
    const committed = createBlueprintConversation(db)
    addBlueprintMessage(db, { conversationId: committed.id, role: 'assistant', content: 'done' })
    markBlueprintCommitted(db, committed.id, 'proj-1')
    const live = createBlueprintConversation(db)
    updateBlueprintConversation(db, live.id, { title: 'Tetris' })
    addBlueprintMessage(db, { conversationId: live.id, role: 'user', content: 'tetris' })
    addBlueprintMessage(db, { conversationId: live.id, role: 'assistant', content: 'plan' })
    saveBlueprintSnapshot(db, live.id, { blueprint: { ...bp, product: { ...bp.product, name: 'WebTetris' } }, rawBlueprint: bp })
    const rejected = createBlueprintConversation(db)
    addBlueprintMessage(db, { conversationId: rejected.id, role: 'assistant', content: 'oops' })
    saveBlueprintSnapshotIssue(db, rejected.id, { reason: 'truncated', detail: 'cut', at: 'now' })

    const list = listResumableBlueprintConversations(db)
    expect(list.map((c) => c.id)).not.toContain(empty.id)
    expect(list.map((c) => c.id)).not.toContain(userOnly.id)
    expect(list.map((c) => c.id)).not.toContain(committed.id)
    expect(list.map((c) => c.id)).toEqual(expect.arrayContaining([live.id, rejected.id]))
    const tetris = list.find((c) => c.id === live.id)!
    expect(tetris).toEqual(expect.objectContaining({
      title: 'Tetris', productName: 'WebTetris', platform: 'web', specCount: 0, specsComplete: false,
      dimensionsFilled: 5, messageCount: 2, hasSnapshot: true, pendingIssue: null,
    }))
    expect(list.find((c) => c.id === rejected.id)).toEqual(expect.objectContaining({ hasSnapshot: false, pendingIssue: 'truncated' }))
  })

  it('markBlueprintCommitted links the project id', async () => {
    const { markBlueprintCommitted } = await import('./blueprint-store')
    const conv = createBlueprintConversation(db)
    markBlueprintCommitted(db, conv.id, 'proj-42')
    expect(getBlueprintConversation(db, conv.id)?.committed_project_id).toBe('proj-42')
  })
})
