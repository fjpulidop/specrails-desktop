import { describe, it, expect, vi } from 'vitest'

// LogViewer (the parse pipeline source) imports react-markdown & friends —
// mock them so this pure-model test doesn't depend on their ESM internals.
vi.mock('react-markdown', () => ({ default: () => null }))
vi.mock('remark-gfm', () => ({ default: () => {} }))
vi.mock('rehype-highlight', () => ({ default: () => {} }))

import type { EventRow } from '../../../types'
import type { LoopGraph } from '../../../lib/loops-api'
import {
  groupByLoopStep,
  segmentStatus,
  cleanStepTitle,
  stepDisplayTitle,
  nodeKeyForSegment,
  buildChips,
  traversalOrder,
  formatStepDuration,
  type LoopStepSegment,
} from '../loop-log-model'

let nextId = 1
function ev(event_type: string, payload: unknown, opts: { source?: string; seq?: number } = {}): EventRow {
  return {
    id: nextId++,
    job_id: 'run-1',
    seq: opts.seq ?? 0,
    event_type,
    source: opts.source ?? 'stdout',
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    timestamp: '2026-07-04T10:00:00Z',
  }
}

function logEv(line: string): EventRow {
  return ev('log', { line })
}

function stepEv(index: number, kind: string, title: string, extra: Record<string, unknown> = {}): EventRow {
  return ev('loop_step', { index, kind, title, ...extra })
}

function endEv(index: number, extra: Record<string, unknown> = {}): EventRow {
  return ev('loop_step_end', { index, nodeId: 'n1', status: 'ok', exitCode: 0, durationMs: 1234, ...extra })
}

const GRAPH: LoopGraph = {
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 } },
    { id: 'ai1', type: 'ai-step', position: { x: 0, y: 100 }, data: { label: 'Implement' } },
    { id: 'sh1', type: 'shell', position: { x: 0, y: 200 } },
    { id: 'dec', type: 'decider', position: { x: 0, y: 300 } },
    { id: 'end', type: 'end', position: { x: 0, y: 400 } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'ai1' },
    { id: 'e2', source: 'ai1', target: 'sh1' },
    { id: 'e3', source: 'sh1', target: 'dec' },
    { id: 'e4', source: 'dec', target: 'ai1', branch: 'continue' },
    { id: 'e5', source: 'dec', target: 'end', branch: 'stop' },
  ],
  config: { maxIterations: 5, timeoutMinutes: 60 },
}

function graphEv(extra: Record<string, unknown> = {}): EventRow {
  return ev('loop_graph', {
    graph: GRAPH,
    loopId: 'loop-1',
    loopName: 'My Loop',
    provider: 'claude',
    model: 'sonnet',
    iterationLimit: 5,
    ...extra,
  })
}

