import { describe, it, expect, beforeEach } from 'vitest'
import { initDesktopDb } from '../../../desktop-db'
import {
  archiveAgentConversation,
  listAgentConversations,
  softDeleteAgentConversation,
} from '../../agents/runtime/agent-store'
import { ensureMissionPlaceholderConversation } from './mission-placeholder'

const input = { projectId: 'p1', provider: 'claude', model: null, tierLevel: 0 as const, reasoningEffort: null }

let db: ReturnType<typeof initDesktopDb>
beforeEach(() => {
  db = initDesktopDb(':memory:')
})

const rowCount = (projectId: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM agent_conversations WHERE pinned_project_id = ?').get(projectId) as { n: number }).n

describe('ensureMissionPlaceholderConversation', () => {
  it('[spec:project-bootstrap-commit/placeholder-mission-conversation-on-first-commit] creates one empty conversation pinned to the project', () => {
    const result = ensureMissionPlaceholderConversation(db, { ...input, provider: 'codex' })

    expect(result.status).toBe('created')
    const [conversation] = listAgentConversations(db)
    expect(conversation).toMatchObject({ id: result.conversationId, pinned_project_id: 'p1', provider: 'codex', tier_level: 0 })
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n).toBe(0)
  })

  it('[spec:project-bootstrap-commit/placeholder-is-created-once-per-project] skips on a second call', () => {
    ensureMissionPlaceholderConversation(db, input)

    expect(ensureMissionPlaceholderConversation(db, input)).toEqual({ status: 'skipped', conversationId: null })
    expect(rowCount('p1')).toBe(1)
  })

  it('[spec:project-bootstrap-commit/placeholder-is-created-once-per-project] does not recreate a soft-deleted placeholder', () => {
    const { conversationId } = ensureMissionPlaceholderConversation(db, input)
    softDeleteAgentConversation(db, conversationId!)

    expect(ensureMissionPlaceholderConversation(db, input).status).toBe('skipped')
    expect(rowCount('p1')).toBe(1)
  })

  it('does not recreate an archived placeholder', () => {
    const { conversationId } = ensureMissionPlaceholderConversation(db, input)
    archiveAgentConversation(db, conversationId!)

    expect(ensureMissionPlaceholderConversation(db, input).status).toBe('skipped')
    expect(rowCount('p1')).toBe(1)
  })

  it('is not affected by conversations of other projects', () => {
    ensureMissionPlaceholderConversation(db, { ...input, projectId: 'other' })

    expect(ensureMissionPlaceholderConversation(db, input).status).toBe('created')
    expect(rowCount('other')).toBe(1)
  })
})
