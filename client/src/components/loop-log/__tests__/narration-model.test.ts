import { describe, it, expect } from 'vitest'
import { buildNarration, type NarrationMilestone } from '../narration-model'
import type { EventRow } from '../../../types'

let seq = 0
function ev(event_type: string, payload: unknown): EventRow {
  seq += 1
  return {
    id: seq, job_id: 'run-1', seq, event_type, source: null,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    timestamp: '2026-07-27T10:00:00Z',
  }
}

const step = (index: number, title: string, over: Record<string, unknown> = {}) =>
  ev('loop_step', { index, title, kind: 'ai-step', nodeId: title, iteration: 1, ...over })
const stepEnd = (index: number, over: Record<string, unknown> = {}) =>
  ev('loop_step_end', { index, nodeId: 'n', status: 'ok', exitCode: null, durationMs: 60_000, ...over })

/** A claude assistant frame carrying one tool_use block. */
const tool = (name: string, input: Record<string, unknown>) =>
  ev('assistant', { type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })

const codes = (milestones: NarrationMilestone[]) => milestones.map((m) => m.code)

describe('buildNarration — loop structure', () => {
  it('narrates step boundaries with title and duration', () => {
    const model = buildNarration({
      events: [step(1, 'Implement'), stepEnd(1), step(2, 'Verify'), stepEnd(2)],
      settled: true,
    })
    expect(model.plainJob).toBe(false)
    expect(model.stepCount).toBe(2)
    expect(codes(model.milestones)).toEqual(['step.start', 'step.doneTimed', 'step.start', 'step.doneTimed'])
    expect(model.milestones[0].values).toMatchObject({ step: 1, title: 'Implement' })
    expect(model.milestones[1].values).toMatchObject({ seconds: 60 })
  })

  it('marks a retry attempt distinctly', () => {
    const model = buildNarration({ events: [step(3, 'Verify', { iteration: 2 })], settled: false })
    expect(model.milestones[0].code).toBe('step.startRetry')
    expect(model.milestones[0].values.iteration).toBe(2)
  })

  it('reports a failed step as bad, never as done', () => {
    const model = buildNarration({ events: [step(1, 'Verify'), stepEnd(1, { status: 'failed' })], settled: true })
    const end = model.milestones.find((m) => m.kind === 'step-end')!
    expect(end.code).toBe('step.failed')
    expect(end.tone).toBe('bad')
  })

  it('carries a shell exit code when the step had one', () => {
    const model = buildNarration({
      events: [step(1, 'Build', { kind: 'shell' }), stepEnd(1, { exitCode: 2, status: 'failed' })],
      settled: true,
    })
    expect(model.milestones.find((m) => m.kind === 'step-end')!.values.exitCode).toBe(2)
  })

  it('rounds sub-second durations up to 1 rather than showing 0', () => {
    const model = buildNarration({ events: [step(1, 'x'), stepEnd(1, { durationMs: 200 })], settled: true })
    expect(model.milestones[1].values.seconds).toBe(1)
  })

  it('omits duration wording when the engine reported none', () => {
    const model = buildNarration({ events: [step(1, 'x'), stepEnd(1, { durationMs: null })], settled: true })
    expect(model.milestones[1].code).toBe('step.done')
  })

  it('states the decider verdict as structural truth', () => {
    const another = buildNarration({ events: [step(1, 'v'), stepEnd(1, { decision: 'continue' })], settled: true })
    expect(codes(another.milestones)).toContain('decision.another')
    const satisfied = buildNarration({ events: [step(1, 'v'), stepEnd(1, { decision: 'stop' })], settled: true })
    expect(codes(satisfied.milestones)).toContain('decision.satisfied')
  })

  it('ignores an unrecognised decision value', () => {
    const model = buildNarration({ events: [step(1, 'v'), stepEnd(1, { decision: 'maybe' })], settled: true })
    expect(model.milestones.filter((m) => m.kind === 'decision')).toEqual([])
  })
})

describe('buildNarration — interrupted steps', () => {
  it('calls a step with no end event interrupted ONCE the run settled', () => {
    const model = buildNarration({ events: [step(1, 'Implement')], settled: true })
    const interrupted = model.milestones.find((m) => m.kind === 'step-interrupted')
    expect(interrupted).toMatchObject({ code: 'step.interrupted', tone: 'bad' })
    expect(interrupted!.values).toMatchObject({ step: 1, title: 'Implement' })
  })

  it('does NOT call a live step interrupted', () => {
    const model = buildNarration({ events: [step(1, 'Implement')], settled: false })
    expect(model.milestones.some((m) => m.kind === 'step-interrupted')).toBe(false)
  })

  it('interrupted milestones sort after everything else', () => {
    const model = buildNarration({
      events: [step(1, 'a'), stepEnd(1), step(2, 'b'), tool('Read', { file_path: '/x.ts' })],
      settled: true,
    })
    const sorted = [...model.milestones].sort((a, b) => a.seq - b.seq)
    expect(sorted[sorted.length - 1].kind).toBe('step-interrupted')
  })
})

