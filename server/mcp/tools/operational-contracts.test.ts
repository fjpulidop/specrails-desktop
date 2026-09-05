import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { initDesktopDb, type DbInstance } from '../../desktop-db'
import { createAgentConversation } from '../../agent-store'
import type { ProjectRegistry } from '../../project-registry'
import { MobileEventBus } from '../../mobile/mobile-event-bus'
import type { McpToolContext, McpToolSpec } from './types'
import { railsTools } from './rails'
import { jobsTools } from './jobs'
import { loopsTools } from './loops'
import { specsTools } from './specs'
import { gitTools } from './git'

describe('MCP operational contracts', () => {
  let db: DbInstance
  let ctx: McpToolContext
  let fetchMock: ReturnType<typeof vi.fn>
  const rails = railsTools()[0]
  const jobs = jobsTools()[0]
  const loops = loopsTools()[0]
  const specs = specsTools()[0]
  const git = gitTools()[0]
  const response = (data: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) })
  const call = (tool: McpToolSpec, args: Record<string, unknown>) => tool.handler(ctx, { projectId: 'p1', ...args }) as Promise<Record<string, any>>
  const body = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body)
  const tier = (tool: McpToolSpec, args: Record<string, unknown>) => typeof tool.tier === 'function' ? tool.tier(args) : tool.tier

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    const project = { id: 'p1', path: '/tmp/p1', provider: 'claude', providers: ['claude', 'codex'] }
    ctx = {
      registry: { getContext: (id: string) => id === 'p1' ? { project } : undefined } as ProjectRegistry,
      desktopDb: db, desktopPort: 4299, eventBus: new MobileEventBus(), broadcast: () => {},
    }
    fetchMock = vi.fn().mockResolvedValue(response({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { db.close(); vi.unstubAllGlobals() })

  it.each([
    [rails, { action: 'pr_candidates', railIndex: 2 }, '/projects/p1/rails/2/pr-candidates'],
    [rails, { action: 'review_packet', prDeliveryId: 'delivery/#1' }, '/projects/p1/rails/pr-deliveries/delivery%2F%231/packet'],
    [git, { action: 'info' }, '/projects/p1/git'],
    [git, { action: 'pull_request', prNumber: 42 }, '/projects/p1/git/pull-requests/42'],
    [jobs, { action: 'phase_breakdown', jobId: 'job/#1' }, '/projects/p1/jobs/job%2F%231/phase-breakdown'],
  ] as const)('forwards new read action $1.action through its existing REST route', async (tool, args, path) => {
    expect(tier(tool, args)).toBe('read')
    expect(z.object(tool.inputSchema).safeParse(args).success).toBe(true)
    await call(tool, args)
    expect(fetchMock).toHaveBeenCalledWith(`http://127.0.0.1:4299/api${path}`, expect.objectContaining({ method: 'GET' }))
  })

  it.each([
    [rails, { action: 'pr_candidates' }, 'railIndex'],
    [rails, { action: 'review_packet' }, 'prDeliveryId'],
    [git, { action: 'pull_request', prNumber: -1 }, 'prNumber'],
    [jobs, { action: 'phase_breakdown' }, 'jobId'],
  ] as const)('validates required identity before read $1.action', async (tool, args, field) => {
    await expect(call(tool, args)).rejects.toThrow(field)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('job history has nextOffset and detail defaults to recent events with explicit earlier pagination', async () => {
    fetchMock.mockResolvedValueOnce(response({ jobs: [{ id: 'job-3' }, { id: 'job-4' }], total: 10 }))
    expect(await call(jobs, { action: 'list', limit: 2, offset: 2 })).toMatchObject({ offset: 2, nextOffset: 4 })
    const events = Array.from({ length: 120 }, (_, index) => ({ seq: index, text: `event ${index}` }))
    fetchMock.mockResolvedValue(response({ job: { status: 'running' }, events, phaseDefinitions: ['dev'] }))
    const last = await call(jobs, { action: 'get', jobId: 'job-1' })
    expect(last.events).toHaveLength(50)
    expect(last.events[0].seq).toBe(70)
    expect(last.eventPage).toEqual({ offset: 70, limit: 50, total: 120, hasEarlier: true, nextOffset: null })
    const first = await call(jobs, { action: 'get', jobId: 'job-1', eventOffset: 0, eventLimit: 20 })
    expect(first.events[0].seq).toBe(0)
    expect(first.eventPage).toMatchObject({ total: 120, nextOffset: 20, hasEarlier: false })
  })

  it('spawn accepts explicit model and null legacy profile and inherits matching conversation model', async () => {
    const conversation = createAgentConversation(db, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'ultra' })
    ctx.originConversationId = conversation.id
    const args = { action: 'spawn', command: '/specrails:implement #1', profileName: null }
    expect(z.object(jobs.inputSchema).safeParse(args).success).toBe(true)
    await call(jobs, args)
    expect(body()).toMatchObject({ aiEngine: 'codex', model: 'gpt-6-astra', profileName: null })
    expect(body()).not.toHaveProperty('reasoning_effort')
    await call(jobs, { ...args, model: 'gpt-5.5' })
    expect(body().model).toBe('gpt-5.5')
    await call(jobs, { ...args, aiEngine: 'claude' })
    expect(body()).not.toHaveProperty('model')
  })

  it('standalone loops inherit conversation provider/model/effort without leaking across overrides', async () => {
    const conversation = createAgentConversation(db, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'ultra' })
    ctx.originConversationId = conversation.id
    const args = { action: 'run', loopId: 'custom' }
    await call(loops, args)
    expect(body()).toEqual({ loopId: 'custom', provider: 'codex', model: 'gpt-6-astra', reasoning_effort: 'ultra' })
    await call(loops, { ...args, model: 'gpt-5.5' })
    expect(body()).toEqual({ loopId: 'custom', provider: 'codex', model: 'gpt-5.5' })
    await call(loops, { ...args, provider: 'claude' })
    expect(body()).toEqual({ loopId: 'custom', provider: 'claude' })
    await call(loops, { ...args, model: 'gpt-5.5', reasoning_effort: 'high' })
    expect(body().reasoning_effort).toBe('high')
  })

  it('a missing constant update value never silently erases it', async () => {
    await expect(call(loops, { action: 'constant_update', constantId: 'c1' })).rejects.toThrow('value')
    expect(fetchMock).not.toHaveBeenCalled()
    await call(loops, { action: 'constant_update', constantId: 'c1', value: '' })
    expect(body()).toEqual({ value: '' })
  })

  it('retains isolation evidence in fanout and never promises a card for a legacy launch', async () => {
    fetchMock.mockResolvedValueOnce(response({ rails: [{ railIndex: 0, ticketIds: [1], mode: 'implement' }] }))
      .mockResolvedValueOnce(response({ loopRunIds: ['r1'], isolationUnavailable: 'no-git', isolationUnavailableDetail: 'uninitialized' }))
    const all = await call(rails, { action: 'launch_all' })
    expect(all.results[0]).toMatchObject({ isolationUnavailable: 'no-git', isolationUnavailableDetail: 'uninitialized', loopRunIds: ['r1'] })
    expect(all.hint).toContain('NO delivery card')
    fetchMock.mockResolvedValueOnce(response({ jobId: 'j1' }))
    expect((await call(rails, { action: 'launch', railIndex: 0 })).hint).toContain('did not report worktree isolation')
  })

  it('launch_all classifies structured conflicts and does not mask unrelated server failures by message text', async () => {
    const snapshot = { rails: [{ railIndex: 0, ticketIds: [1] }] }
    fetchMock.mockResolvedValueOnce(response(snapshot))
      .mockResolvedValueOnce(response({ error: 'pr_decision_pending' }, 409))
    expect((await call(rails, { action: 'launch_all' })).results[0]).toMatchObject({ outcome: 'skipped', reason: 'pr-decision-pending' })
    fetchMock.mockResolvedValueOnce(response(snapshot))
      .mockResolvedValueOnce(response({ error: 'database failure', detail: 'failed reading pr_decision_pending' }, 500))
    expect((await call(rails, { action: 'launch_all' })).results[0]).toMatchObject({ outcome: 'failed' })
  })

  it('commit_draft tier accounts for possible nested AI side effects', () => {
    expect(tier(specs, { action: 'commit_draft' })).toBe('ai-spawn')
    expect(tier(specs, { action: 'commit_draft', contractRefine: false })).toBe('write')
    expect(tier(specs, { action: 'commit_draft', draftTicketId: 1 })).toBe('write')
    expect(tier(specs, { action: 'commit_draft', conversationId: 'explore', contractRefine: false })).toBe('ai-spawn')
  })

  it('allows nullable clear fields and returns attachment metadata without fetching binary bytes', async () => {
    const args = { action: 'update', id: 1, assignee: null, short_summary: null }
    expect(z.object(specs.inputSchema).safeParse(args).success).toBe(true)
    await call(specs, args)
    expect(body()).toMatchObject({ assignee: null, short_summary: null })
    fetchMock.mockResolvedValueOnce(response({ attachments: [{ id: 'a1', mimeType: 'image/png', filename: 'diagram.png' }] }))
    const attachment = await call(specs, { action: 'get_attachment', ticketId: '1', attachmentId: 'a1' })
    expect(attachment).toMatchObject({ attachment: { id: 'a1', mimeType: 'image/png' }, path: '/projects/p1/tickets/1/attachments/a1' })
    expect(fetchMock.mock.calls.at(-1)![0]).toMatch(/\/attachments$/)
  })

  it('does not present an unknown attachment as a valid download', async () => {
    fetchMock.mockResolvedValueOnce(response({ attachments: [] }))
    await expect(call(specs, { action: 'get_attachment', ticketId: '1', attachmentId: 'missing' })).rejects.toThrow('Attachment not found')
  })
})
