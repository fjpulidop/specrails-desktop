import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jobsTools } from './jobs'
import { apiCall, type McpToolContext } from './types'
import { findFailedStep, focusedLog, splitSteps } from './job-logs'

vi.mock('./types', async (importOriginal) => ({ ...await importOriginal<typeof import('./types')>(), apiCall: vi.fn() }))

const ctx = { registry: { getProjectRow: (id: string) => (id === 'p1' ? { id: 'p1' } : undefined), getContext: (id: string) => (id === 'p1' ? { project: { id: 'p1' } } : undefined) }, requestProjectId: 'p1' } as unknown as McpToolContext
const tool = jobsTools()[0]
const tier = tool.tier as (a: Record<string, unknown>) => string
type Response = { data: any; summary: string; status?: string; next?: Array<{ tool: string; args: Record<string, unknown> }>; ids?: Record<string, unknown>; truncated?: boolean }
const call = (args: Record<string, unknown>) => tool.handler(ctx, { projectId: 'p1', ...args }) as Promise<Response>

const ev = (event_type: string, payload: unknown) => ({ event_type, payload: JSON.stringify(payload) })
const events = [
  ev('log', { line: 'booting' }),
  ev('loop_step', { index: 1, title: 'implement', kind: 'ai' }),
  ev('log', { line: 'wrote src/a.ts' }),
  ev('loop_step_end', { index: 1, status: 'ok' }),
  ev('loop_step', { index: 2, title: 'verify', kind: 'shell' }),
  ev('log', { text: 'npm test\nFAIL api.test.ts\nExpected 2, got 3' }),
  ev('loop_step_end', { index: 2, status: 'failed', exitCode: 1 }),
  ev('loop_step', { index: 3, title: 'report', kind: 'ai' }),
  ev('log', { line: 'writing report' }),
  ev('result', { subtype: 'error' }),
]

function routes(map: Record<string, unknown>) {
  vi.mocked(apiCall).mockImplementation(async (_ctx, method, path) => {
    const key = `${method} ${path}`
    if (!(key in map)) throw new Error(`unexpected ${key}`)
    return map[key]
  })
}
beforeEach(() => { vi.mocked(apiCall).mockReset() })

describe('failure-focused job logs (pure)', () => {
  it('splits events into steps and finds the failed one', () => {
    const steps = splitSteps(events)
    expect(steps.map((step) => [step.title, step.status])).toEqual([
      ['(before the first step)', null], ['implement', 'ok'], ['verify', 'failed'], ['report', 'running'],
    ])
    expect(findFailedStep(steps)?.title).toBe('verify')
    expect(findFailedStep(steps, 'implement')?.title).toBe('implement')
    expect(findFailedStep(splitSteps([ev('log', { line: 'only' })]))).toBeNull()
  })

  it('returns the failed step first, then the tail after it, within the budget', () => {
    const log = focusedLog(events, { limit: 200 })
    expect(log.failedStep).toMatchObject({ title: 'verify', status: 'failed', omittedLines: 0 })
    expect(log.failedStep?.lines).toEqual(expect.arrayContaining(['npm test', 'FAIL api.test.ts', 'Expected 2, got 3']))
    expect(log.tail).toEqual(expect.arrayContaining(['writing report']))
    expect(log.tail.some((line) => line.includes('wrote src/a.ts'))).toBe(false)
    expect(log.totalLines).toBeGreaterThan(log.failedStep!.lines.length + log.tail.length)
    expect(log.truncated).toBe(true)

    const tight = focusedLog(events, { limit: 2 })
    expect(tight.failedStep?.lines).toHaveLength(2)
    expect(tight.failedStep?.omittedLines).toBeGreaterThan(0)
    expect(tight.tail).toEqual([])

    const healthy = focusedLog(events, { limit: 3, failed: false })
    expect(healthy.failedStep).toBeNull()
    expect(healthy.tail).toHaveLength(3)
    expect(focusedLog([], {})).toEqual({ totalLines: 0, failedStep: null, tail: [], omittedLines: 0, truncated: false })
  })
})

