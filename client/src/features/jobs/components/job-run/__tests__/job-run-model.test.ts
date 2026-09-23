import { describe, it, expect, beforeEach } from 'vitest'
import {
  INITIAL_ACTIVITY,
  activityReducer,
  computePipelineTotals,
  extractModifiedFiles,
  finalMetricsFor,
  formatPipelineCost,
  formatPipelineTokens,
  formatWallClock,
  loadJobRunDetailsOpen,
  resolveActivityLabel,
  saveJobRunDetailsOpen,
  JOB_RUN_DETAILS_KEY,
} from '../job-run-model'
import type { EventRow, JobSummary } from '../../../../../types'

function assistantTool(seq: number, name: string, input: Record<string, unknown>, usage?: Record<string, unknown>): EventRow {
  return { id: seq, job_id: 'j', seq, event_type: 'assistant', payload: JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }], ...(usage ? { usage } : {}) } }), timestamp: '' }
}
function assistantText(seq: number, usage?: Record<string, unknown>): EventRow {
  return { id: seq, job_id: 'j', seq, event_type: 'assistant', payload: JSON.stringify({ message: { content: [{ type: 'text', text: 'hi' }], ...(usage ? { usage } : {}) } }), timestamp: '' }
}
function consume(events: EventRow[], state = INITIAL_ACTIVITY) {
  return activityReducer(state, { type: 'consume', events })
}

describe('formatWallClock', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatWallClock('2024-03-21T10:00:00Z', '2024-03-21T10:00:30Z')).toBe('30s')
    expect(formatWallClock('2024-03-21T10:00:00Z', '2024-03-21T10:01:02Z')).toBe('1m 2s')
    expect(formatWallClock('2024-03-21T10:00:00Z', '2024-03-21T12:05:00Z')).toBe('2h 5m')
  })
  it('accepts a Date.now() reading for the live ticker', () => {
    const start = new Date(Date.now() - 65_000).toISOString()
    expect(formatWallClock(start, Date.now())).toMatch(/^1m \d+s$/)
  })
  it('returns an em-dash for unknown or negative spans', () => {
    expect(formatWallClock(null, '2024-03-21T10:00:00Z')).toBe('—')
    expect(formatWallClock('2024-03-21T10:00:00Z', null)).toBe('—')
    expect(formatWallClock('2024-03-21T10:00:00Z', '2024-03-21T09:00:00Z')).toBe('—')
  })
})

