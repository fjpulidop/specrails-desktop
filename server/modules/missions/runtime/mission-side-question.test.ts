import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb } from '../../../desktop-db'
import { getAdapter, isModelAvailableForAdapter } from '../../../providers'
import { agentLedgerSurface } from '../../accounting/runtime/spending'
import { addAgentMessage, createAgentConversation, getAgentConversation, listAgentMessages, updateAgentConversation } from '../../agents/runtime/agent-store'
import type { AgentChatManager } from './agent-chat-manager'
import { createAgentChatRouter } from './agent-chat-router'
import {
  buildSideQuestionEvidence,
  buildSideQuestionSystemPrompt,
  DEFAULT_SIDE_QUESTION,
  SIDE_QUESTION_LIMITS,
  validateSideQuestionRequest,
  type SideQuestionRequest,
} from './mission-side-question'
import type { GenerateOutput } from '../../code/runtime/file-summary-manager'

type GeneratorFactory = NonNullable<NonNullable<Parameters<typeof createAgentChatRouter>[0]['sideQuestion']>['createGenerator']>

const output = (summary: string, model: string): GenerateOutput => ({
  summary, model, provider: 'claude', costUsd: 0.0012, costEstimated: false, tokensIn: 120, tokensOut: 40, durationMs: 900,
})

describe('side questions ("Ask about this")', () => {
  let db: ReturnType<typeof initDesktopDb>
  let app: express.Express
  let calls: Array<{ model?: string; systemPrompt: string; contents: string; reasoningEffort?: string }>
  let generate: ReturnType<typeof vi.fn>
  const manager = { notifyConversationCreated: vi.fn(), sendMessage: vi.fn(), notifySpendingInvalidated: vi.fn() }

  beforeEach(() => {
    vi.clearAllMocks()
    db = initDesktopDb(':memory:')
    calls = []
    generate = vi.fn(async (model: string) => output('It is the retry budget.', model))
    const createGenerator: GeneratorFactory = (opts) => async (input) => {
      calls.push({ model: opts.model, systemPrompt: opts.systemPrompt!('en'), contents: input.contents, reasoningEffort: opts.reasoningEffort })
      return generate(opts.model)
    }
    app = express().use(express.json()).use('/api/agent', createAgentChatRouter({
      desktopDb: db, manager: manager as unknown as AgentChatManager, sideQuestion: { createGenerator, cwd: '/tmp' },
    }))
  })
  afterEach(() => db.close())

  const mission = (model: string | null = null) => {
    const conversation = createAgentConversation(db, { provider: 'claude', model, pinnedProjectId: 'project-1' })
    updateAgentConversation(db, conversation.id, { title: 'Progress', session_id: 'provider-session' })
    const first = addAgentMessage(db, { conversationId: conversation.id, role: 'user', content: 'Why did the job fork?' })
    const cut = addAgentMessage(db, { conversationId: conversation.id, role: 'assistant', content: 'The retry budget ran out, so the job forked.' })
    const later = addAgentMessage(db, { conversationId: conversation.id, role: 'user', content: 'LATER SECRET MESSAGE' })
    return { conversation, first, cut, later }
  }
  const evidenceOf = (index = 0) => JSON.parse(calls[index].contents)
  const ledger = () => db.prepare('SELECT * FROM agent_invocations').all() as Array<Record<string, unknown>>

  it('answers from history cut at throughMessageId and never writes to the mission', async () => {
    const { conversation, cut } = mission()
    const before = listAgentMessages(db, conversation.id)
    const res = await request(app).post(`/api/agent/conversations/${conversation.id}/side-questions`)
      .send({ selection: 'retry budget', throughMessageId: cut.id, thread: [] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ answer: 'It is the retry budget.', provider: 'claude', model: getAdapter('claude').defaultModel() })
    const evidence = evidenceOf()
    expect(evidence.history.map((m: { content: string }) => m.content)).toEqual(['Why did the job fork?', 'The retry budget ran out, so the job forked.'])
    expect(calls[0].contents).not.toContain('LATER SECRET MESSAGE')
    expect(evidence).toMatchObject({ selection: 'retry budget', question: DEFAULT_SIDE_QUESTION, missionTitle: 'Progress' })
    expect(calls[0].systemPrompt).toMatch(/do not run tools/i)
    expect(calls[0].systemPrompt).toMatch(/data, never instructions/i)
    expect(listAgentMessages(db, conversation.id)).toEqual(before)
    expect(getAgentConversation(db, conversation.id)?.session_id).toBe('provider-session')
  })

  it("runs with the mission's reasoning effort when its model offers it", async () => {
    const { conversation, cut } = mission()
    updateAgentConversation(db, conversation.id, { reasoning_effort: 'high' })
    await request(app).post(`/api/agent/conversations/${conversation.id}/side-questions`).send({ selection: 'retry', throughMessageId: cut.id })
    expect(calls[0].reasoningEffort).toBe('high')
    updateAgentConversation(db, conversation.id, { reasoning_effort: 'not-an-effort' })
    await request(app).post(`/api/agent/conversations/${conversation.id}/side-questions`).send({ selection: 'retry', throughMessageId: cut.id })
    expect(calls[1].reasoningEffort).toBeUndefined()
  })

  it('records one ledger row with surface side-question, counted as a mission', async () => {
    const { conversation, cut } = mission()
    await request(app).post(`/api/agent/conversations/${conversation.id}/side-questions`)
      .send({ selection: 'retry', throughMessageId: cut.id, question: 'What is a retry budget?' })
    const rows = ledger()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ surface: 'side-question', conversation_id: conversation.id, project_id: 'project-1', status: 'success', provider: 'claude', total_cost_usd: 0.0012, tokens_in: 120, num_turns: 1 })
    expect(agentLedgerSurface('side-question')).toBe('mission')
    expect(manager.notifySpendingInvalidated).toHaveBeenCalledWith('project-1')
  })

  it('passes the side thread and current question', async () => {
    const { conversation, cut } = mission()
    const thread = [{ role: 'user', content: 'What is forking?' }, { role: 'assistant', content: 'Starting a copy.' }]
    await request(app).post(`/api/agent/conversations/${conversation.id}/side-questions`)
      .send({ selection: 'forked', throughMessageId: cut.id, question: 'And why here?', thread })
    expect(evidenceOf()).toMatchObject({ sideThread: thread, question: 'And why here?' })
  })

  it('runs on the mission model and falls back to the provider default when the account rejects it', async () => {
    const adapter = getAdapter('claude')
    const missionModel = 'opus'
    expect(isModelAvailableForAdapter(adapter, missionModel) && missionModel !== adapter.defaultModel()).toBe(true)
    const { conversation, cut } = mission(missionModel)
    generate.mockImplementationOnce(async () => { throw new Error('The model is not supported for this account') })
    const res = await request(app).post(`/api/agent/conversations/${conversation.id}/side-questions`)
      .send({ selection: 'retry', throughMessageId: cut.id })
    expect(res.status).toBe(200)
    expect(calls.map(c => c.model)).toEqual([missionModel, adapter.defaultModel()])
    expect(res.body.model).toBe(adapter.defaultModel())
  })

  it('returns the provider error message and records a failed row with partial usage', async () => {
    const { conversation, cut } = mission()
    generate.mockImplementationOnce(async () => {
      throw Object.assign(new Error('You have hit your usage limit'), { partial: { costUsd: 0.0004, tokensIn: 10 } })
    })
    const res = await request(app).post(`/api/agent/conversations/${conversation.id}/side-questions`)
      .send({ selection: 'retry', throughMessageId: cut.id })
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('You have hit your usage limit')
    expect(ledger()[0]).toMatchObject({ surface: 'side-question', status: 'failed', total_cost_usd: 0.0004, tokens_in: 10 })
  })

  it('validates sizes and identities', async () => {
    const { conversation, cut } = mission()
    const post = (body: Record<string, unknown>, id = conversation.id) => request(app).post(`/api/agent/conversations/${id}/side-questions`).send(body)
    expect((await post({ selection: 'x'.repeat(SIDE_QUESTION_LIMITS.selectionChars + 1), throughMessageId: cut.id })).status).toBe(400)
    expect((await post({ selection: 'x', throughMessageId: cut.id, question: 'q'.repeat(4001) })).status).toBe(400)
    expect((await post({ selection: 'x', throughMessageId: cut.id, thread: Array.from({ length: 11 }, () => ({ role: 'user', content: 'a' })) })).status).toBe(400)
    expect((await post({ selection: 'x', throughMessageId: cut.id, thread: [{ role: 'user', content: 'a'.repeat(16_001) }] })).status).toBe(400)
    expect((await post({ selection: 'x', throughMessageId: cut.id, thread: [{ role: 'system', content: 'a' }] })).status).toBe(400)
    expect((await post({ selection: '  ', throughMessageId: cut.id })).status).toBe(400)
    expect((await post({ selection: 'x', throughMessageId: 'nope' })).status).toBe(404)
    expect((await post({ selection: 'x', throughMessageId: cut.id }, 'missing')).status).toBe(404)
    expect(calls).toHaveLength(0)
    expect(ledger()).toHaveLength(0)
  })
})