describe('groupByLoopStep', () => {
  it('buckets pre-step lines into setup and per-step lines into segments', () => {
    const m = groupByLoopStep([
      logEv('▶ Loop "My Loop" started'),
      logEv('⎇ Isolated worktree: /tmp/w (branch b)'),
      stepEv(1, 'ai-step', '🤖 AI Step (claude/sonnet)', { nodeId: 'ai1', iteration: 0 }),
      logEv('Template: do the thing'),
      logEv('Command: /specrails:implement #1 --yes'),
      stepEv(2, 'shell', '⚡ Shell', { nodeId: 'sh1', iteration: 0 }),
      logEv('$ npm test'),
    ])
    expect(m.setup.map((l) => l.content)).toEqual([
      '▶ Loop "My Loop" started',
      '⎇ Isolated worktree: /tmp/w (branch b)',
    ])
    expect(m.segments).toHaveLength(2)
    expect(m.segments[0].meta).toMatchObject({ index: 1, kind: 'ai-step', nodeId: 'ai1', iteration: 0 })
    expect(m.segments[0].lines.map((l) => l.content)).toEqual([
      'Template: do the thing',
      'Command: /specrails:implement #1 --yes',
    ])
    expect(m.segments[1].lines.map((l) => l.content)).toEqual(['$ npm test'])
    expect(m.totalLines).toBe(5)
  })

  it('parses the loop_graph snapshot into graphMeta (and null when absent)', () => {
    const withGraph = groupByLoopStep([graphEv()])
    expect(withGraph.graphMeta).not.toBeNull()
    expect(withGraph.graphMeta?.loopName).toBe('My Loop')
    expect(withGraph.graphMeta?.iterationLimit).toBe(5)
    expect(withGraph.graphMeta?.graph.nodes).toHaveLength(5)

    const without = groupByLoopStep([logEv('hello')])
    expect(without.graphMeta).toBeNull()
  })

  it('tolerates LEGACY loop_step payloads without nodeId/iteration', () => {
    const m = groupByLoopStep([stepEv(1, 'shell', '⚡ Shell'), logEv('x')])
    expect(m.segments[0].meta.nodeId).toBeNull()
    expect(m.segments[0].meta.iteration).toBeNull()
    expect(m.maxIteration).toBe(0)
  })

  it('parses the optional template/command detail fields (legacy/absent → undefined)', () => {
    const m = groupByLoopStep([
      stepEv(1, 'ai-step', '🤖 AI Step', {
        nodeId: 'ai1',
        iteration: 1,
        template: '{{cmd:implement}}',
        command: '/specrails:implement #42 --yes',
      }),
      stepEv(2, 'shell', '⚡ Shell', { nodeId: 'sh1', iteration: 1 }), // no detail fields
      stepEv(3, 'ai-step', '🤖 AI Step', { nodeId: 'ai1', iteration: 1, template: 7, command: '' }), // wrong type / empty
    ])
    expect(m.segments[0].meta.template).toBe('{{cmd:implement}}')
    expect(m.segments[0].meta.command).toBe('/specrails:implement #42 --yes')
    expect(m.segments[1].meta.template).toBeUndefined()
    expect(m.segments[1].meta.command).toBeUndefined()
    expect(m.segments[2].meta.template).toBeUndefined()
    expect(m.segments[2].meta.command).toBeUndefined()
  })

  it('skips malformed loop_step / loop_step_end payloads without crashing', () => {
    const m = groupByLoopStep([
      ev('loop_step', 'not json {{{'),
      ev('loop_step', { kind: 'shell' }), // missing index
      logEv('still setup'),
      stepEv(1, 'shell', '⚡ Shell'),
      ev('loop_step_end', 'garbage'),
      ev('loop_step_end', { status: 'ok' }), // missing index
    ])
    expect(m.segments).toHaveLength(1)
    expect(m.segments[0].end).toBeNull()
    expect(m.setup.map((l) => l.content)).toEqual(['still setup'])
  })

  it('attaches loop_step_end to the LAST segment with that index (decision captured)', () => {
    const m = groupByLoopStep([
      stepEv(1, 'decider', '🔍 Loop Decider (iteration 1)', { nodeId: 'dec', iteration: 1 }),
      endEv(1, { nodeId: 'dec', decision: 'continue' }),
      stepEv(2, 'decider', '🔍 Loop Decider (iteration 2)', { nodeId: 'dec', iteration: 2 }),
      endEv(2, { nodeId: 'dec', decision: 'stop', durationMs: 900 }),
    ])
    expect(m.segments[0].end?.decision).toBe('continue')
    expect(m.segments[1].end?.decision).toBe('stop')
    expect(m.segments[1].end?.durationMs).toBe(900)
    expect(m.maxIteration).toBe(2)
  })

  it('drops the flat-log step divider line inside segments (header dedup)', () => {
    const m = groupByLoopStep([
      stepEv(1, 'shell', '⚡ Shell', { nodeId: 'sh1' }),
      logEv('\n━━━━━━ Step 1 · ⚡ Shell ━━━━━━'),
      logEv('$ ls'),
    ])
    expect(m.segments[0].lines.map((l) => l.content)).toEqual(['$ ls'])
  })

  it('assigns live frames (seq 0, arrival order) to the last-seen step', () => {
    const m = groupByLoopStep([
      stepEv(1, 'ai-step', '🤖 AI Step', { nodeId: 'ai1' }),
      logEv('first step line'),
      stepEv(2, 'shell', '⚡ Shell', { nodeId: 'sh1' }),
      // Live frames: seq 0, Date.now ids — assignment is pure arrival order
      ev('log', { line: 'live shell line' }, { seq: 0 }),
      ev('log', { line: 'another live line' }, { seq: 0 }),
    ])
    expect(m.segments[0].lines.map((l) => l.content)).toEqual(['first step line'])
    expect(m.segments[1].lines.map((l) => l.content)).toEqual(['live shell line', 'another live line'])
  })

  it('merges consecutive assistant lines and applies diff detection per segment', () => {
    const m = groupByLoopStep([
      stepEv(1, 'ai-step', '🤖 AI Step', { nodeId: 'ai1' }),
      logEv('--- a/f.ts'),
      logEv('+++ b/f.ts'),
      logEv('@@ -1,1 +1,1 @@'),
      logEv('+added'),
      logEv('-removed'),
    ])
    const types = m.segments[0].lines.map((l) => l.type)
    expect(types).toEqual(['diff-meta', 'diff-meta', 'diff-hunk', 'diff-add', 'diff-remove'])
  })

  it('derives the running-step live activity label from streamed frames', () => {
    const m = groupByLoopStep([
      stepEv(1, 'ai-step', '🤖 AI Step', { nodeId: 'ai1' }),
      ev('assistant', {
        message: {
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/app.ts' } }],
        },
      }),
    ])
    expect(m.segments[0].lastActivity).toEqual({ actionKey: 'editing', actionArg: 'app.ts' })
  })
})