describe('activityReducer', () => {
  it('counts steps and labels the last claude tool action', () => {
    const s = consume([assistantTool(1, 'Read', { file_path: 'src/x.ts' }), assistantTool(2, 'Edit', { file_path: 'src/queue-manager.ts' })])
    expect(s.steps).toBe(2)
    expect(s.actionKey).toBe('editing')
    expect(s.actionArg).toBe('queue-manager.ts')
  })

  it('counts every parallel tool_use block in one frame as a step', () => {
    const multi: EventRow = {
      id: 1, job_id: 'j', seq: 1, event_type: 'assistant', timestamp: '',
      payload: JSON.stringify({ message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
        { type: 'tool_use', name: 'Read', input: { file_path: 'b.ts' } },
        { type: 'tool_use', name: 'Read', input: { file_path: 'c.ts' } },
      ] } }),
    }
    const s = consume([multi])
    expect(s.steps).toBe(3)
    expect(s.actionArg).toBe('c.ts')
  })

  it('aggregates turns + tokens ONLY from assistant frames that carry usage', () => {
    const s = consume([
      assistantText(1, { input_tokens: 100, output_tokens: 20 }),
      assistantTool(2, 'Read', { file_path: 'a.ts' }), // no usage ⇒ a step, not a turn
      assistantTool(3, 'Edit', { file_path: 'b.ts' }, { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 }),
    ])
    expect(s.steps).toBe(3)
    expect(s.turns).toBe(2)
    expect(s.tokens).toBe(100 + 20 + 5 + 5 + 1000 + 10)
  })

  it('tolerates malformed usage, primitive payloads and unparseable frames', () => {
    const events: EventRow[] = [
      { id: 1, job_id: 'j', seq: 1, event_type: 'assistant', payload: 'null', timestamp: '' },
      { id: 2, job_id: 'j', seq: 2, event_type: 'assistant', payload: '{ not json', timestamp: '' },
      { id: 3, job_id: 'j', seq: 3, event_type: 'assistant', payload: JSON.stringify({ message: { content: [{ type: 'text', text: 'x' }], usage: 'oops' } }), timestamp: '' },
      { id: 4, job_id: 'j', seq: 4, event_type: 'assistant', payload: JSON.stringify({ message: { content: [{ type: 'text', text: 'x' }], usage: { output_tokens: 'NaN' } } }), timestamp: '' },
      { id: 5, job_id: 'j', seq: 5, event_type: 'result', payload: '{}', timestamp: '' },
    ]
    const s = consume(events)
    expect(s.turns).toBe(1) // only the frame with a usage OBJECT counts
    expect(s.tokens).toBe(0)
    expect(s.steps).toBeGreaterThanOrEqual(1)
  })

  it('re-anchors after the events array is front-truncated instead of freezing', () => {
    let s = consume([assistantText(1), assistantText(2), assistantText(3)])
    expect(s.steps).toBe(3)
    s = consume([assistantText(2), assistantText(3)], s)
    s = consume([assistantText(2), assistantText(3), assistantText(4)], s)
    expect(s.steps).toBe(4)
  })

  it('is incremental — already-seen frames are never recounted', () => {
    const events = [assistantText(1), assistantText(2)]
    const s1 = consume(events)
    const s2 = consume(events, s1)
    expect(s2).toBe(s1)
  })

  it('resets to the initial state', () => {
    expect(activityReducer(consume([assistantText(1)]), { type: 'reset' })).toBe(INITIAL_ACTIVITY)
  })
})

describe('resolveActivityLabel', () => {
  it('reports connecting before any frame while running', () => {
    expect(resolveActivityLabel(INITIAL_ACTIVITY, true)).toEqual({ key: 'connecting', arg: null })
  })
  it('falls back to working when an arg action has an empty arg', () => {
    expect(resolveActivityLabel({ ...INITIAL_ACTIVITY, steps: 1, actionKey: 'running', actionArg: '' }, true)).toEqual({ key: 'working', arg: null })
  })
  it('carries the arg for arg actions and delegation', () => {
    expect(resolveActivityLabel({ ...INITIAL_ACTIVITY, steps: 1, actionKey: 'running', actionArg: 'npm' }, true)).toEqual({ key: 'running', arg: 'npm' })
    expect(resolveActivityLabel({ ...INITIAL_ACTIVITY, steps: 1, actionKey: 'delegating', actionArg: 'developer' }, true)).toEqual({ key: 'delegating', arg: 'developer' })
  })
})

describe('finalMetricsFor', () => {
  const job: JobSummary = { id: 'j', command: 'x', started_at: null, status: 'completed', total_cost_usd: 0.0234, tokens_in: 5000, tokens_out: 3000, num_turns: 8 }
  it('formats the authoritative figures', () => {
    expect(finalMetricsFor(job)).toEqual({ cost: '$0.0234', turns: '8', tokens: '8.0k' })
  })
  it('prefixes ~ for an estimated cost and includes cache tokens', () => {
    expect(finalMetricsFor({ ...job, total_cost_usd_estimated: 1, tokens_cache_read: 90_000, tokens_cache_create: 2_000 })).toEqual({ cost: '~$0.0234', turns: '8', tokens: '100.0k' })
  })
  it('returns null (never 0) when the provider reported nothing', () => {
    expect(finalMetricsFor({ ...job, total_cost_usd: null, tokens_in: null, tokens_out: null, num_turns: null })).toEqual({ cost: null, turns: null, tokens: null })
  })
})

