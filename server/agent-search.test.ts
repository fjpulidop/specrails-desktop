import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb, rebuildAgentSearchIndex } from './desktop-db'
import type { DbInstance } from './db'
import {
  addAgentMessage,
  createAgentConversation,
  deleteAgentConversation,
  deleteAgentMessagesByIds,
  foldSearchText,
  searchAgentConversations,
  updateAgentConversation,
  updateAgentMessageContent,
  MISSION_SEARCH_MAX_LIMIT,
} from './agent-store'
import { createAgentChatRouter } from './agent-chat-router'
import type { AgentChatManager } from './agent-chat-manager'

let db: DbInstance

beforeEach(() => {
  db = initDesktopDb(':memory:')
})

afterEach(() => {
  db.close()
})

function conversation(title: string | null, opts: { pinnedProjectId?: string | null } = {}) {
  const c = createAgentConversation(db, { provider: 'claude', pinnedProjectId: opts.pinnedProjectId ?? null })
  if (title !== null) updateAgentConversation(db, c.id, { title })
  return c
}

function ftsRows(): number {
  return (db.prepare('SELECT count(*) AS c FROM agent_messages_fts').get() as { c: number }).c
}

describe('foldSearchText', () => {
  it('lowercases and strips diacritics', () => {
    expect(foldSearchText('Revisar la MISIÓN de déploy')).toBe('revisar la mision de deploy')
  })
})

describe('mission search index', () => {
  it('follows inserts, content updates and deletes through the triggers', () => {
    const c = conversation('Some mission')
    expect(searchAgentConversations(db, 'gravity flip')).toEqual([])

    const m = addAgentMessage(db, { conversationId: c.id, role: 'assistant', content: 'we should add a gravity flip power-up' })
    expect(ftsRows()).toBe(1)
    expect(searchAgentConversations(db, 'gravity flip').map((h) => h.conversation.id)).toEqual([c.id])

    updateAgentMessageContent(db, m.id, 'we should add a wall kick instead')
    expect(ftsRows()).toBe(1)
    expect(searchAgentConversations(db, 'gravity flip')).toEqual([])
    expect(searchAgentConversations(db, 'wall kick').map((h) => h.messageId)).toEqual([m.id])

    deleteAgentMessagesByIds(db, [m.id])
    expect(ftsRows()).toBe(0)
    expect(searchAgentConversations(db, 'wall kick')).toEqual([])
  })

  it('drops index rows when the owning conversation is deleted (cascade)', () => {
    const c = conversation('Doomed')
    addAgentMessage(db, { conversationId: c.id, role: 'user', content: 'ephemeral content here' })
    expect(ftsRows()).toBe(1)
    deleteAgentConversation(db, c.id)
    expect(ftsRows()).toBe(0)
    expect(searchAgentConversations(db, 'ephemeral')).toEqual([])
  })

  it('rebuildAgentSearchIndex re-derives the index from agent_messages', () => {
    const c = conversation('Rebuilt')
    addAgentMessage(db, { conversationId: c.id, role: 'user', content: 'needle in the haystack' })
    db.exec('DELETE FROM agent_messages_fts')
    expect(searchAgentConversations(db, 'haystack')).toEqual([])
    rebuildAgentSearchIndex(db)
    expect(searchAgentConversations(db, 'haystack').map((h) => h.conversation.id)).toEqual([c.id])
  })
})

