import { describe, it, expect, vi } from 'vitest'
import { normaliseResultEvent, finaliseInvocationResult } from './result-event'
import './providers' // register claude+codex adapters
import { getAdapter } from './providers/registry'
import type { AdapterEvent } from './providers/types'

describe('normaliseResultEvent (legacy single-event API)', () => {
  it('returns empty object for null/undefined', () => {
    expect(normaliseResultEvent(null)).toEqual({})
    expect(normaliseResultEvent(undefined)).toEqual({})
  })

  it('parses a claude result event with full usage', () => {
    const r = normaliseResultEvent({
      type: 'result',
      total_cost_usd: 0.1234,
      num_turns: 3,
      model: 'claude-sonnet-4-6',
      duration_ms: 12000,
      api_duration_ms: 8000,
      session_id: 's1',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
      },
    })
    expect(r.tokens_in).toBe(100)
    expect(r.tokens_out).toBe(50)
    expect(r.tokens_cache_read).toBe(20)
    expect(r.tokens_cache_create).toBe(10)
    expect(r.total_cost_usd).toBe(0.1234)
    expect(r.num_turns).toBe(3)
    expect(r.model).toBe('claude-sonnet-4-6')
    expect(r.duration_ms).toBe(12000)
    expect(r.duration_api_ms).toBe(8000)
    expect(r.session_id).toBe('s1')
  })

  it('handles claude event missing usage gracefully', () => {
    const r = normaliseResultEvent({ type: 'result', total_cost_usd: 0 })
    expect(r.tokens_in).toBeUndefined()
    expect(r.tokens_out).toBeUndefined()
    expect(r.total_cost_usd).toBe(0)
  })

  it('parses a synthesised codex event with NULLs for missing fields', () => {
    const r = normaliseResultEvent(
      { type: 'result', total_cost_usd: 0, model: 'gpt-5.4-mini', duration_ms: 5000, num_turns: 1 },
      'codex',
    )
    expect(r.total_cost_usd).toBe(0)
    expect(r.model).toBe('gpt-5.4-mini')
    expect(r.duration_ms).toBe(5000)
    expect(r.num_turns).toBe(1)
    expect(r.tokens_in).toBeUndefined()
    expect(r.tokens_out).toBeUndefined()
  })
})

