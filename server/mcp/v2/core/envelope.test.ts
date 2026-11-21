import { describe, expect, it } from 'vitest'
import { McpApiError } from '../../tools/types'
import { McpToolError } from '../../tools/envelope'
import { V2ToolError, failure, result, success, textModeFor, toCallToolResult } from './envelope'

describe('envelope v2', () => {
  it('builds a success from plain data with the fallback summary', () => {
    expect(success({ a: 1 }, 'Done.')).toEqual({ v: 2, ok: true, summary: 'Done.', data: { a: 1 } })
    expect(success(undefined, 'Done.').data).toBeNull()
  })

  it('takes summary, refs, state, page, warnings and untrusted from a handler result', () => {
    const envelope = success(result([1], { summary: 'One run.', refs: { run: 'run:shop/1' }, page: { cursor: null, truncated: false }, warnings: ['w', 'w'], untrusted: ['/data/*/body'] }), 'fallback', ['x'])
    expect(envelope).toEqual({ v: 2, ok: true, summary: 'One run.', data: [1], refs: { run: 'run:shop/1' }, page: { cursor: null, truncated: false }, warnings: ['w', 'x'], untrusted: ['/data/*/body'] })
  })

  it('renders one minified copy in content and the envelope as structuredContent', () => {
    const envelope = success({ nested: { list: [1, 2] } }, 'Done.')
    const rendered = toCallToolResult(envelope)
    expect(rendered.structuredContent).toBe(envelope)
    expect(rendered.content).toEqual([{ type: 'text', text: JSON.stringify(envelope) }])
    expect((rendered.content[0] as { text: string }).text).not.toMatch(/\n/)
    expect(rendered.isError).toBeUndefined()
  })

  it('prefixes the summary for clients on a protocol without structured results', () => {
    expect(textModeFor('2025-03-26')).toBe('summary+json')
    expect(textModeFor('2025-06-18')).toBe('json')
    expect(textModeFor(undefined)).toBe('json')
    const text = (toCallToolResult(success(1, 'Done.'), 'summary+json').content[0] as { text: string }).text
    expect(text.split('\n')).toEqual(['Done.', JSON.stringify({ v: 2, ok: true, summary: 'Done.', data: 1 })])
  })

  it('maps v2 errors with their extra fields and marks the result as an error', () => {
    const fail = failure(new V2ToolError('confirmation_required', 'Confirm it.', { preview: { effect: 'x' }, confirmToken: 'ct1.x' }), 'specrails_runs(launch)')
    expect(fail).toEqual({ v: 2, ok: false, summary: 'specrails_runs(launch): Confirm it.', error: { code: 'confirmation_required', message: 'Confirm it.', retryable: false, preview: { effect: 'x' }, confirmToken: 'ct1.x' } })
    expect(failure(new V2ToolError('stale', 'Changed.'), 'x').error.retryable).toBe(true)
    expect(toCallToolResult(fail).isError).toBe(true)
  })

  it('keeps the v1 stable codes for v1 errors and loopback API errors', () => {
    expect(failure(new McpToolError('ambiguous', 'Pick one', { choices: [1] }), 'l').error).toMatchObject({ code: 'ambiguous', choices: [1] })
    const api = failure(new McpApiError('API GET /x → 409', 409, { error: 'rail_busy', message: 'Rail is busy' }, { method: 'GET', path: '/x' }), 'l')
    expect(api.error).toMatchObject({ code: 'conflict', backendCode: 'rail_busy', message: 'Rail is busy', http: { method: 'GET', path: '/x', status: 409 } })
    expect(failure(new Error('boom'), 'l').error.code).toBe('internal')
  })
})