describe('searchAgentConversations', () => {
  it('returns [] for a blank query', () => {
    conversation('Anything')
    expect(searchAgentConversations(db, '   ')).toEqual([])
  })

  it('matches a mid-word content fragment and returns a highlighted snippet', () => {
    const c = conversation('Weekly sync')
    const m = addAgentMessage(db, {
      conversationId: c.id,
      role: 'assistant',
      content: 'I looked into the Tetris scoring bug and the multiplier resets one line too early.',
    })
    const [hit] = searchAgentConversations(db, 'etris')
    expect(hit.conversation.id).toBe(c.id)
    expect(hit.match).toBe('content')
    expect(hit.messageId).toBe(m.id)
    expect(hit.snippet).not.toBeNull()
    const { text, ranges } = hit.snippet!
    expect(text).toContain('Tetris scoring bug')
    expect(ranges.length).toBeGreaterThan(0)
    const [start, end] = ranges[0]
    expect(text.slice(start, end).toLowerCase()).toContain('etris')
    // Markers never leak into the plain text.
    expect(text).not.toMatch(/[\u0001\u0002]/)
  })

  it('folds diacritics in both directions for titles and content', () => {
    const titled = conversation('Revisar la misión de deploy')
    const bodied = conversation('Other')
    addAgentMessage(db, { conversationId: bodied.id, role: 'user', content: 'hablemos de la configuración del pipeline' })

    expect(searchAgentConversations(db, 'mision').map((h) => [h.conversation.id, h.match])).toEqual([[titled.id, 'title']])
    expect(searchAgentConversations(db, 'MISIÓN').map((h) => h.conversation.id)).toEqual([titled.id])
    expect(searchAgentConversations(db, 'configuracion').map((h) => h.conversation.id)).toEqual([bodied.id])
    expect(searchAgentConversations(db, 'configuración').map((h) => h.conversation.id)).toEqual([bodied.id])
  })

  it('never matches system rows (PR-decision envelopes)', () => {
    const c = conversation('Ship it')
    addAgentMessage(db, {
      conversationId: c.id,
      role: 'system',
      content: '{"kind":"pr_decision","prDeliveryId":"cde4450d-cf81-4cb2-a481-a2d82687f5a2","projectId":"51633d2d"}',
    })
    expect(searchAgentConversations(db, 'cde4450d')).toEqual([])
    expect(searchAgentConversations(db, 'prDeliveryId')).toEqual([])
    expect(searchAgentConversations(db, 'cd')).toEqual([])
  })

  it('ranks title matches before content matches and keeps one row per mission', () => {
    const byContent = conversation('Unrelated title')
    addAgentMessage(db, { conversationId: byContent.id, role: 'user', content: 'first tetris question' })
    addAgentMessage(db, { conversationId: byContent.id, role: 'assistant', content: 'second tetris answer with more tetris words' })
    // Created later → newer updated_at, but still ranks below the title hit.
    const byTitle = conversation('Tetris rewrite')

    const hits = searchAgentConversations(db, 'tetris')
    expect(hits.map((h) => [h.conversation.id, h.match])).toEqual([
      [byTitle.id, 'title'],
      [byContent.id, 'content'],
    ])
    expect(hits[0].snippet).toBeNull()
    expect(hits[1].snippet?.text).toContain('tetris')
  })

  it('attaches the content snippet to a title hit that also matches by content', () => {
    const c = conversation('Tetris rewrite')
    const m = addAgentMessage(db, { conversationId: c.id, role: 'assistant', content: 'the tetris board is 10 by 20' })
    const [hit] = searchAgentConversations(db, 'tetris')
    expect(hit.match).toBe('title')
    expect(hit.messageId).toBe(m.id)
    expect(hit.snippet?.text).toContain('tetris board')
  })

  it('answers short queries through the substring fallback', () => {
    const c = conversation('Short')
    const m = addAgentMessage(db, { conversationId: c.id, role: 'user', content: 'run npx vitest --ui please' })
    const [hit] = searchAgentConversations(db, 'ui')
    expect(hit.conversation.id).toBe(c.id)
    expect(hit.match).toBe('content')
    expect(hit.messageId).toBe(m.id)
    expect(hit.snippet?.text).toContain('--ui')
    const [start, end] = hit.snippet!.ranges[0]
    expect(hit.snippet!.text.slice(start, end)).toBe('ui')
    // LIKE wildcards are escaped, not interpreted.
    expect(searchAgentConversations(db, '%')).toEqual([])
  })

  it('treats FTS operators in the query as literal text', () => {
    const c = conversation('Ops')
    addAgentMessage(db, { conversationId: c.id, role: 'user', content: 'what does "foo AND bar" mean here?' })
    expect(searchAgentConversations(db, 'foo AND bar').map((h) => h.conversation.id)).toEqual([c.id])
    expect(searchAgentConversations(db, '"foo')).toHaveLength(1)
    expect(() => searchAgentConversations(db, 'NOT (')).not.toThrow()
  })

  it('caps results at the requested limit and the hard maximum', () => {
    for (let i = 0; i < 5; i++) {
      const c = conversation(`Alpha mission ${i}`)
      addAgentMessage(db, { conversationId: c.id, role: 'user', content: `alpha body ${i}` })
    }
    expect(searchAgentConversations(db, 'alpha', 2)).toHaveLength(2)
    expect(searchAgentConversations(db, 'alpha', 0)).toHaveLength(1)
    expect(searchAgentConversations(db, 'alpha', 10_000)).toHaveLength(5)
    expect(MISSION_SEARCH_MAX_LIMIT).toBe(50)
  })
})

describe('GET /api/agent/search', () => {
  function app() {
    const a = express()
    a.use(express.json())
    a.use('/api/agent', createAgentChatRouter({
      manager: {} as unknown as AgentChatManager,
      desktopDb: db,
    }))
    return a
  }

  it('rejects a missing or blank q', async () => {
    expect((await request(app()).get('/api/agent/search')).status).toBe(400)
    expect((await request(app()).get('/api/agent/search?q=%20%20')).status).toBe(400)
  })

  it('returns ranked hits and clamps limit', async () => {
    const c = conversation('Tetris rewrite')
    addAgentMessage(db, { conversationId: c.id, role: 'assistant', content: 'tetris board is 10 by 20' })
    for (let i = 0; i < 3; i++) {
      const other = conversation(`Other ${i}`)
      addAgentMessage(db, { conversationId: other.id, role: 'user', content: `tetris note ${i}` })
    }

    const res = await request(app()).get('/api/agent/search?q=tetris')
    expect(res.status).toBe(200)
    expect(res.body.results).toHaveLength(4)
    expect(res.body.results[0]).toMatchObject({ match: 'title', conversation: { id: c.id } })
    expect(res.body.results[0].snippet.ranges[0]).toHaveLength(2)

    const limited = await request(app()).get('/api/agent/search?q=tetris&limit=2')
    expect(limited.body.results).toHaveLength(2)

    const junk = await request(app()).get('/api/agent/search?q=tetris&limit=abc')
    expect(junk.status).toBe(200)
    expect(junk.body.results).toHaveLength(4)
  })
})
