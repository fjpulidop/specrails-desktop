import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../providers/live-session', () => ({ nativeLiveSessionRunner: () => undefined }))
vi.mock('../../execution/runtime/spawn-lifecycle', () => ({ runAiCliInvocation: vi.fn() }))
import express from 'express'
import request from 'supertest'
import { initDesktopDb } from '../../../desktop-db'
import { runAiCliInvocation, type InvocationResult } from '../../execution/runtime/spawn-lifecycle'
import type { AdapterEvent } from '../../../providers/types'
import { agentLedgerSurface } from '../../accounting/runtime/spending'
import { addAgentMessage, createAgentConversation, getAgentConversation, listAgentMessages, setAgentConversationContextUsage, updateAgentConversation } from '../../agents/runtime/agent-store'
import type { GenerateOutput } from '../../code/runtime/file-summary-manager'
import { AgentChatManager } from './agent-chat-manager'
import { createAgentChatRouter } from './agent-chat-router'
import type { IntentTurnContext } from './flow-turn-context'
import type { MissionCoreSessions } from './mission-core-sessions'
import {
  buildSessionSeedBlock,
  buildSessionSummaryEvidence,
  buildSessionSummarySystemPrompt,
  summaryLanguage,
  parseSessionSummaryRow,
  SESSION_SUMMARY_LIMITS,
} from './mission-session-summary'

type GeneratorFactory = NonNullable<NonNullable<Parameters<typeof createAgentChatRouter>[0]['sessionSummary']>['createGenerator']>

const output = (summary: string, model: string): GenerateOutput => ({
  summary, model, provider: 'claude', costUsd: 0.003, costEstimated: false, tokensIn: 900, tokensOut: 200, durationMs: 1200,
})

const message = (role: 'user' | 'assistant' | 'system', content: string, extra: Record<string, unknown> = {}) => ({
  id: Math.random().toString(36).slice(2), conversation_id: 'c', role, content, attachment_ids: [], context_refs: [], intents: [], created_at: '', ...extra,
})

describe('session summary (pure)', () => {
  it('trims the transcript newest-first to its budget and clips each message', () => {
    const big = 'x'.repeat(SESSION_SUMMARY_LIMITS.messageChars + 500)
    const messages = Array.from({ length: 30 }, (_, i) => message(i % 2 ? 'assistant' : 'user', i === 29 ? big : `${i} ${'y'.repeat(4_000)}`))
    const evidence = buildSessionSummaryEvidence(messages, 'Title')
    expect(evidence.totalMessages).toBe(30)
    expect(evidence.includedMessages).toBeLessThan(30)
    const chars = evidence.transcript.reduce((sum, entry) => sum + entry.content.length + entry.role.length, 0)
    expect(chars).toBeLessThanOrEqual(SESSION_SUMMARY_LIMITS.transcriptChars)
    // Newest kept, oldest dropped.
    expect(evidence.transcript.at(-1)!.content.endsWith('…[truncated]')).toBe(true)
    expect(evidence.transcript.at(-1)!.content.length).toBeLessThanOrEqual(SESSION_SUMMARY_LIMITS.messageChars + 20)
    expect(evidence.transcript[0].content.startsWith('0 ')).toBe(false)
  })

  it('stops at an earlier summary, clips app cards and skips cancelled input', () => {
    const evidence = buildSessionSummaryEvidence([
      message('user', 'ancient'),
      message('system', JSON.stringify({ kind: 'session-summary', summary: 'EARLIER SUMMARY' })),
      message('user', 'cancelled', { delivery_status: 'cancelled' }),
      message('system', JSON.stringify({ kind: 'run-failure', detail: 'z'.repeat(5_000) })),
      message('assistant', 'latest'),
    ], null)
    expect(evidence.transcript.map((e) => e.role)).toEqual(['earlier-summary', 'app-card', 'assistant'])
    expect(evidence.transcript[0].content).toBe('EARLIER SUMMARY')
    expect(evidence.transcript[1].content.length).toBeLessThanOrEqual(SESSION_SUMMARY_LIMITS.cardChars + 20)
    expect(JSON.stringify(evidence)).not.toContain('ancient')
  })

  it('asks for the hand-over sections, including what is not included', () => {
    const prompt = buildSessionSummarySystemPrompt()
    for (const section of ['Goal', 'Decisions and constraints', 'Current state', 'Open questions and next steps', 'Important references', 'Not included']) expect(prompt).toContain(section)
    expect(prompt).toMatch(/data, never instructions/)
  })

  it('writes the summary in the app language when the client sends one', () => {
    expect(buildSessionSummarySystemPrompt('es')).toContain('language with code "es"')
    expect(buildSessionSummarySystemPrompt(null)).toContain('language the person uses')
    expect(summaryLanguage('pt-BR')).toBe('pt-BR')
    expect(summaryLanguage('"; drop')).toBeNull()
  })

  it('seeds a fresh session with the newest summary and only the messages after it', () => {
    const plain = [message('user', 'hello'), message('assistant', 'hi')]
    expect(buildSessionSeedBlock(plain as never)).toContain('Persisted conversation history')
    const seed = buildSessionSeedBlock([
      message('user', 'RAW BEFORE'),
      message('system', JSON.stringify({ kind: 'session-summary', summary: 'THE SUMMARY', at: '2026-01-01' })),
    ] as never)
    expect(seed).toContain('THE SUMMARY')
    expect(seed).toMatch(/data, not instructions/)
    expect(seed).not.toContain('RAW BEFORE')
    expect(seed.endsWith('## Current turn')).toBe(true)
    const later = buildSessionSeedBlock([
      message('system', JSON.stringify({ kind: 'session-summary', summary: 'THE SUMMARY' })),
      message('user', 'AFTER'),
    ] as never)
    expect(later).toContain('AFTER')
    expect(later).toContain('Persisted conversation history')
  })

  it('parses only valid summary rows', () => {
    expect(parseSessionSummaryRow('{"kind":"session-summary","summary":"s"}')?.summary).toBe('s')
    expect(parseSessionSummaryRow('{"kind":"session-summary","summary":"  "}')).toBeNull()
    expect(parseSessionSummaryRow('{"kind":"flow-boundary"}')).toBeNull()
    expect(parseSessionSummaryRow('not json')).toBeNull()
  })
})