describe('finaliseInvocationResult (new adapter-aware API)', () => {
  it('claude: passes through native total_cost_usd, estimated=false', () => {
    const adapter = getAdapter('claude')
    const events: AdapterEvent[] = [
      { kind: 'session-started', sessionId: 'S1' },
      {
        kind: 'result',
        payload: {
          type: 'result',
          session_id: 'S1',
          total_cost_usd: 0.0123,
          num_turns: 1,
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]
    const { result, estimated } = finaliseInvocationResult(adapter, events)
    expect(estimated).toBe(false)
    expect(result.total_cost_usd).toBe(0.0123)
    expect(result.tokens_in).toBe(100)
    expect(result.tokens_out).toBe(50)
    expect(result.model).toBe('claude-sonnet-4-6')
  })

  it('codex: estimates cost from pricing table when model is in catalog', () => {
    const adapter = getAdapter('codex')
    // Use the parser to build the events array from a realistic JSONL fragment
    const lines = [
      '{"type":"thread.started","thread_id":"T1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1000000,"output_tokens":500000,"cached_input_tokens":200000,"reasoning_output_tokens":0}}',
    ]
    const events = lines
      .map((l) => adapter.parseStreamLine(l))
      .filter((e): e is AdapterEvent => e !== null)
    const { result, estimated } = finaliseInvocationResult(adapter, events, {
      fallbackModel: 'gpt-5.4-mini',
    })
    expect(estimated).toBe(true)
    // codex:gpt-5.4-mini → input 0.25, output 2.00, cache_read 0.025 per 1M
    // input_tokens (1M) INCLUDES cached_input_tokens (200K), so fresh input = 800K.
    // cost = 800K*0.25 + 500K*2.00 + 200K*0.025 / 1M = 0.20 + 1.00 + 0.005 = 1.205
    expect(result.total_cost_usd).toBeCloseTo(1.205, 5)
    expect(result.model).toBe('gpt-5.4-mini')
    expect(result.tokens_in).toBe(1_000_000)
    expect(result.tokens_out).toBe(500_000)
    expect(result.tokens_cache_read).toBe(200_000)
    expect(result.session_id).toBe('T1')
  })

  it('codex: no estimation when model is not in pricing table', () => {
    const adapter = getAdapter('codex')
    const events: AdapterEvent[] = [
      { kind: 'session-started', sessionId: 'T' },
      {
        kind: 'result',
        payload: {
          type: 'turn.completed',
          usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 },
        },
      },
    ]
    const { result, estimated } = finaliseInvocationResult(adapter, events, {
      fallbackModel: 'gpt-99-future-model',
    })
    expect(estimated).toBe(false)
    expect(result.total_cost_usd).toBeUndefined()
    expect(result.model).toBe('gpt-99-future-model')
    expect(result.tokens_in).toBe(100)
  })

  it('codex: warns once when a known model id has no pricing-table entry', () => {
    const adapter = getAdapter('codex')
    const events: AdapterEvent[] = [
      { kind: 'result', payload: { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      finaliseInvocationResult(adapter, events, { fallbackModel: 'gpt-99-future-model' })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('codex:gpt-99-future-model')
    } finally {
      warn.mockRestore()
    }
  })

  it('codex: does NOT warn when no model could be resolved (different failure mode)', () => {
    const adapter = getAdapter('codex')
    const events: AdapterEvent[] = [
      { kind: 'result', payload: { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      finaliseInvocationResult(adapter, events) // no fallbackModel → model undefined
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('codex: no estimation when no fallbackModel and adapter cannot derive', () => {
    const adapter = getAdapter('codex')
    const events: AdapterEvent[] = [
      { kind: 'session-started', sessionId: 'T' },
      {
        kind: 'result',
        payload: {
          type: 'turn.completed',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]
    const { result, estimated } = finaliseInvocationResult(adapter, events)
    expect(estimated).toBe(false)
    expect(result.model).toBeUndefined()
    expect(result.total_cost_usd).toBeUndefined()
  })

  it('codex: aborted turn with a priced model but EMPTY usage leaves cost NULL (no $0 estimate)', () => {
    // BUG-ANALYTICS-05: a codex turn that ends without a usage block (abort/
    // crash before turn.completed) must NOT estimate $0. With a known pricing
    // model the estimator would otherwise return the number 0 → persisted
    // total_cost_usd=0, estimated=1, diverging from the claude failed-row NULL.
    const adapter = getAdapter('codex')
    const events: AdapterEvent[] = [{ kind: 'session-started', sessionId: 'T' }]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { result, estimated } = finaliseInvocationResult(adapter, events, {
        fallbackModel: 'gpt-5.4-mini', // a model that IS in PRICING
      })
      expect(estimated).toBe(false)
      expect(result.total_cost_usd).toBeUndefined()
      expect(result.model).toBe('gpt-5.4-mini')
      // No usage → no estimation attempt → no misleading "no rate-card" warn.
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('codex: all-zero usage tokens with a priced model also leaves cost NULL', () => {
    const adapter = getAdapter('codex')
    const events: AdapterEvent[] = [
      {
        kind: 'result',
        payload: { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 } },
      },
    ]
    const { result, estimated } = finaliseInvocationResult(adapter, events, {
      fallbackModel: 'gpt-5.4-mini',
    })
    expect(estimated).toBe(false)
    expect(result.total_cost_usd).toBeUndefined()
  })

  it('passes the events through the adapter extractor (claude reasoning fold check N/A)', () => {
    const adapter = getAdapter('codex')
    const events: AdapterEvent[] = [
      { kind: 'session-started', sessionId: 'T' },
      {
        kind: 'result',
        payload: {
          type: 'turn.completed',
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            reasoning_output_tokens: 5, // codex folds reasoning into tokens_out
            cached_input_tokens: 20,
          },
        },
      },
    ]
    const { result } = finaliseInvocationResult(adapter, events, { fallbackModel: 'gpt-5.4-mini' })
    // adapter.extractResult folds reasoning into tokens_out
    expect(result.tokens_out).toBe(15)
  })

  it('honours the estimator hook for testing', () => {
    const adapter = getAdapter('codex')
    const events: AdapterEvent[] = [
      { kind: 'result', payload: { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
    const estimator = () => 0.42
    const { result, estimated } = finaliseInvocationResult(adapter, events, {
      fallbackModel: 'gpt-5.4-mini',
      estimator,
    })
    expect(estimated).toBe(true)
    expect(result.total_cost_usd).toBe(0.42)
  })

  it('empty events array returns the adapter default + estimated=false', () => {
    const adapter = getAdapter('claude')
    const { result, estimated } = finaliseInvocationResult(adapter, [])
    expect(estimated).toBe(false)
    expect(result.total_cost_usd).toBeUndefined()
  })
})
