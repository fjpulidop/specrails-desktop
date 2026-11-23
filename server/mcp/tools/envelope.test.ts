import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ENVELOPE_OUTPUT_SHAPE, McpToolError, backendMessage, codeForMessage, codeForStatus, errorEnvelope,
  genericSummary, isToolResponse, successEnvelope, toolResponse,
} from './envelope'
import { McpApiError } from './types'

describe('MCP response envelope: success', () => {
  it('keeps the old payload under data and writes a generic summary', () => {
    const envelope = successEnvelope({ jobs: [{ id: 'a' }, { id: 'b' }], total: 9 }, { tool: 'specrails_jobs', action: 'list' })
    expect(envelope).toEqual({ ok: true, summary: 'specrails_jobs(list) returned 2 of 9 jobs.', data: { jobs: [{ id: 'a' }, { id: 'b' }], total: 9 } })
  })

  it('uses a handler toolResponse over the summarizer meta, and omits empty fields', () => {
    const response = toolResponse({ x: 1 }, { summary: 'Mine.', next: [{ tool: 't', args: {}, why: 'w' }], ids: {}, truncated: false })
    expect(isToolResponse(response)).toBe(true)
    expect(isToolResponse({ data: 1 })).toBe(false)
    const envelope = successEnvelope(response, { tool: 't', action: null, meta: { summary: 'Summarizer.', status: 'ok' } })
    expect(envelope).toEqual({ ok: true, summary: 'Mine.', status: 'ok', data: { x: 1 }, next: [{ tool: 't', args: {}, why: 'w' }], truncated: false })
  })

  it.each([
    [null, 'tool completed with no data.'],
    ['# Guide\n\nbody', 'tool returned text: Guide.'],
    [[1, 2, 3], 'tool returned 3 items.'],
    [{ ok: false }, 'tool reported a failure; see data for details.'],
    [{ status: 'queued' }, 'tool completed; status is queued.'],
    [{ a: 1 }, 'tool completed.'],
    [7, 'tool completed.'],
  ])('generic summary for %j', (data, summary) => {
    expect(genericSummary('tool', null, data)).toBe(summary)
  })

  it('validates against the advertised output schema (structuredContent contract)', () => {
    const schema = z.object(ENVELOPE_OUTPUT_SHAPE)
    expect(schema.safeParse(successEnvelope({ a: 1 }, { tool: 't', action: 'x', meta: { cursor: 5, partial: true } })).success).toBe(true)
    expect(schema.safeParse(errorEnvelope(new McpToolError('ambiguous', 'pick one', { choices: ['a'] }), 't', null)).success).toBe(true)
    expect(schema.safeParse({ ok: true }).success).toBe(false)
  })
})