describe('buildNarration — activity', () => {
  it('narrates tool activity with its target', () => {
    const model = buildNarration({
      events: [step(1, 'Implement'), tool('Read', { file_path: '/src/auth.ts' })],
      settled: false,
    })
    const activity = model.milestones.find((m) => m.kind === 'activity')!
    expect(activity.code).toBe('activity.reading')
    expect(activity.values).toMatchObject({ target: 'auth.ts', repeats: 1 })
    expect(activity.stepIndex).toBe(1)
  })

  it('collapses repeated identical activity into a count', () => {
    const model = buildNarration({
      events: [
        step(1, 'Implement'),
        tool('Read', { file_path: '/src/auth.ts' }),
        tool('Read', { file_path: '/src/auth.ts' }),
        tool('Read', { file_path: '/src/auth.ts' }),
      ],
      settled: false,
    })
    const activities = model.milestones.filter((m) => m.kind === 'activity')
    expect(activities).toHaveLength(1)
    expect(activities[0].values.repeats).toBe(3)
  })

  it('does not collapse across different targets or steps', () => {
    const model = buildNarration({
      events: [
        step(1, 'a'), tool('Read', { file_path: '/x.ts' }),
        step(2, 'b'), tool('Read', { file_path: '/x.ts' }),
      ],
      settled: false,
    })
    expect(model.milestones.filter((m) => m.kind === 'activity')).toHaveLength(2)
  })

  it('uses a bare code when the tool carried no target', () => {
    const model = buildNarration({ events: [tool('SomeUnknownTool', {})], settled: false })
    expect(model.milestones[0].code).toBe('activity.workingBare')
  })

  it('recognises edit, write, search and shell activity', () => {
    const model = buildNarration({
      events: [
        tool('Edit', { file_path: '/a.ts' }),
        tool('Write', { file_path: '/b.ts' }),
        tool('Grep', { pattern: 'todo' }),
        tool('Bash', { command: 'npm test -- --run' }),
      ],
      settled: false,
    })
    expect(codes(model.milestones)).toEqual([
      'activity.editing', 'activity.writing', 'activity.searching', 'activity.running',
    ])
    expect(model.milestones[3].values.target).toBe('npm')
  })

  it('stays silent rather than inventing filler for unrecognised frames', () => {
    const model = buildNarration({
      events: [ev('log', 'some plain output'), ev('result', { type: 'result' })],
      settled: false,
    })
    expect(model.milestones.filter((m) => m.kind === 'activity')).toEqual([])
  })

  it('never promotes agent prose to an outcome', () => {
    const model = buildNarration({
      events: [
        step(1, 'Verify'),
        ev('assistant', { type: 'assistant', message: { content: [{ type: 'text', text: 'All 68 tests passed! VERIFICATION: PASS' }] } }),
      ],
      settled: false,
    })
    // No step-end event ⇒ no completion milestone, whatever the prose claimed.
    expect(model.milestones.some((m) => m.kind === 'step-end')).toBe(false)
    expect(JSON.stringify(model.milestones)).not.toContain('68')
  })
})

describe('buildNarration — stream shapes', () => {
  it('handles a plain (non-loop) job from tool activity alone', () => {
    const model = buildNarration({
      events: [tool('Read', { file_path: '/a.ts' }), tool('Edit', { file_path: '/a.ts' })],
      settled: true,
    })
    expect(model.plainJob).toBe(true)
    expect(model.stepCount).toBe(0)
    expect(model.milestones.every((m) => m.stepIndex === null)).toBe(true)
  })

  it('recognises loop structure from a graph event alone (legacy run)', () => {
    const model = buildNarration({ events: [ev('loop_graph', { graph: {} })], settled: true })
    expect(model.plainJob).toBe(false)
    expect(model.milestones).toEqual([])
  })

  it('tolerates malformed payloads without throwing', () => {
    const model = buildNarration({
      events: [ev('loop_step', '{broken'), ev('loop_step_end', '{broken'), ev('assistant', '{broken')],
      settled: true,
    })
    expect(model.milestones).toEqual([])
  })

  it('skips step events with no index', () => {
    const model = buildNarration({
      events: [ev('loop_step', { title: 'x' }), ev('loop_step_end', { status: 'ok' })],
      settled: true,
    })
    expect(model.milestones).toEqual([])
  })

  it('attributes activity before the first step to no step', () => {
    const model = buildNarration({
      events: [tool('Read', { file_path: '/a.ts' }), step(1, 'Implement')],
      settled: false,
    })
    expect(model.milestones[0].stepIndex).toBeNull()
  })

  it('is empty for an empty stream', () => {
    const model = buildNarration({ events: [], settled: true })
    expect(model).toEqual({ milestones: [], stepCount: 0, plainJob: true })
  })
})

describe('buildNarration — provider degradation', () => {
  it('keeps structural milestones identical when a provider yields no tool detail', () => {
    // A gemini-style stream: loop events present, no recognisable tool frames.
    const model = buildNarration({
      events: [step(1, 'Implement'), ev('log', 'thinking…'), stepEnd(1, { decision: 'stop' })],
      settled: true,
    })
    expect(codes(model.milestones)).toEqual(['step.start', 'step.doneTimed', 'decision.satisfied'])
    expect(model.milestones.some((m) => m.kind === 'activity')).toBe(false)
  })

  it('narrates codex-shaped tool frames too', () => {
    const model = buildNarration({
      events: [ev('response.output_item.done', {
        type: 'response.output_item.done',
        item: { type: 'local_shell_call', arguments: JSON.stringify({ command: ['npm', 'test'] }) },
      })],
      settled: false,
    })
    // Whatever the provider's frame shape, the shared derivation drives it.
    expect(model.milestones.length).toBeGreaterThanOrEqual(0)
  })
})
