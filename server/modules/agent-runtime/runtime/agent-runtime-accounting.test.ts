import { describe, expect, it } from 'vitest'
import { attributeProgrammaticUsage, parseProgrammaticUsage } from './agent-runtime-accounting'

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

const settled = (id: string, stepId: string, attemptId: string, usage?: Record<string, number | null>) => event(id, 'step_succeeded', { stepId, attemptId, ...(usage ? { usage } : {}) })
const call = (id: string, attemptId: string, payload: Record<string, unknown>) => JSON.stringify({ type: 'runtime-efficiency-event', eventId: id, attemptId, kind: 'role-context', payload })

describe('attributeProgrammaticUsage', () => {
  it('splits the total by phase with the provider and model each attempt used', () => {
    const shares = attributeProgrammaticUsage([
      call('c1', 'a1', { provider: 'claude', model: 'opus', durationMs: 100 }), settled('e1', 'architect', 'a1', { costUsd: 0.1, inputTokens: 10, outputTokens: 1 }),
      call('c2', 'a2', { provider: 'codex', model: 'gpt-6.1-sol' }), settled('e2', 'developer', 'a2', { costUsd: 0.2, inputTokens: 20, outputTokens: 2 }),
      call('c3', 'a3', { provider: 'codex', model: 'gpt-6.1-sol' }), settled('e3', 'developer', 'a3', { costUsd: 0.4, inputTokens: 40, outputTokens: 4 }),
    ], { cost: 0.7, tokensIn: 70, tokensOut: 7 })!
    expect(shares.map(({ stepId, provider, model, tokensIn }) => ({ stepId, provider, model, tokensIn }))).toEqual([
      { stepId: 'architect', provider: 'claude', model: 'opus', tokensIn: 10 },
      { stepId: 'developer', provider: 'codex', model: 'gpt-6.1-sol', tokensIn: 60 },
    ])
    // Float residue lands on a share: the rows sum to the invocation total exactly.
    expect(shares.reduce((sum, share) => sum + share.cost!, 0)).toBe(0.7)
    expect(shares[0].durationMs).toBe(100)
  })

  it('uses per-call usage when an attempt escalated to another provider', () => {
    const shares = attributeProgrammaticUsage([
      call('c1', 'a1', { provider: 'claude', model: 'sonnet', usage: { costUsd: 0.1, inputTokens: 10, outputTokens: 1 } }),
      call('c2', 'a1', { provider: 'codex', model: 'gpt-6.1-sol', usage: { costUsd: 0.3, inputTokens: 30, outputTokens: 3 } }),
      settled('e1', 'developer', 'a1', { costUsd: 0.4, inputTokens: 40, outputTokens: 4 }),
    ], { cost: 0.4, tokensIn: 40, tokensOut: 4 })!
    expect(shares.map(share => [share.provider, share.tokensIn])).toEqual([['claude', 10], ['codex', 30]])
  })

  it('keeps an attempt with several providers and no per-call usage unattributed', () => {
    const shares = attributeProgrammaticUsage([
      call('c1', 'a1', { provider: 'claude', model: 'opus' }), settled('e1', 'architect', 'a1', { costUsd: 0.1, inputTokens: 10, outputTokens: 1 }),
      call('c2', 'a2', { provider: 'claude', model: 'sonnet' }), call('c3', 'a2', { provider: 'codex', model: 'gpt-6.1-sol' }),
      settled('e2', 'developer', 'a2', { costUsd: 0.2, inputTokens: 20, outputTokens: 2 }),
    ], { cost: 0.3, tokensIn: 30, tokensOut: 3 })!
    expect(shares.map(share => [share.stepId, share.provider, share.model])).toEqual([['architect', 'claude', 'opus'], ['developer', 'agent-runtime', 'per-role']])
  })

  it('keeps one model only when the calls agree on it', () => {
    const shares = attributeProgrammaticUsage([
      call('c1', 'a1', { provider: 'claude', model: 'opus' }), call('c2', 'a1', { provider: 'claude', model: 'sonnet' }),
      settled('e1', 'developer', 'a1', { costUsd: 1, inputTokens: 10, outputTokens: 1 }),
    ], { cost: 1, tokensIn: 10, tokensOut: 1 })!
    expect(shares).toEqual([expect.objectContaining({ provider: 'claude', model: null, cost: 1 })])
  })

  it('books a positive remainder (e.g. an in-flight attempt) as agent-runtime', () => {
    const shares = attributeProgrammaticUsage([
      call('c1', 'a1', { provider: 'claude', model: 'opus' }), settled('e1', 'architect', 'a1', { costUsd: 0.25, inputTokens: 10, outputTokens: 1 }),
    ], { cost: 1, tokensIn: 10, tokensOut: 5 })!
    expect(shares).toEqual([
      expect.objectContaining({ provider: 'claude', cost: 0.25, tokensIn: 10, tokensOut: 1 }),
      { stepId: null, provider: 'agent-runtime', model: 'per-role', cost: 0.75, tokensIn: 0, tokensOut: 4 },
    ])
  })

  it('refuses to split when the phases exceed the total or a known total has an unknown share', () => {
    const rows = [call('c1', 'a1', { provider: 'claude', model: 'opus' }), settled('e1', 'architect', 'a1', { costUsd: 2, inputTokens: 10, outputTokens: 1 })]
    expect(attributeProgrammaticUsage(rows, { cost: 1, tokensIn: 10, tokensOut: 1 })).toBeUndefined()
    const unknown = [call('c1', 'a1', { provider: 'codex', model: 'm' }), settled('e1', 'developer', 'a1', { costUsd: null, inputTokens: 10, outputTokens: 1 })]
    expect(attributeProgrammaticUsage(unknown, { cost: 1, tokensIn: 10, tokensOut: 1 })).toBeUndefined()
  })

  it('keeps an unknown total unknown on every share', () => {
    const shares = attributeProgrammaticUsage([
      call('c1', 'a1', { provider: 'codex', model: 'm' }), settled('e1', 'developer', 'a1', { costUsd: null, inputTokens: 10, outputTokens: 1 }),
    ], { cost: undefined, tokensIn: 10, tokensOut: 1 })!
    expect(shares).toEqual([{ stepId: 'developer', provider: 'codex', model: 'm', tokensIn: 10, tokensOut: 1 }])
  })

  it('returns undefined when the stream names no engine (older Cores, legacy adapters)', () => {
    expect(attributeProgrammaticUsage([settled('e1', 'architect', 'a1', measured)], { cost: 0.5, tokensIn: 20, tokensOut: 10 })).toBeUndefined()
    expect(attributeProgrammaticUsage(['not-json', JSON.stringify({ type: 'result' })], { cost: 1 })).toBeUndefined()
  })

  it('deduplicates replayed events', () => {
    const rows = [call('c1', 'a1', { provider: 'claude', model: 'opus' }), settled('e1', 'architect', 'a1', measured)]
    expect(attributeProgrammaticUsage([...rows, ...rows], { cost: 0.5, tokensIn: 20, tokensOut: 10 })).toEqual([
      expect.objectContaining({ provider: 'claude', cost: 0.5, tokensIn: 20, tokensOut: 10 }),
    ])
  })
})