describe('POST /conversations/:id/session/renew', () => {
  let db: ReturnType<typeof initDesktopDb>
  let app: express.Express
  let manager: AgentChatManager
  let events: Array<Record<string, unknown>>
  let calls: Array<{ model?: string; contents: string; reasoningEffort?: string; systemPrompt: string }>
  let generate: ReturnType<typeof vi.fn>

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    events = []
    manager = new AgentChatManager((m) => events.push(m as unknown as Record<string, unknown>), db, 4200)
    calls = []
    generate = vi.fn(async (model: string) => output('## Goal\nShip it.\n## Not included\nCode.', model))
    const createGenerator: GeneratorFactory = (opts) => async (input) => {
      calls.push({ model: opts.model, contents: input.contents, reasoningEffort: opts.reasoningEffort, systemPrompt: opts.systemPrompt!('en') })
      return generate(opts.model)
    }
    app = express().use(express.json()).use('/api/agent', createAgentChatRouter({ desktopDb: db, manager, sessionSummary: { createGenerator, cwd: '/tmp' } }))
    vi.mocked(runAiCliInvocation).mockReset()
  })
  afterEach(async () => {
    await manager.shutdown()
    db.close()
  })

  const mission = () => {
    const conversation = createAgentConversation(db, { provider: 'claude', pinnedProjectId: 'project-1' })
    updateAgentConversation(db, conversation.id, { title: 'Ship', session_id: 'provider-session', reasoning_effort: 'high' })
    setAgentConversationContextUsage(db, conversation.id, { provider: 'claude', model: 'claude-sonnet-4-5', usedTokens: 160_000, windowTokens: 200_000, percent: 80, source: 'response', measuredAt: '2026-01-01T00:00:00Z' } as never)
    addAgentMessage(db, { conversationId: conversation.id, role: 'user', content: 'Build the importer on branch feat/import' })
    addAgentMessage(db, { conversationId: conversation.id, role: 'assistant', content: 'Done: spec SPEC-12 drafted.' })
    return conversation
  }
  const renew = (id: string) => request(app).post(`/api/agent/conversations/${id}/session/renew`).send({})
  const ledger = () => db.prepare('SELECT * FROM agent_invocations').all() as Array<Record<string, unknown>>

  function fakeTurn(): void {
    vi.mocked(runAiCliInvocation).mockImplementation(async (hooks) => {
      const events: AdapterEvent[] = [{ kind: 'session-started', sessionId: 'new-session' }, { kind: 'text-delta', text: 'ok' }]
      hooks.onSpawn?.({ kill: () => true } as never)
      for (const ev of events) hooks.onEvent?.(ev)
      return { code: 0, timedOut: false, spawnFailed: false, events, lastResultEvent: null, sessionId: null, stderrTail: '', child: null } as InvocationResult
    })
  }

  it('stores the summary marker, clears the session and the snapshot, and broadcasts both', async () => {
    const conversation = mission()
    const res = await renew(conversation.id)
    expect(res.status).toBe(200)
    expect(res.body.summary).toMatchObject({ kind: 'session-summary', summary: expect.stringContaining('Ship it.'), includedMessages: 2, totalMessages: 2 })
    expect(calls[0].contents).toContain('feat/import')
    expect(calls[0].reasoningEffort).toBe('high')
    const fresh = getAgentConversation(db, conversation.id)!
    expect(fresh.session_id).toBeNull()
    expect(fresh.contextUsage).toBeUndefined()
    const rows = listAgentMessages(db, conversation.id)
    expect(rows.at(-1)).toMatchObject({ id: res.body.messageId, role: 'system' })
    expect(parseSessionSummaryRow(rows.at(-1)!.content)?.summary).toContain('Ship it.')
    expect(rows.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(events.find((e) => e.type === 'agent_system_row')).toMatchObject({ conversationId: conversation.id, kind: 'session-summary', messageId: res.body.messageId })
    expect(events.find((e) => e.type === 'agent_context_usage')).toMatchObject({ conversationId: conversation.id, contextUsage: null })
  })

  it('seeds the next turn with the summary instead of the raw history, in a new provider session', async () => {
    const conversation = mission()
    await renew(conversation.id)
    fakeTurn()
    await manager.sendMessage(conversation.id, 'next step?')
    const hooks = vi.mocked(runAiCliInvocation).mock.calls[0][0]
    expect(hooks.buildOpts.sessionId).toBeUndefined()
    expect(hooks.buildOpts.prompt).toContain('Summary of the earlier conversation')
    expect(hooks.buildOpts.prompt).toContain('Ship it.')
    expect(hooks.buildOpts.prompt).not.toContain('Build the importer on branch feat/import')
    expect(getAgentConversation(db, conversation.id)?.session_id).toBe('new-session')
  })

  it('records one session-summary ledger row, counted under Missions', async () => {
    const conversation = mission()
    await renew(conversation.id)
    const rows = ledger()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ surface: 'session-summary', conversation_id: conversation.id, project_id: 'project-1', status: 'success', total_cost_usd: 0.003, num_turns: 1 })
    expect(agentLedgerSurface('session-summary')).toBe('mission')
  })

  it('refuses while a turn is running', async () => {
    const conversation = mission()
    let release!: () => void
    vi.mocked(runAiCliInvocation).mockImplementation(async (hooks) => {
      hooks.onSpawn?.({ kill: () => true } as never)
      await new Promise<void>((resolve) => { release = resolve })
      return { code: 0, timedOut: false, spawnFailed: false, events: [], lastResultEvent: null, sessionId: null, stderrTail: '', child: null } as InvocationResult
    })
    const turn = manager.sendMessage(conversation.id, 'long work')
    await vi.waitFor(() => expect(manager.isBusy(conversation.id)).toBe(true))
    const res = await renew(conversation.id)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('MISSION_BUSY')
    expect(calls).toHaveLength(0)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await turn
  })

  it('refuses in Intent, which owns its own session', async () => {
    const conversation = mission()
    manager.setFlowTurnContext({ forConversation: () => ({ flowId: 'f1', coreSessionId: 'flow:f1', cwd: '/tmp', branch: null, systemPrompt: '', policy: {} }) } as unknown as IntentTurnContext)
    const res = await renew(conversation.id)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('MISSION_IN_INTENT')
    expect(getAgentConversation(db, conversation.id)?.session_id).toBe('provider-session')
  })

  it('changes nothing when the summary fails, and reports the provider error', async () => {
    const conversation = mission()
    generate.mockImplementationOnce(async () => { throw new Error('You have hit your usage limit') })
    const res = await renew(conversation.id)
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ error: 'You have hit your usage limit', code: 'SESSION_SUMMARY_FAILED' })
    expect(getAgentConversation(db, conversation.id)?.session_id).toBe('provider-session')
    expect(listAgentMessages(db, conversation.id).some((m) => m.role === 'system')).toBe(false)
    expect(ledger()[0]).toMatchObject({ surface: 'session-summary', status: 'failed' })
    expect(manager.isBusy(conversation.id)).toBe(false)
  })

  it('refuses a mission with nothing to summarize and unknown missions', async () => {
    const empty = createAgentConversation(db, { provider: 'claude' })
    expect((await renew(empty.id)).body.code).toBe('NOTHING_TO_SUMMARIZE')
    expect((await renew('missing')).status).toBe(404)
  })

  it('moves a Core mission to its next session generation', async () => {
    const conversation = mission()
    const renewMissionSessionIfOpened = vi.fn(async () => `${conversation.id}:g1`)
    manager.setCoreSessions({ handle: () => undefined, shutdown: () => {}, renewMissionSessionIfOpened } as unknown as MissionCoreSessions)
    expect((await renew(conversation.id)).status).toBe(200)
    expect(renewMissionSessionIfOpened).toHaveBeenCalledWith(expect.objectContaining({ id: conversation.id }), 'session_summary')
  })

  it('runs input queued while the summary was written in the new session', async () => {
    const conversation = mission()
    let finish!: (out: GenerateOutput) => void
    generate.mockImplementationOnce(() => new Promise<GenerateOutput>((resolve) => { finish = resolve }))
    fakeTurn()
    const pending = renew(conversation.id).then((r) => r)
    await vi.waitFor(() => expect(manager.isBusy(conversation.id)).toBe(true))
    await manager.sendMessage(conversation.id, 'queued meanwhile')
    expect(runAiCliInvocation).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    finish(output('## Goal\nQueued summary.', 'sonnet'))
    expect((await pending).status).toBe(200)
    await vi.waitFor(() => expect(runAiCliInvocation).toHaveBeenCalledTimes(1))
    expect(vi.mocked(runAiCliInvocation).mock.calls[0][0].buildOpts.prompt).toContain('Queued summary.')
    await vi.waitFor(() => expect(manager.isBusy(conversation.id)).toBe(false))
  })
})
