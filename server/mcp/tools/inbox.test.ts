import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiCall, type McpToolContext } from './types'
import { bound, inboxNextCalls, inboxTools } from './inbox'
import { McpToolError } from './envelope'
import type { InboxItem } from '../../modules/inbox'

vi.mock('./types', async (importOriginal) => ({ ...await importOriginal<typeof import('./types')>(), apiCall: vi.fn() }))

const ctx = {
  registry: { getProjectRow: (id: string) => id === 'p1' ? { id: 'p1' } : undefined, getContext: (id: string) => id === 'p1' ? { project: { id: 'p1' } } : undefined, listProjects: () => [{ id: 'p1', name: 'Shop' }] },
} as unknown as McpToolContext
const tool = inboxTools()[0]
const tier = tool.tier as (args: Record<string, unknown>) => string
type Response = { data: any; summary: string; status?: string; next?: Array<{ tool: string; args: Record<string, unknown> }>; ids?: Record<string, unknown>; truncated?: boolean }
const call = (args: Record<string, unknown>) => tool.handler(ctx, args) as Promise<Response>

const item = (overrides: Partial<InboxItem>): InboxItem => ({
  id: 'p1:question:run-1', projectId: 'p1', projectName: 'Shop', kind: 'question', title: 'Which database?', detail: null,
  at: '2026-11-18T10:00:00Z', version: 'v1', action: 'open-run', subjectId: 'run-1', conversationId: null, diagnosis: null, ...overrides,
})
const question = item({})
const review = item({ id: 'p1:review:d1', kind: 'review', title: 'Spec #4 ready', action: 'open-review', subjectId: 'd1', decision: 'on_review', railIndex: 0 })
const failed = item({ id: 'p2:failed:run-9', projectId: 'p2', projectName: 'Blog', kind: 'failed', title: 'Spec #9', action: 'open-run', subjectId: 'run-9', railIndex: 3,
  diagnosis: { kind: 'tests', confidence: 'high', phase: null, rounds: null, resetAt: null, detail: 'Tests failed', resumablePhase: null, source: 'core', remedies: ['retry', 'open-logs'] } })
const cap = item({ id: 'p1:budget:day', kind: 'budget', title: 'Daily cap reached', action: 'raise-cap', subjectId: 'day', cap: { scope: 'project', period: 'day', budgetUsd: 5, spentUsd: 5.2, resetsAt: '2026-11-19T00:00:00Z' } })

function routes(map: Record<string, unknown>) {
  vi.mocked(apiCall).mockImplementation(async (_ctx, method, path) => {
    const key = `${method} ${path}`
    if (!(key in map)) throw new Error(`unexpected ${key}`)
    return map[key]
  })
}

beforeEach(() => { vi.mocked(apiCall).mockReset() })

