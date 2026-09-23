import { describe, it, expect } from 'vitest'
import { computeJobPhaseBreakdown, type RawJobEvent } from './job-phase-breakdown'

const MODEL = 'claude-sonnet-4-6'

function assistantEvent(opts: {
  parent?: string | null
  usage?: { in?: number; out?: number; cacheRead?: number; cacheCreate?: number } | null
  taskBlocks?: Array<{ id: string; subagent?: string; description?: string }>
  ts?: string
}): RawJobEvent {
  const content: unknown[] = (opts.taskBlocks ?? []).map((t) => ({
    type: 'tool_use',
    name: 'Task',
    id: t.id,
    input: { subagent_type: t.subagent, description: t.description },
  }))
  const message: Record<string, unknown> = { model: MODEL, content }
  if (opts.usage !== null) {
    message.usage = {
      input_tokens: opts.usage?.in ?? 0,
      output_tokens: opts.usage?.out ?? 0,
      cache_read_input_tokens: opts.usage?.cacheRead ?? 0,
      cache_creation_input_tokens: opts.usage?.cacheCreate ?? 0,
    }
  }
  return {
    event_type: 'assistant',
    timestamp: opts.ts ?? '2026-07-21T10:00:00Z',
    payload: JSON.stringify({ type: 'assistant', parent_tool_use_id: opts.parent ?? null, message }),
  }
}

function toolResultEvent(toolUseId: string, ts: string): RawJobEvent {
  return {
    event_type: 'user',
    timestamp: ts,
    payload: JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
    }),
  }
}

describe('computeJobPhaseBreakdown', () => {
  it('attributes usage to phases by parent_tool_use_id and prices it as estimated', () => {
    const events: RawJobEvent[] = [
      assistantEvent({ usage: { in: 100, out: 20 }, taskBlocks: [{ id: 'T1', subagent: 'sr-architect', description: 'design' }], ts: '2026-07-21T10:00:00Z' }),
      assistantEvent({ parent: 'T1', usage: { in: 1000, out: 500 } }),
      assistantEvent({ parent: 'T1', usage: { in: 2000, out: 300, cacheRead: 5000 } }),
      toolResultEvent('T1', '2026-07-21T10:05:00Z'),
      assistantEvent({ usage: { in: 50, out: 10 } }),
    ]
    const b = computeJobPhaseBreakdown(events)!
    expect(b.estimated).toBe(true)
    expect(b.phases).toHaveLength(1)
    const phase = b.phases[0]
    expect(phase.agent).toBe('sr-architect')
    expect(phase.description).toBe('design')
    expect(phase.tokensIn).toBe(3000)
    expect(phase.tokensOut).toBe(800)
    expect(phase.tokensCacheRead).toBe(5000)
    expect(phase.assistantEvents).toBe(2)
    expect(phase.estimatedCostUsd).toBeGreaterThan(0)
    expect(phase.durationMs).toBe(5 * 60_000)
    expect(b.orchestrator.tokensIn).toBe(150)
    expect(b.orchestrator.assistantEvents).toBe(2)
    expect(b.unattributed).toBeNull()
  })

  it('rolls nested Task spawns up into the root phase', () => {
    const events: RawJobEvent[] = [
      assistantEvent({ usage: { in: 10, out: 1 }, taskBlocks: [{ id: 'ROOT', subagent: 'sr-developer' }] }),
      // The developer spawns its own inner subagent...
      assistantEvent({ parent: 'ROOT', usage: { in: 100, out: 50 }, taskBlocks: [{ id: 'INNER', subagent: 'helper' }] }),
      // ...whose events must roll up into the sr-developer phase.
      assistantEvent({ parent: 'INNER', usage: { in: 700, out: 70 } }),
    ]
    const b = computeJobPhaseBreakdown(events)!
    expect(b.phases).toHaveLength(1)
    expect(b.phases[0].agent).toBe('sr-developer')
    expect(b.phases[0].tokensIn).toBe(800)
    expect(b.phases[0].tokensOut).toBe(120)
  })

  it('buckets orphan parents as unattributed and unnamed subagents as "subagent"', () => {
    const events: RawJobEvent[] = [
      assistantEvent({ taskBlocks: [{ id: 'T1' }], usage: { in: 1, out: 1 } }),
      assistantEvent({ parent: 'GHOST', usage: { in: 42, out: 7 } }),
    ]
    const b = computeJobPhaseBreakdown(events)!
    expect(b.phases[0].agent).toBe('subagent')
    expect(b.unattributed).not.toBeNull()
    expect(b.unattributed!.tokensIn).toBe(42)
  })

  it('returns null when no event carries a usage envelope (non-claude streams)', () => {
    const events: RawJobEvent[] = [
      { event_type: 'assistant', timestamp: null, payload: JSON.stringify({ type: 'assistant', message: { content: [] } }) },
      { event_type: 'user', timestamp: null, payload: 'not json' },
    ]
    expect(computeJobPhaseBreakdown(events)).toBeNull()
    expect(computeJobPhaseBreakdown([])).toBeNull()
  })

  it('leaves duration null for an unterminated phase and tolerates bad timestamps', () => {
    const events: RawJobEvent[] = [
      assistantEvent({ usage: { in: 1 }, taskBlocks: [{ id: 'T1', subagent: 'sr-reviewer' }], ts: 'garbage' }),
      assistantEvent({ parent: 'T1', usage: { in: 5, out: 5 } }),
    ]
    const b = computeJobPhaseBreakdown(events)!
    expect(b.phases[0].endedAt).toBeNull()
    expect(b.phases[0].durationMs).toBeNull()
  })
})