describe('MCP response envelope: errors', () => {
  it.each([
    [400, undefined, 'invalid_input'], [422, undefined, 'invalid_input'], [401, undefined, 'unauthorized'],
    [403, undefined, 'unauthorized'], [404, undefined, 'not_found'], [409, undefined, 'conflict'],
    [429, undefined, 'rate_limited'], [502, undefined, 'provider_unavailable'], [503, undefined, 'provider_unavailable'],
    [500, undefined, 'internal'], [400, 'repository_required', 'ambiguous'], [403, 'tier_disabled', 'unauthorized'],
  ])('HTTP %i (%s) maps to %s', (status, backendCode, code) => {
    expect(codeForStatus(status, backendCode)).toBe(code)
  })

  it('normalizes a loopback API error to a prose message with route, backend code and retryability', () => {
    const err = new McpApiError('API POST /projects/p1/rails/0/launch → 409: {"error":"rail_busy","detail":"Rail 0 is running."}', 409,
      { error: 'rail_busy', detail: 'Rail 0 is running.' }, { method: 'POST', path: '/projects/p1/rails/0/launch' })
    expect(errorEnvelope(err, 'specrails_rails', 'launch')).toEqual({
      ok: false,
      summary: 'specrails_rails(launch) failed: Rail 0 is running.',
      error: { code: 'conflict', message: 'Rail 0 is running.', retryable: false, backendCode: 'rail_busy', http: { method: 'POST', path: '/projects/p1/rails/0/launch', status: 409 } },
    })
  })

  it('marks provider outages and rate limits retryable', () => {
    const outage = errorEnvelope(new McpApiError('x', 502, { error: 'Usage limit reached for today', code: 'SIDE_QUESTION_FAILED' }, { method: 'POST', path: '/p' }), 't', 'a')
    expect(outage.error).toMatchObject({ code: 'provider_unavailable', retryable: true, message: 'Usage limit reached for today', backendCode: 'SIDE_QUESTION_FAILED' })
    expect(errorEnvelope(new McpApiError('x', 429, { error: 'Too many queued inputs' }, { method: 'POST', path: '/p' }), 't', null).error).toMatchObject({ code: 'rate_limited', retryable: true })
    expect(errorEnvelope(new McpApiError('x', 500, ''), 't', null).error.message).toBe('x')
    expect(errorEnvelope(new McpApiError('x', 500, null, { method: 'GET', path: '/p' }), 't', null).error.message).toBe('The request failed with HTTP 500.')
  })

  it('turns an in-process repository selector error into ambiguous with the valid choices', () => {
    const repositories = [{ id: 'r1', name: 'api' }, { id: 'r2', name: 'web' }]
    const err = new McpApiError(`Provide repositoryId for this multi-repository project: ${JSON.stringify({ error: 'repository_required', repositories })}`, 400, { error: 'repository_required', projectId: 'p1', repositories })
    expect(errorEnvelope(err, 'specrails_code', 'read_file').error).toEqual({
      code: 'ambiguous', message: 'Provide repositoryId for this multi-repository project', retryable: false, choices: repositories, backendCode: 'repository_required',
    })
  })

  it('keeps an McpToolError code, choices, next and resend verbatim', () => {
    const err = new McpToolError('confirmation_required', 'Confirm first.', { resend: { tool: 't', args: { confirm: true } }, next: [{ tool: 't', args: { confirm: true }, why: 'w' }] })
    expect(errorEnvelope(err, 't', 'delete').error).toEqual({
      code: 'confirmation_required', message: 'Confirm first.', retryable: false,
      resend: { tool: 't', args: { confirm: true } }, next: [{ tool: 't', args: { confirm: true }, why: 'w' }],
    })
    expect(errorEnvelope(new McpToolError('provider_unavailable', 'later'), 't', null).error.retryable).toBe(true)
    expect(errorEnvelope(new McpToolError('not_found', 'gone', { retryable: true }), 't', null).error.retryable).toBe(true)
  })

  it.each([
    ['This action requires the "Destructive" permission tier, which is currently disabled.', 'unauthorized'],
    ['Unknown projectId "x". Use specrails_projects(list) to see valid ids.', 'not_found'],
    ['get requires a "jobId".', 'invalid_input'],
    ['Ambiguous project path; provide an explicit projectId.', 'ambiguous'],
    ['fetch failed', 'provider_unavailable'],
    ['Rail is busy', 'conflict'],
    ['boom', 'internal'],
  ])('classifies a thrown message: %s', (message, code) => {
    expect(codeForMessage(message)).toBe(code)
    expect(errorEnvelope(new Error(message), 't', null).error.code).toBe(code)
  })

  it('maps an aborted request to a retryable provider_unavailable and accepts non-Error throws', () => {
    const abort = new Error('This operation was aborted'); abort.name = 'AbortError'
    expect(errorEnvelope(abort, 't', null).error).toMatchObject({ code: 'provider_unavailable', retryable: true })
    expect(errorEnvelope('plain', 't', null)).toMatchObject({ ok: false, summary: 't failed: plain', error: { code: 'internal' } })
  })

  it('reads prose out of REST bodies', () => {
    expect(backendMessage({ error: 'not_a_failed_job' })).toBe('not_a_failed_job')
    expect(backendMessage({ error: 'analysis_failed', detail: 'Provider said no' })).toBe('Provider said no')
    expect(backendMessage({ error: 'Rail is busy', detail: 'Wait.' })).toBe('Rail is busy Wait.')
    expect(backendMessage('  text  ')).toBe('text')
    expect(backendMessage({})).toBeNull()
    expect(backendMessage(42)).toBeNull()
  })
})