describe('specrails_inbox', () => {
  it('declares tiers: answer write, resume/retry ai-spawn, the rest read', () => {
    expect(tier({ action: 'list' })).toBe('read')
    expect(tier({ action: 'open' })).toBe('read')
    expect(tier({ action: 'question' })).toBe('read')
    expect(tier({ action: 'answer' })).toBe('write')
    expect(tier({ action: 'resume' })).toBe('ai-spawn')
    expect(tier({ action: 'retry' })).toBe('ai-spawn')
  })

  it('lists what needs the person with each item\'s safe actions and exact next calls', async () => {
    routes({ 'GET /inbox': { items: [question, review, failed, cap] } })
    const result = await call({ action: 'list' })
    expect(result.summary).toBe('4 things need the person: 1 question, 1 review, 1 failed, 1 budget. Newest: “Which database?” in Shop.')
    expect(result.data.total).toBe(4)
    const [q, r, f, b] = result.data.items
    expect(q.actions).toEqual(['answer', 'open'])
    expect(q.next[1]).toEqual({ tool: 'specrails_inbox', args: { action: 'answer', projectId: 'p1', runId: 'run-1', answer: '<the person’s answer>' }, why: expect.any(String) })
    // A PR decision stays in the app.
    expect(r.actions).toEqual(['open'])
    expect(f.actions).toEqual(['retry', 'open'])
    expect(f.next[0].args).toEqual({ action: 'retry', projectId: 'p2', sourceId: 'run:run-9', railIndex: 3 })
    expect(f.diagnosis).toEqual({ kind: 'tests', confidence: 'high', detail: 'Tests failed', remedies: ['retry', 'open-logs'] })
    expect(b.cap).toMatchObject({ budgetUsd: 5 })
    const filtered = await call({ action: 'list', projectId: 'p2', limit: 1 })
    expect(filtered.data.items.map((i: { id: string }) => i.id)).toEqual(['p2:failed:run-9'])
    const kinds = await call({ action: 'list', kind: 'review' })
    expect(kinds.data.total).toBe(1)
    const truncated = await call({ action: 'list', limit: 1 })
    expect(truncated.truncated).toBe(true)
  })

  it('says so when nothing needs the person', async () => {
    routes({ 'GET /inbox': { items: [] } })
    const result = await call({ action: 'list' })
    expect(result.summary).toBe('Nothing needs the person right now.')
    expect(result.next?.[0].tool).toBe('specrails_status')
  })

  it('opens a review through its packet, a question through the run, a failure through its loop run and a cap through the budget', async () => {
    routes({
      'GET /inbox': { items: [question, review, failed, cap] },
      'GET /projects/p1/rails/pr-deliveries/d1/packet': { packet: { verdict: 'x'.repeat(3000) } },
      'GET /projects/p1/agent-runtime/runs/run-1': { runs: [{ pendingQuestion: { question: 'Postgres or SQLite?', requestedAt: 't' } }] },
      'GET /projects/p2/loop-runs/run-9': { loopRun: { id: 'run-9', status: 'failed' } },
      'GET /projects/p1/budget': { dailyBudgetUsd: 5 },
    })
    const opened = await call({ action: 'open', itemId: 'p1:review:d1' })
    expect(opened.data.source).toBe('review packet')
    expect(opened.data.detail.packet.verdict).toHaveLength(2000 + '… [truncated]'.length)
    expect(opened.summary).toBe('Review in Shop: “Spec #4 ready”.')
    expect((await call({ action: 'open', itemId: question.id })).data.detail).toEqual({ question: 'Postgres or SQLite?', requestedAt: 't' })
    const failure = await call({ action: 'open', itemId: failed.id })
    expect(failure.data.detail).toEqual({ id: 'run-9', status: 'failed' })
    expect(failure.next?.[0]).toMatchObject({ tool: 'specrails_jobs', args: { action: 'diagnose_failure', projectId: 'p2', jobId: 'run-9' } })
    const budget = await call({ action: 'open', itemId: cap.id })
    expect(budget.data.detail).toEqual({ dailyBudgetUsd: 5 })
    expect(budget.next?.[0]).toMatchObject({ tool: 'specrails_analytics', args: { action: 'budget_set' } })
  })

  it('reports a handled item as not_found with the current choices', async () => {
    routes({ 'GET /inbox': { items: [question] } })
    const error = await call({ action: 'open', itemId: 'gone' }).catch((e) => e)
    expect(error).toBeInstanceOf(McpToolError)
    expect(error).toMatchObject({ code: 'not_found', extra: { choices: [{ itemId: question.id, title: 'Which database?' }] } })
    await expect(call({ action: 'open' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('reads a pending question and answers it on the runtime (or loop definition) resume route', async () => {
    routes({
      'GET /projects/p1/agent-runtime/runs/run-1': { runs: [{ pendingQuestion: { question: 'Postgres?', requestedAt: 't' } }] },
      'POST /projects/p1/agent-runtime/runs/run-1/resume': { ok: true },
    })
    const read = await call({ action: 'question', projectId: 'p1', runId: 'run-1' })
    expect(read).toMatchObject({ status: 'waiting', data: { pending: true, question: 'Postgres?' } })
    const answered = await call({ action: 'answer', projectId: 'p1', runId: 'run-1', answer: '  Postgres  ' })
    expect(answered.status).toBe('answered')
    expect(vi.mocked(apiCall)).toHaveBeenLastCalledWith(ctx, 'POST', '/projects/p1/agent-runtime/runs/run-1/resume', { answer: 'Postgres' })

    routes({
      'GET /projects/p1/agent-runtime/runs/run-2': { runs: [{ engineVersion: 2, pendingQuestion: { question: 'Q', stepId: 'step-7' } }] },
      'POST /projects/p1/loop-runs/run-2/resume': { ok: true },
    })
    await call({ action: 'answer', projectId: 'p1', runId: 'run-2', answer: 'A' })
    expect(vi.mocked(apiCall)).toHaveBeenLastCalledWith(ctx, 'POST', '/projects/p1/loop-runs/run-2/resume', { answer: 'A', interruptId: 'step-7' })
  })

  it('refuses to answer when nothing is pending, and validates inputs', async () => {
    routes({ 'GET /projects/p1/agent-runtime/runs/run-1': { runs: [{ pendingQuestion: { question: 'Q', answeredAt: 't' } }] } })
    await expect(call({ action: 'answer', projectId: 'p1', runId: 'run-1', answer: 'A' })).rejects.toMatchObject({ code: 'conflict' })
    expect((await call({ action: 'question', projectId: 'p1', runId: 'run-1' })).data).toEqual({ pending: false })
    await expect(call({ action: 'answer', projectId: 'p1', runId: '../x', answer: 'A' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call({ action: 'answer', projectId: 'p1', runId: 'run-1', answer: '   ' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call({ action: 'resume', projectId: 'p1', runId: 'run-1', runCap: 'ignore', runCapUsd: 3 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call({ action: 'retry', projectId: 'p1', sourceId: 'bad id', railIndex: 0 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(call({ action: 'retry', projectId: 'p1', sourceId: 'run:x' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('resumes and retries through the desktop routes the phone uses', async () => {
    routes({ 'POST /projects/p1/loop-runs/run-1/resume': { ok: true }, 'POST /projects/p1/rails/3/relaunch': { jobId: 'job-new' } })
    const resumed = await call({ action: 'resume', projectId: 'p1', runId: 'run-1', runCapUsd: 12 })
    expect(vi.mocked(apiCall)).toHaveBeenLastCalledWith(ctx, 'POST', '/projects/p1/loop-runs/run-1/resume', { runCapUsd: 12 })
    expect(resumed.next?.[0]).toMatchObject({ tool: 'specrails_watch', args: { ref: 'run-1', kind: 'loop_run' } })
    await call({ action: 'resume', projectId: 'p1', runId: 'run-1', runCap: 'ignore' })
    expect(vi.mocked(apiCall)).toHaveBeenLastCalledWith(ctx, 'POST', '/projects/p1/loop-runs/run-1/resume', { runCap: 'ignore' })
    const retried = await call({ action: 'retry', projectId: 'p1', sourceId: 'run:run-9', railIndex: 3 })
    expect(vi.mocked(apiCall)).toHaveBeenLastCalledWith(ctx, 'POST', '/projects/p1/rails/3/relaunch', { sourceId: 'run:run-9' })
    expect(retried).toMatchObject({ status: 'launched', ids: { railIndex: 3, jobId: 'job-new' } })
  })

  it('bounds detail payloads and always offers open', () => {
    expect(bound({ a: Array.from({ length: 40 }, (_, i) => i) }).a).toHaveLength(31)
    expect(bound({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toEqual({ a: { b: { c: { d: { e: '[nested detail omitted]' } } } } })
    expect(inboxNextCalls(review)).toEqual([{ tool: 'specrails_inbox', args: { action: 'open', itemId: review.id }, why: expect.any(String) }])
  })
})