describe('segmentStatus', () => {
  const seg = (end: LoopStepSegment['end']): LoopStepSegment => ({
    key: 'step-0-1',
    meta: { index: 1, kind: 'shell', title: 'Shell', nodeId: null, iteration: null },
    lines: [],
    end,
    lastActivity: null,
  })
  const okEnd = { index: 1, nodeId: null, status: 'ok' as const, exitCode: 0, durationMs: 10 }

  it('maps end status directly', () => {
    expect(segmentStatus(seg(okEnd), { isLast: true, jobSettled: false })).toBe('ok')
    expect(segmentStatus(seg({ ...okEnd, status: 'failed' }), { isLast: false, jobSettled: true })).toBe('failed')
  })

  it('last step without end: running while live, interrupted once settled', () => {
    expect(segmentStatus(seg(null), { isLast: true, jobSettled: false })).toBe('running')
    expect(segmentStatus(seg(null), { isLast: true, jobSettled: true })).toBe('interrupted')
  })

  it('non-last step without end (legacy runs) is unknown', () => {
    expect(segmentStatus(seg(null), { isLast: false, jobSettled: false })).toBe('unknown')
    expect(segmentStatus(seg(null), { isLast: false, jobSettled: true })).toBe('unknown')
  })
})

describe('title helpers', () => {
  it('cleanStepTitle strips the engine emoji prefix', () => {
    expect(cleanStepTitle('🤖 AI Step (claude/sonnet)')).toBe('AI Step (claude/sonnet)')
    expect(cleanStepTitle('⚡ Shell')).toBe('Shell')
    expect(cleanStepTitle('🔍 Loop Decider (iteration 3)')).toBe('Loop Decider (iteration 3)')
    expect(cleanStepTitle('Plain title')).toBe('Plain title')
  })

  it('stepDisplayTitle drops "(iteration N)" only when the iteration badge exists', () => {
    expect(
      stepDisplayTitle({ index: 1, kind: 'decider', title: '🔍 Loop Decider (iteration 3)', nodeId: 'd', iteration: 3 }),
    ).toBe('Loop Decider')
    expect(
      stepDisplayTitle({ index: 1, kind: 'decider', title: '🔍 Loop Decider (iteration 3)', nodeId: null, iteration: null }),
    ).toBe('Loop Decider (iteration 3)')
  })

  it('nodeKeyForSegment groups legacy decider iterations under one identity', () => {
    const mk = (title: string): LoopStepSegment => ({
      key: 'k',
      meta: { index: 1, kind: 'decider', title, nodeId: null, iteration: null },
      lines: [],
      end: null,
      lastActivity: null,
    })
    expect(nodeKeyForSegment(mk('🔍 Loop Decider (iteration 1)'))).toBe(
      nodeKeyForSegment(mk('🔍 Loop Decider (iteration 2)')),
    )
  })
})

