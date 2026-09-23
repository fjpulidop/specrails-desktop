import { describe, expect, it } from 'vitest'
import { parseProgrammaticUsage } from './agent-runtime-accounting'

const event = (id: string, type: string, values: Record<string, unknown> = {}) => JSON.stringify({ type: 'workflow-event', event: { id, type, ...values } })
const terminal = (invocationUsage: unknown, status = 'succeeded') => JSON.stringify({ type: 'runtime-result', status, invocationUsage })
const measured = { costUsd: 0.5, inputTokens: 20, outputTokens: 10 }

describe('parseProgrammaticUsage', () => {
  it('leaves legacy adapter streams and malformed JSON untouched', () => {
    expect(parseProgrammaticUsage(['not-json', 'null', '[]', JSON.stringify({ type: 'result', total_cost_usd: 10 }), JSON.stringify({ type: 'workflow-event' }), JSON.stringify({ type: 'workflow-event', event: { type: 'step_succeeded' } })])).toBeUndefined()
  })

  it('uses authoritative invocation totals once instead of adding phase measurements again', () => {
    const rows = [event('s1', 'step_succeeded', { attemptId: 'a1', usage: measured }), terminal({ costUsd: 2, inputTokens: 200, outputTokens: 100 })]
    expect(parseProgrammaticUsage([...rows, rows[1]])).toEqual({ provider: 'agent-runtime', model: 'per-role', cost: 2, tokensIn: 200, tokensOut: 100, tokens: 300, estimated: false, failed: false })
  })

  it('never fills unknown terminal measurements with partial phase data', () => {
    const parsed = parseProgrammaticUsage([event('e1', 'step_succeeded', { usage: measured }), terminal({ costUsd: null, inputTokens: 70, outputTokens: null }, 'paused')])
    expect(parsed).toEqual({ provider: 'agent-runtime', model: 'per-role', cost: undefined, tokensIn: 70, tokensOut: undefined, tokens: undefined, estimated: true, failed: true })
  })

  it('deduplicates event IDs while summing separate completed attempts', () => {
    const completed = event('e2', 'step_succeeded', { attemptId: 'a1', usage: measured })
    const parsed = parseProgrammaticUsage([
      event('e1', 'step_started', { attemptId: 'a1' }), completed, completed,
      event('e3', 'step_started', { attemptId: 'a2' }),
      event('e4', 'step_failed', { attemptId: 'a2', usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 5 } }),
      event('e5', 'workflow_failed'),
    ])
    expect(parsed).toMatchObject({ cost: 0.75, tokensIn: 30, tokensOut: 15, tokens: 45, estimated: false, failed: true })
  })

  it('makes all inclusive figures unknown when a new attempt was in flight at the crash', () => {
    expect(parseProgrammaticUsage([
      event('e1', 'step_succeeded', { attemptId: 'a1', usage: measured }),
      event('e2', 'step_started', { attemptId: 'a2' }),
    ])).toMatchObject({ cost: undefined, tokensIn: undefined, tokensOut: undefined, tokens: undefined, estimated: true })
  })

  it('preserves unknown measurements independently for settled failed or interrupted steps', () => {
    const parsed = parseProgrammaticUsage([
      event('e1', 'step_started', { stepId: 'developer' }),
      event('e2', 'step_interrupted', { stepId: 'developer', usage: { costUsd: null, inputTokens: 4, outputTokens: 6 } }),
      event('e3', 'step_blocked', { usage: measured }),
      event('e4', 'step_paused', { usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 } }),
    ])
    expect(parsed).toMatchObject({ cost: undefined, tokensIn: 24, tokensOut: 16, tokens: 40, estimated: true })
  })

  it('does not invent zero for empty, missing or invalid usage', () => {
    expect(parseProgrammaticUsage([event('e1', 'workflow_started')])).toMatchObject({ cost: undefined, tokens: undefined })
    expect(parseProgrammaticUsage([JSON.stringify({ type: 'agent-event', role: 'developer' })])).toMatchObject({ cost: undefined, tokens: undefined })
    expect(parseProgrammaticUsage([event('e1', 'step_succeeded'), event('e2', 'step_succeeded', { usage: measured })])).toMatchObject({ cost: undefined, tokens: undefined })
    expect(parseProgrammaticUsage([terminal({ costUsd: -1, inputTokens: '100', outputTokens: 5 })])).toMatchObject({ cost: undefined, tokensIn: undefined, tokensOut: 5 })
  })

  it('retains explicitly reported zero and ignores lifetime totals from resumed workflows', () => {
    expect(parseProgrammaticUsage([JSON.stringify({ type: 'runtime-result', status: 'succeeded', usage: measured, invocationUsage: { costUsd: 0, inputTokens: 0, outputTokens: 0 } })])).toMatchObject({ cost: 0, tokens: 0, estimated: false })
    expect(parseProgrammaticUsage([JSON.stringify({ type: 'runtime-result', status: 'failed', usage: measured })])).toMatchObject({ cost: undefined, tokens: undefined, failed: true })
  })

  it('falls back to phase usage when an error frame omitted invocation accounting', () => {
    expect(parseProgrammaticUsage([event('e1', 'step_succeeded', { usage: measured }), JSON.stringify({ type: 'runtime-result', status: 'failed', error: 'Transport failed' })])).toMatchObject({ cost: 0.5, tokens: 30, failed: true })
  })

  it('rejects numeric overflow instead of certifying an infinite budget', () => {
    expect(parseProgrammaticUsage([event('e1', 'step_succeeded', { usage: { costUsd: 1e308, inputTokens: 1e308, outputTokens: 1 } }), event('e2', 'step_succeeded', { usage: { costUsd: 1e308, inputTokens: 1e308, outputTokens: 1 } })])).toMatchObject({ cost: undefined, tokensIn: undefined, tokensOut: 2, tokens: undefined })
  })
})
