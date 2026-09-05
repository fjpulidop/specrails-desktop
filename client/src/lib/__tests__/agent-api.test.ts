import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as api from '../agent-api'

function mockFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(async () => ({
    ok,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

const conv = {
  id: 'c1', title: null, provider: 'claude', model: null, session_id: null,
  pinned_project_id: null, tier_level: 0 as const, created_at: '', updated_at: '',
}

describe('agent-api', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('lists conversations', async () => {
    mockFetch({ conversations: [conv] })
    expect(await api.listAgentConversations()).toEqual([conv])
  })

  it('creates a conversation (POST body)', async () => {
    const f = mockFetch({ conversation: conv })
    const out = await api.createAgentConversation({ provider: 'claude', tierLevel: 1 })
    expect(out).toEqual(conv)
    expect(f).toHaveBeenCalledWith(expect.stringContaining('/api/agent/conversations'), expect.objectContaining({ method: 'POST' }))
  })

  it('gets a conversation with messages', async () => {
    mockFetch({ conversation: conv, messages: [] })
    const out = await api.getAgentConversation('c1')
    expect(out.conversation.id).toBe('c1')
  })

  it('patches, deletes, sends, aborts', async () => {
    mockFetch({ conversation: { ...conv, title: 'X' } })
    expect((await api.patchAgentConversation('c1', { title: 'X' })).title).toBe('X')
    const del = mockFetch(undefined)
    await api.deleteAgentConversation('c1')
    expect(del).toHaveBeenCalledWith(expect.stringContaining('/c1'), expect.objectContaining({ method: 'DELETE' }))
    const send = mockFetch(undefined)
    expect(await api.sendAgentMessage('c1', 'hi', { tierLevel: 2 })).toEqual({ queued: false })
    expect(send).toHaveBeenCalledWith(expect.stringContaining('/c1/send'), expect.objectContaining({ method: 'POST' }))
    const sendQueued = mockFetch({ accepted: true, queued: true })
    expect(await api.sendAgentMessage('c1', 'later', { queueId: 'q-1' })).toEqual({ queued: true })
    const [, init] = sendQueued.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ text: 'later', queueId: 'q-1' })
    const ab = mockFetch(undefined)
    await api.abortAgentTurn('c1')
    expect(ab).toHaveBeenCalledWith(expect.stringContaining('/c1/abort'), expect.objectContaining({ method: 'POST' }))
  })

  it('reads + enables MCP', async () => {
    mockFetch({ enabled: true, running: true })
    expect((await api.getMcpStatus()).enabled).toBe(true)
    const en = mockFetch(undefined)
    await api.enableMcp()
    expect(en).toHaveBeenCalledWith(expect.stringContaining('/api/mcp-admin/enable'), expect.objectContaining({ method: 'POST' }))
  })

  it('throws on a non-ok response', async () => {
    mockFetch({ error: 'boom' }, false, 500)
    await expect(api.listAgentConversations()).rejects.toThrow('boom')
  })

  it.each([
    () => api.deleteAgentConversation('c1'),
    () => api.deleteAgentAttachment('c1', 'attachment-1'),
    () => api.abortAgentTurn('c1'),
    () => api.enableMcp(),
  ])('does not report a rejected mutation as successful', async (mutate) => {
    mockFetch({ error: 'mutation refused' }, false, 409)
    await expect(mutate()).rejects.toThrow('mutation refused')
  })

  it('preserves an unknown delivery conflict as a failure instead of saying it was resolved', async () => {
    mockFetch({ error: 'delivery_not_verified', detail: 'The implementation commit is missing.' }, false, 409)
    expect(await api.postRailPrDecision('p1', { prDeliveryId: 'd1', action: 'merge-local', expectedDecision: 'on_review' })).toEqual({
      kind: 'failed', detail: 'The implementation commit is missing.', snapshot: null,
    })
  })

  it('returns the checked out branch and preserved-worktree warnings', async () => {
    mockFetch({ ok: true, branch: 'feat/local', cleanupWarnings: ['preserved modified worktree', null, 3] })
    expect(await api.postRailPrCheckout('p1', 'd1')).toEqual({
      kind: 'ok', branch: 'feat/local', cleanupWarnings: ['preserved modified worktree'],
    })
  })
})
