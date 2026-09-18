import { describe, it, expect } from 'vitest'
import { finaliseInvocationResult } from './result-event'
import { estimateLocalCostUsd } from './pricing'
import { createLocalAdapter } from './providers/local-adapter'
import type { AdapterEvent } from './providers/types'

const usageEvents: AdapterEvent[] = [
  { kind: 'session-started', sessionId: 's' },
  { kind: 'result', payload: { type: 'result', usage: { input_tokens: 1200, output_tokens: 300 }, num_turns: 1, session_id: 's' } },
]
const conn = { id: 'local', kind: 'openai-compatible' as const, baseUrl: 'http://h/v1' }

describe('finaliseInvocationResult — local engines', () => {
  it('no rates → tokens recorded, cost undefined (NULL), estimated=false, no rate-card guess', () => {
    const { result, estimated } = finaliseInvocationResult(createLocalAdapter(conn), usageEvents, { fallbackModel: 'qwen' })
    expect(result).toMatchObject({ tokens_in: 1200, tokens_out: 300, model: 'qwen', session_id: 's' })
    expect(result.total_cost_usd).toBeUndefined()
    expect(estimated).toBe(false)
  })

  it('rates → cost from tokens, flagged estimated', () => {
    const adapter = createLocalAdapter({ ...conn, rates: { inputPer1M: 0.1, outputPer1M: 0.4 } })
    const { result, estimated } = finaliseInvocationResult(adapter, usageEvents)
    expect(result.total_cost_usd).toBeCloseTo(0.00024, 10)
    expect(estimated).toBe(true)
  })

  it('no billable usage → NULL even with rates; wall-clock duration fills in', () => {
    const adapter = createLocalAdapter({ ...conn, rates: { inputPer1M: 1, outputPer1M: 1 } })
    const { result, estimated } = finaliseInvocationResult(adapter, [{ kind: 'result', payload: { type: 'result' } }], { durationMs: 42 })
    expect(result.total_cost_usd).toBeUndefined()
    expect(estimated).toBe(false)
    expect(result.duration_ms).toBe(42)
  })

  it('estimateLocalCostUsd helper', () => {
    expect(estimateLocalCostUsd(null, { tokens_in: 1 })).toBeNull()
    expect(estimateLocalCostUsd(undefined, { tokens_in: 1 })).toBeNull()
    expect(estimateLocalCostUsd({ inputPer1M: 1, outputPer1M: 1 }, {})).toBeNull()
    expect(estimateLocalCostUsd({ inputPer1M: 2, outputPer1M: 4 }, { tokens_in: 1_000_000, tokens_out: 500_000 })).toBe(4)
  })
})