describe('specrails_jobs diagnose_failure / logs', () => {
  it('diagnose_failure reads by default and spawns only with generate:true', () => {
    expect(tier({ action: 'diagnose_failure' })).toBe('read')
    expect(tier({ action: 'diagnose_failure', generate: true })).toBe('ai-spawn')
    expect(tier({ action: 'logs' })).toBe('read')
  })

  it('returns the diagnosis plus the saved AI analysis with a relayable summary', async () => {
    routes({
      'GET /projects/p1/jobs/j1': { job: { id: 'j1', status: 'failed', command: '/sr:implement 4', provider: 'claude', model: 'opus', failureDiagnosis: { kind: 'tests', detail: 'Unit tests failed.', remedies: ['retry'] } }, events: [] },
      'GET /projects/p1/jobs/j1/failure-analysis?language=es': {
        status: 'ready', stale: false, provider: 'claude', model: 'haiku', createdAt: 't',
        analysis: { headline: 'The api test expects 2 but gets 3.', cause: 'c', category: 'tests', failedStep: 'verify', evidence: ['FAIL api.test.ts'], nextSteps: ['Fix the off-by-one'] },
      },
    })
    const result = await call({ action: 'diagnose_failure', jobId: 'j1', language: 'es' })
    expect(result.summary).toBe('Job j1 failed: The api test expects 2 but gets 3. AI analysis (tests) is available.')
    expect(result.data).toMatchObject({
      jobId: 'j1', status: 'failed', diagnosis: { kind: 'tests' },
      analysis: { headline: 'The api test expects 2 but gets 3.', category: 'tests', evidence: ['FAIL api.test.ts'], nextSteps: ['Fix the off-by-one'], stale: false, generated: false },
    })
    expect(result.next?.map((n) => n.args.action)).toEqual(['logs', 'runtime_diagnose'])
    expect(vi.mocked(apiCall).mock.calls.some((c) => c[1] === 'POST')).toBe(false)
  })

  it('suggests generating when no analysis exists, and generates on request', async () => {
    routes({
      'GET /projects/p1/jobs/j2': { job: { id: 'j2', status: 'failed', command: '/x', failureDiagnosis: { kind: 'unknown', detail: null } }, events: [] },
      'GET /projects/p1/jobs/j2/failure-analysis': { status: 'none' },
      'POST /projects/p1/jobs/j2/failure-analysis': { status: 'ready', stale: false, analysis: { headline: 'Provider limit reached.', category: 'provider_limit', evidence: [], nextSteps: [] } },
    })
    const read = await call({ action: 'diagnose_failure', jobId: 'j2' })
    expect(read.summary).toBe('Job j2 failed with no recorded cause yet. No AI analysis yet.')
    expect(read.next?.[0]).toMatchObject({ args: { action: 'diagnose_failure', jobId: 'j2', generate: true } })
    const generated = await call({ action: 'diagnose_failure', jobId: 'j2', generate: true })
    expect(vi.mocked(apiCall)).toHaveBeenLastCalledWith(ctx, 'POST', '/projects/p1/jobs/j2/failure-analysis', {})
    expect(generated.data.analysis).toMatchObject({ category: 'provider_limit', generated: true })
    expect(generated.summary).toContain('Provider limit reached.')
  })

  it('explains a job that did not fail and requires a jobId', async () => {
    routes({ 'GET /projects/p1/jobs/j3': { job: { id: 'j3', status: 'running' }, events: [] } })
    const result = await call({ action: 'diagnose_failure', jobId: 'j3' })
    expect(result).toMatchObject({ status: 'running', summary: 'Job j3 is running, not failed, so there is nothing to diagnose.' })
    expect(result.next?.[0].tool).toBe('specrails_watch')
    await expect(call({ action: 'diagnose_failure' })).rejects.toThrow('jobId')
    await expect(call({ action: 'logs' })).rejects.toThrow('jobId')
  })

  it('logs returns a bounded failure-focused tail instead of raw events', async () => {
    routes({ 'GET /projects/p1/jobs/j1': { job: { id: 'j1', status: 'failed', failureDiagnosis: { kind: 'tests', phase: null } }, events: events.map((e, seq) => ({ ...e, seq })) } })
    const result = await call({ action: 'logs', jobId: 'j1', limit: 50 })
    expect(result.data.failedStep.title).toBe('verify')
    expect(result.data.events).toBeUndefined()
    expect(result.summary).toMatch(/^Job j1 \(failed\): showing \d+ of \d+ log lines\. The failed step “verify” \(failed\) comes first\.$/)
    expect(result.next?.map((n) => n.args.action)).toEqual(['diagnose_failure', 'logs'])
    expect(result.next?.[1].args.limit).toBe(100)

    routes({ 'GET /projects/p1/jobs/j4': { job: { id: 'j4', status: 'completed' }, events: [] } })
    const empty = await call({ action: 'logs', jobId: 'j4' })
    expect(empty.summary).toBe('Job j4 (completed) has no log lines recorded yet.')
    expect(empty.data.limit).toBe(200)
  })
})