describe('extractModifiedFiles', () => {
  it('extracts file paths from log lines and skips non-log / invalid frames', () => {
    const events: EventRow[] = [
      { id: 1, job_id: 'j', seq: 1, event_type: 'log', payload: JSON.stringify({ line: 'Writing file: src/components/MyComponent.tsx' }), timestamp: '' },
      { id: 2, job_id: 'j', seq: 2, event_type: 'log', payload: JSON.stringify({ line: 'Editing src/hooks/useHook.ts' }), timestamp: '' },
      { id: 3, job_id: 'j', seq: 3, event_type: 'log', payload: '{ invalid json }', timestamp: '' },
      { id: 4, job_id: 'j', seq: 4, event_type: 'phase', payload: JSON.stringify({ line: 'Writing fake.ts' }), timestamp: '' },
    ]
    expect(extractModifiedFiles(events)).toEqual(['src/components/MyComponent.tsx', 'src/hooks/useHook.ts'])
  })
})

describe('pipeline totals', () => {
  const base: JobSummary = { id: 'a', command: 'x', started_at: null, status: 'completed', total_cost_usd: 1, tokens_in: 1000, tokens_out: 500, tokens_cache_read: 0, tokens_cache_create: 0 }
  it('returns null for a single job', () => {
    expect(computePipelineTotals([base])).toBeNull()
  })
  it('sums and flags null / estimated phases (HIGH-10)', () => {
    const totals = computePipelineTotals([base, { ...base, id: 'b', total_cost_usd: null, total_cost_usd_estimated: 1, tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_create: null }])!
    expect(totals.jobCount).toBe(2)
    expect(totals.hasNullCost).toBe(true)
    expect(totals.nullCostCount).toBe(1)
    expect(totals.costEstimated).toBe(true)
    expect(totals.costUnavailable).toBe(false)
    expect(totals.nullTokenCount).toBe(1)
    expect(formatPipelineCost(totals)).toBe('~≥$1.0000')
    expect(formatPipelineTokens(totals)).toBe('≥1.5k')
  })
  it('renders unavailable instead of $0/0k for an all-Kimi pipeline', () => {
    const kimi = { ...base, total_cost_usd: null, tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_create: null }
    const totals = computePipelineTotals([kimi, { ...kimi, id: 'b' }])!
    expect(totals.costUnavailable).toBe(true)
    expect(totals.tokensUnavailable).toBe(true)
    expect(formatPipelineCost(totals)).toBe('—')
    expect(formatPipelineTokens(totals)).toBe('—')
  })
  it('renders a clean total when every phase reported', () => {
    const totals = computePipelineTotals([base, { ...base, id: 'b' }])!
    expect(formatPipelineCost(totals)).toBe('$2.0000')
    expect(formatPipelineTokens(totals)).toBe('3.0k')
  })
})

describe('details disclosure memory', () => {
  beforeEach(() => localStorage.clear())
  it('is collapsed by default and remembered per surface', () => {
    expect(loadJobRunDetailsOpen('page')).toBe(false)
    saveJobRunDetailsOpen('page', true)
    expect(loadJobRunDetailsOpen('page')).toBe(true)
    expect(loadJobRunDetailsOpen('glass')).toBe(false)
    saveJobRunDetailsOpen('glass', true)
    expect(JSON.parse(localStorage.getItem(JOB_RUN_DETAILS_KEY)!)).toEqual({ page: true, glass: true })
  })
  it('tolerates a corrupt stored value', () => {
    localStorage.setItem(JOB_RUN_DETAILS_KEY, '{oops')
    expect(loadJobRunDetailsOpen('page')).toBe(false)
    saveJobRunDetailsOpen('page', true)
    expect(loadJobRunDetailsOpen('page')).toBe(true)
  })
})