describe('traversalOrder', () => {
  it('walks start → body → decider → end (continue branch first)', () => {
    expect(traversalOrder(GRAPH).map((n) => n.id)).toEqual(['start', 'ai1', 'sh1', 'dec', 'end'])
  })

  it('appends unreachable nodes at the end', () => {
    const g: LoopGraph = {
      ...GRAPH,
      nodes: [...GRAPH.nodes, { id: 'orphan', type: 'shell', position: { x: 0, y: 0 } }],
    }
    expect(traversalOrder(g).map((n) => n.id)).toEqual(['start', 'ai1', 'sh1', 'dec', 'end', 'orphan'])
  })
})

describe('buildChips', () => {
  it('graph mode: traversal-ordered chips with live states + decider verdict', () => {
    const m = groupByLoopStep([
      graphEv(),
      stepEv(1, 'ai-step', '🤖 AI Step', { nodeId: 'ai1', iteration: 0 }),
      endEv(1, { nodeId: 'ai1' }),
      stepEv(2, 'shell', '⚡ Shell', { nodeId: 'sh1', iteration: 0 }),
      endEv(2, { nodeId: 'sh1', status: 'failed', exitCode: 2 }),
      stepEv(3, 'decider', '🔍 Loop Decider (iteration 1)', { nodeId: 'dec', iteration: 1 }),
      endEv(3, { nodeId: 'dec', decision: 'continue' }),
      stepEv(4, 'ai-step', '🤖 AI Step', { nodeId: 'ai1', iteration: 1 }),
    ])
    const chips = buildChips(m, { jobSettled: false, jobFailed: false })
    expect(chips.map((c) => c.key)).toEqual(['start', 'ai1', 'sh1', 'dec', 'end'])
    const byKey = Object.fromEntries(chips.map((c) => [c.key, c]))
    expect(byKey.start.state).toBe('ok')
    expect(byKey.ai1.state).toBe('running') // latest ai1 segment is live
    expect(byKey.ai1.label).toBe('Implement') // graph node label wins
    expect(byKey.sh1.state).toBe('failed')
    expect(byKey.dec.state).toBe('ok')
    expect(byKey.dec.decision).toBe('continue')
    expect(byKey.end.state).toBe('pending')
    expect(byKey.ai1.latestSegmentKey).toBe(m.segments[3].key)
  })

  it('graph mode: end chip resolves ok/failed once the run settles', () => {
    const m = groupByLoopStep([graphEv()])
    expect(buildChips(m, { jobSettled: true, jobFailed: false }).find((c) => c.key === 'end')?.state).toBe('ok')
    expect(buildChips(m, { jobSettled: true, jobFailed: true }).find((c) => c.key === 'end')?.state).toBe('failed')
  })

  it('graph mode: interrupted state for a no-end last step on a settled run', () => {
    const m = groupByLoopStep([
      graphEv(),
      stepEv(1, 'ai-step', '🤖 AI Step', { nodeId: 'ai1', iteration: 0 }),
      logEv('partial output'),
    ])
    const chips = buildChips(m, { jobSettled: true, jobFailed: true })
    expect(chips.find((c) => c.key === 'ai1')?.state).toBe('interrupted')
  })

  it('legacy mode (no loop_graph): derives a linear strip from the seen steps', () => {
    const m = groupByLoopStep([
      stepEv(1, 'ai-step', '🤖 Fix bug'),
      endEv(1, { nodeId: null }),
      stepEv(2, 'decider', '🔍 Loop Decider (iteration 1)'),
      endEv(2, { nodeId: null, decision: 'continue' }),
      stepEv(3, 'ai-step', '🤖 Fix bug'), // second iteration of the SAME node
    ])
    const chips = buildChips(m, { jobSettled: false, jobFailed: false })
    expect(chips).toHaveLength(2)
    expect(chips[0].kind).toBe('ai-step')
    expect(chips[0].label).toBe('Fix bug')
    expect(chips[0].state).toBe('running') // latest occurrence is live
    expect(chips[0].latestSegmentKey).toBe(m.segments[2].key)
    expect(chips[1].kind).toBe('decider')
    expect(chips[1].decision).toBe('continue')
  })
})

