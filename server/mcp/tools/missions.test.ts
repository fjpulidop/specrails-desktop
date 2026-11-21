import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiCall, type McpToolContext } from './types'
import { missionsTools } from './missions'

vi.mock('./types', async (importOriginal) => ({ ...await importOriginal<typeof import('./types')>(), apiCall: vi.fn() }))

const ctx = { registry: { getProjectRow: (id: string) => id === 'p1' ? { id: 'p1', name: 'Shop' } : undefined } } as unknown as McpToolContext
const tool = missionsTools()[0]
const tier = tool.tier as (args: Record<string, unknown>) => string
type Response = { data: any; summary: string; status?: string; next?: Array<{ tool: string; args: Record<string, unknown> }>; ids?: Record<string, unknown>; truncated?: boolean }
const call = (args: Record<string, unknown>, context: McpToolContext = ctx) => tool.handler(context, args) as Promise<Response>

const conversations = [
  { id: 'm1', title: 'Refactor checkout', pinned_project_id: 'p1', provider: 'claude', model: 'opus', contextUsage: { percent: 61 }, updated_at: '2026-11-18T10:00:00Z', archivedAt: null },
  { id: 'm2', title: 'Write docs', pinned_project_id: null, provider: 'codex', model: null, updated_at: '2026-11-18T11:00:00Z', archivedAt: null },
  { id: 'm3', title: null, pinned_project_id: 'p1', provider: 'gemini', model: null, updated_at: '2026-11-17T11:00:00Z', archivedAt: null },
]
const messages = [
  { id: 'u1', role: 'user', content: 'Refactor the checkout', created_at: 't1' },
  { id: 'a1', role: 'assistant', content: 'Done: I split the module into three files.', created_at: 't2' },
]

function routes(map: Record<string, unknown>) {
  vi.mocked(apiCall).mockImplementation(async (_ctx, method, path) => {
    const key = `${method} ${path}`
    if (!(key in map)) throw new Error(`unexpected ${key}`)
    return map[key]
  })
}
beforeEach(() => { vi.mocked(apiCall).mockReset() })

