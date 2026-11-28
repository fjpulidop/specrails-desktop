import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initDesktopDb } from '../../../desktop-db'
import { addAgentMessage, createAgentConversation } from '../../agents/runtime/agent-store'

const rows = vi.hoisted(() => new Map<string, { conversationId: string; row: Record<string, unknown> }>())
vi.mock('./agent-chat-registry', () => ({
  getAgentChatManager: () => ({
    upsertSystemRow: (conversationId: string, row: Record<string, unknown>, key: string) => { rows.set(key, { conversationId, row }); return key },
  }),
}))

import { isTodoTool, latestMissionPlan, normalizePlan, planFromTodoWrite, publishMissionPlan } from './mission-plan'

beforeEach(() => { rows.clear() })

describe('mission plan', () => {
  it('normalizes loose steps: text fields, status spellings, empty steps dropped, long text clipped', () => {
    expect(normalizePlan({ title: '  Login  ', steps: [{ content: 'Add the form', status: 'done' }, { step: 'Validate', status: 'in-progress' }, { text: '' }, 'Write tests'] })).toEqual({
      title: 'Login',
      steps: [{ content: 'Add the form', status: 'completed' }, { content: 'Validate', status: 'in_progress' }, { content: 'Write tests', status: 'pending' }],
    })
    expect(normalizePlan({ steps: [] })).toBeNull()
    expect(normalizePlan({ steps: [{ content: 'x'.repeat(500) }] })!.steps[0]!.content).toHaveLength(240)
  })

  it('[spec:mission-plan/todo-tool] reads Claude\'s TodoWrite list (object or JSON text) as the plan', () => {
    const input = { todos: [{ content: 'Read the screen', status: 'completed', activeForm: 'Reading' }, { content: 'Add the button', status: 'in_progress', activeForm: 'Adding' }] }
    expect(isTodoTool('TodoWrite')).toBe(true)
    expect(isTodoTool('Write')).toBe(false)
    expect(planFromTodoWrite(input)?.steps).toEqual([{ content: 'Read the screen', status: 'completed' }, { content: 'Add the button', status: 'in_progress' }])
    expect(planFromTodoWrite(JSON.stringify(input))?.steps).toHaveLength(2)
    // A preview cut short is not a plan.
    expect(planFromTodoWrite('{"todos":[{"content":"Read the scr')).toBeNull()
  })

  it('[spec:mission-plan/progress] updates the same work in place and opens a new row for new work or after it was finished', () => {
    const step = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({ content, status })
    publishMissionPlan('c1', { title: 'Login', steps: [step('Form', 'in_progress'), step('Tests', 'pending')] }, 'specrails')
    publishMissionPlan('c1', { title: null, steps: [step('Form', 'completed'), step('Tests', 'in_progress')] }, 'specrails')
    expect(rows.size).toBe(1)
    const [first] = [...rows.values()]
    expect(first!.row).toMatchObject({ kind: 'mission-plan', title: 'Login', source: 'specrails', steps: [step('Form', 'completed'), step('Tests', 'in_progress')] })
    publishMissionPlan('c1', { title: null, steps: [step('Form', 'completed'), step('Tests', 'completed')] }, 'specrails')
    expect(rows.size).toBe(1)
    // Finished: the next plan is a new row (the history keeps the old one).
    publishMissionPlan('c1', { title: 'Dark mode', steps: [step('Theme', 'pending')] }, 'todo-tool')
    expect(rows.size).toBe(2)
    // Different work while unfinished: also a new row. Another mission never shares a row.
    publishMissionPlan('c1', { title: null, steps: [step('Unrelated', 'pending')] }, 'todo-tool')
    publishMissionPlan('c2', { title: null, steps: [step('Theme', 'pending')] }, 'todo-tool')
    expect(rows.size).toBe(4)
  })

  it('reads the latest plan of a mission from its rows', () => {
    const db = initDesktopDb(':memory:')
    const conversation = createAgentConversation(db, {})
    expect(latestMissionPlan(db, conversation.id)).toBeNull()
    addAgentMessage(db, { conversationId: conversation.id, role: 'system', content: JSON.stringify({ kind: 'mission-plan', title: 'Old', steps: [{ content: 'A', status: 'completed' }], source: 'specrails', at: '1' }) })
    addAgentMessage(db, { conversationId: conversation.id, role: 'system', content: JSON.stringify({ kind: 'other' }) })
    addAgentMessage(db, { conversationId: conversation.id, role: 'system', content: JSON.stringify({ kind: 'mission-plan', title: null, steps: [{ content: 'B', status: 'in_progress' }], source: 'todo-tool', at: '2' }) })
    expect(latestMissionPlan(db, conversation.id)).toEqual({ kind: 'mission-plan', title: null, steps: [{ content: 'B', status: 'in_progress' }], source: 'todo-tool', at: '2' })
  })
})