describe('formatStepDuration', () => {
  it('formats ms / seconds / minutes / hours', () => {
    expect(formatStepDuration(420)).toBe('420ms')
    expect(formatStepDuration(4200)).toBe('4.2s')
    expect(formatStepDuration(125_000)).toBe('2m 5s')
    expect(formatStepDuration(3_720_000)).toBe('1h 2m')
    expect(formatStepDuration(-5)).toBe('—')
  })
})

describe('provider limit (loop.provider_limit)', () => {
  it('keeps the provider_limit reason on a failed end', () => {
    const model = groupByLoopStep([
      stepEv(1, 'ai-step', 'Implement'),
      endEv(1, { status: 'failed', reason: 'provider_limit', exitCode: null }),
    ])
    expect(model.segments[0].end).toMatchObject({ status: 'failed', reason: 'provider_limit' })
    expect(segmentStatus(model.segments[0], { isLast: true, jobSettled: true })).toBe('failed')
    // Unknown reasons are dropped, never invented.
    const other = groupByLoopStep([stepEv(1, 'ai-step', 'x'), endEv(1, { status: 'failed', reason: 'weird' })])
    expect(other.segments[0].end?.reason).toBeUndefined()
  })
})

describe('stalled steps (loop-step-idle)', () => {
  it('parses a stalled end with its reason and idle budget', () => {
    const model = groupByLoopStep([
      stepEv(1, 'ai-step', 'Implement'),
      logEv('working'),
      endEv(1, { status: 'stalled', reason: 'idle_timeout', idleMs: 1_800_000, exitCode: null }),
      stepEv(2, 'ai-step', 'Implement', { attempt: 2 }),
      endEv(2),
    ])
    expect(model.segments).toHaveLength(2)
    expect(model.segments[0].end).toMatchObject({ status: 'stalled', reason: 'idle_timeout', idleMs: 1_800_000 })
    expect(segmentStatus(model.segments[0], { isLast: false, jobSettled: false })).toBe('stalled')
    expect(model.segments[1].end?.status).toBe('ok')
  })

  it('an unknown reason / non-numeric idleMs are dropped, never guessed', () => {
    const model = groupByLoopStep([stepEv(1, 'ai-step', 'X'), endEv(1, { status: 'stalled', reason: 'weird', idleMs: 'x' })])
    expect(model.segments[0].end?.status).toBe('stalled')
    expect(model.segments[0].end?.reason).toBeUndefined()
    expect(model.segments[0].end?.idleMs).toBeUndefined()
  })

  it('a stalled attempt reads as failed on the node chip (section keeps the detail)', () => {
    const model = groupByLoopStep([
      graphEv(),
      stepEv(1, 'ai-step', 'Implement', { nodeId: 'ai1' }),
      endEv(1, { status: 'stalled', reason: 'idle_timeout', idleMs: 60_000 }),
    ])
    const chip = buildChips(model, { jobSettled: true, jobFailed: true }).find((c) => c.key === 'ai1')
    expect(chip?.state).toBe('failed')
  })
})