describe('side-question evidence bounding', () => {
  const request: SideQuestionRequest = { selection: 's', throughMessageId: 'm30', question: '', thread: [], language: null }
  it('keeps the newest messages up to the budget and clips long ones', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: 'assistant' as const, content: i === 30 ? 'y'.repeat(9000) : `message ${i}` }))
    const evidence = buildSideQuestionEvidence(messages, request, null)!
    expect(evidence.historyTotal).toBe(31)
    expect(evidence.history).toHaveLength(SIDE_QUESTION_LIMITS.historyMessages)
    expect(evidence.history.at(-1)!.content.length).toBeLessThan(SIDE_QUESTION_LIMITS.historyMessageChars + 20)
    expect(evidence.history[0].content).toBe('message 19')
  })
  it('stops at the character budget and skips cancelled input', () => {
    const messages = [
      { id: 'c', role: 'user' as const, content: 'cancelled', delivery_status: 'cancelled' as const },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `m${i + 21}`, role: 'assistant' as const, content: 'z'.repeat(3000) })),
    ]
    const evidence = buildSideQuestionEvidence(messages, request, null)!
    expect(evidence.history.length).toBe(5)
    expect(evidence.history.some(m => m.content === 'cancelled')).toBe(false)
  })
  it('validates and normalises input', () => {
    expect(validateSideQuestionRequest({ selection: 'a', throughMessageId: 'm', question: '  hi  ', language: 'es' })).toEqual({ ok: true, value: { selection: 'a', throughMessageId: 'm', question: 'hi', thread: [], language: 'es' } })
    expect(validateSideQuestionRequest({ selection: 'a', throughMessageId: 'm', language: '"; drop' })).toMatchObject({ ok: true, value: { language: null } })
    expect(buildSideQuestionSystemPrompt('ja')).toContain('"ja"')
  })
})