describe('specrails_missions', () => {
  it('declares tiers: send/ask ai-spawn, abort destructive, reads read', () => {
    for (const action of ['list', 'active', 'get']) expect(tier({ action })).toBe('read')
    expect(tier({ action: 'send' })).toBe('ai-spawn')
    expect(tier({ action: 'ask' })).toBe('ai-spawn')
    expect(tier({ action: 'abort' })).toBe('destructive')
  })

  it('lists missions with project, engine, running state and context usage; running first', async () => {
    routes({
      'GET /agent/conversations?archiveScope=active': { conversations },
      'GET /agent/active-turns': { turns: [{ conversationId: 'm1' }], sessions: [{ conversationId: 'm3' }] },
    })
    const result = await call({ action: 'list' })
    expect(result.data.missions.map((m: { conversationId: string }) => m.conversationId)).toEqual(['m1', 'm2', 'm3'])
    expect(result.data.missions[0]).toEqual({
      conversationId: 'm1', title: 'Refactor checkout', projectId: 'p1', projectName: 'Shop', provider: 'claude', model: 'opus',
      running: true, backgroundWork: false, contextUsagePercent: 61, archived: false, updatedAt: '2026-11-18T10:00:00Z',
    })
    expect(result.data.missions[2]).toMatchObject({ title: 'Untitled mission', running: false, backgroundWork: true })
    expect(result.summary).toBe('3 missions, 1 running. Most recent: “Refactor checkout” in Shop (claude / opus, context 61% used).')
    expect(result.next?.[0]).toEqual({ tool: 'specrails_missions', args: { action: 'get', conversationId: 'm1' }, why: expect.any(String) })
    const scoped = await call({ action: 'list', projectId: 'p1', limit: 1 })
    expect(scoped.data.total).toBe(2)
    expect(scoped.truncated).toBe(true)
    const active = await call({ action: 'active' })
    expect(active.data.missions.map((m: { conversationId: string }) => m.conversationId)).toEqual(['m1', 'm3'])
    expect(active.summary).toMatch(/^2 missions working now/)
  })

  it('includes archived missions on request and reports an empty state', async () => {
    routes({ 'GET /agent/conversations?archiveScope=all': { conversations: [] }, 'GET /agent/active-turns': { turns: [] } })
    expect((await call({ action: 'list', includeArchived: true })).summary).toBe('There are no missions yet.')
    routes({ 'GET /agent/conversations?archiveScope=active': { conversations: [] }, 'GET /agent/active-turns': { turns: [] } })
    expect((await call({ action: 'active' })).summary).toBe('No mission is running right now.')
  })

  it('gets recent messages, live state and context usage, bounded', async () => {
    const long = { id: 'a2', role: 'assistant', content: 'x'.repeat(5000), created_at: 't3' }
    routes({ 'GET /agent/conversations/m1': {
      conversation: conversations[0], messages: [...messages, long], pendingMessages: [{ queueId: 'q' }],
      live: { isStreaming: true, streamingText: 'thinking', startedAt: 't' },
    } })
    const result = await call({ action: 'get', conversationId: 'm1', limit: 2 })
    expect(result.status).toBe('running')
    expect(result.data.mission).toMatchObject({ running: true, contextUsagePercent: 61 })
    expect(result.data.messages.map((m: { id: string }) => m.id)).toEqual(['a1', 'a2'])
    expect(result.data.messages[1].content).toHaveLength(2000 + '… [truncated]'.length)
    expect(result.data).toMatchObject({ pendingMessages: 1, totalMessages: 3, live: { isStreaming: true, streamingText: 'thinking' }, contextUsage: { percent: 61 } })
    expect(result.truncated).toBe(true)
    expect(result.summary).toMatch(/is running a turn; 3 messages, 1 queued\. Latest reply: x+/)
    expect(result.next?.map((n) => n.args.action ?? n.tool)).toEqual(['specrails_watch', 'send', 'ask'])
    await expect(call({ action: 'get' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('sends only the text and delivery mode — never permission level, provider or pin', async () => {
    routes({ 'POST /agent/conversations/m1/send': { accepted: true, queued: true, deliveryMode: 'queue' } })
    const result = await call({ action: 'send', conversationId: 'm1', text: ' Also add tests ', deliveryMode: 'queue', tierLevel: 3, provider: 'kimi' })
    expect(vi.mocked(apiCall)).toHaveBeenLastCalledWith(ctx, 'POST', '/agent/conversations/m1/send', { text: 'Also add tests', deliveryMode: 'queue' })
    expect(result).toMatchObject({ status: 'queued', summary: 'Message queued; the mission reads it after the running turn.' })
    await expect(call({ action: 'send', conversationId: 'm1', text: '  ' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('asks a side question about the latest reply by default', async () => {
    routes({
      'GET /agent/conversations/m1': { conversation: conversations[0], messages },
      'POST /agent/conversations/m1/side-questions': { answer: 'It splits by responsibility.', provider: 'claude', model: 'haiku' },
    })
    const result = await call({ action: 'ask', conversationId: 'm1', question: 'Why three files?' })
    expect(vi.mocked(apiCall)).toHaveBeenLastCalledWith(ctx, 'POST', '/agent/conversations/m1/side-questions', {
      selection: 'Done: I split the module into three files.', throughMessageId: 'a1', question: 'Why three files?',
    })
    expect(result.summary).toBe('It splits by responsibility.')
    await call({ action: 'ask', conversationId: 'm1', question: 'Q', selection: 'S', throughMessageId: 'u1' })
    expect(vi.mocked(apiCall)).toHaveBeenLastCalledWith(ctx, 'POST', '/agent/conversations/m1/side-questions', { selection: 'S', throughMessageId: 'u1', question: 'Q' })
    routes({ 'GET /agent/conversations/m9': { conversation: {}, messages: [] } })
    await expect(call({ action: 'ask', conversationId: 'm9', question: 'Q' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(call({ action: 'ask', conversationId: 'm1' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('aborts a running turn and reports when nothing was running', async () => {
    routes({ 'POST /agent/conversations/m1/abort': { aborted: true } })
    expect(await call({ action: 'abort', conversationId: 'm1' })).toMatchObject({ status: 'aborted', summary: 'The running turn was stopped.' })
    routes({ 'POST /agent/conversations/m1/abort': { aborted: false } })
    expect((await call({ action: 'abort', conversationId: 'm1' })).status).toBe('idle')
  })

  it('never lets a mission message, question or stop itself', async () => {
    const self = { ...ctx, firstPartyAgent: true, originConversationId: 'm1' } as McpToolContext
    for (const action of ['send', 'ask', 'abort']) {
      await expect(call({ action, conversationId: 'm1', text: 'x', question: 'y' }, self)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(apiCall).not.toHaveBeenCalled()
  })
})
