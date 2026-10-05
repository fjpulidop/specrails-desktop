import { describe, expect, it } from 'vitest'
import type { EventRow } from '../../../../types'
import { groupByLoopStep } from '../../../loops/components/loop-log/loop-log-model'
import { jobEventsWithNotice, retainJobEvents } from '../job-event-buffer'

function event(seq: number, event_type = 'log', payload: unknown = { line: `line ${seq}` }): EventRow {
  return { id: seq, job_id: 'run', seq, event_type, source: 'stdout', timestamp: '2026-01-01T00:00:00Z', payload: JSON.stringify(payload) }
}

describe('job event display retention', () => {
  it('does not let invisible verification frames evict readable output or recorded steps', () => {
    const start = event(1, 'loop_step', { index: 1, title: 'verify', kind: 'core' })
    const line = event(2)
    const end = event(13_000, 'loop_step_end', { index: 1, status: 'ok' })
    const raw = Array.from({ length: 12_000 }, (_, index) => event(index + 3, 'verification-output', { text: 'raw diagnostic' }))
    const original = [start, line, ...raw, end]
    expect(retainJobEvents(original)).toEqual({ events: [start, line, end], omitted: false })
    expect(original).toHaveLength(12_003)
    expect(raw[0].payload).toBe('{"text":"raw diagnostic"}')
  })

  it('keeps lifecycle and check facts in arrival order across initial replay and live batches', () => {
    const start = event(90, 'loop_step', { index: 1, title: 'verify', kind: 'core' })
    const check = event(0, 'runtime-efficiency-event', { kind: 'check-started', payload: { repositoryId: 'repo', label: 'test' } })
    const finished = event(0, 'runtime-efficiency-event', { event: { kind: 'check-finished', payload: { exitCode: 0 } } })
    const end = event(1, 'loop_step_end', { index: 1, status: 'ok' })
    const completed = event(2, 'runtime-result', { status: 'succeeded' })
    const original = [start, check, ...Array.from({ length: 12_000 }, (_, index) => event(index + 3)), finished, end, completed]
    const replay = retainJobEvents(original)
    let live = retainJobEvents([])
    for (let index = 0; index < original.length; index += 137) live = retainJobEvents([...live.events, ...original.slice(index, index + 137)], live.omitted)
    expect(live).toEqual(replay)
    expect(replay.omitted).toBe(true)
    expect(replay.events.filter(item => item.event_type !== 'log')).toEqual([start, check, finished, end, completed])
    expect(replay.events.some(item => item.payload === '{"line":"line 3"}')).toBe(false)
    expect(replay.events.some(item => item.payload === '{"line":"line 12002"}')).toBe(true)
    const model = groupByLoopStep(jobEventsWithNotice(replay, 'Earlier output omitted; this copy contains the retained view.'))
    expect(model.segments).toHaveLength(1)
    expect(model.segments[0].end?.status).toBe('ok')
    expect(model.setup.map(item => item.content)).toEqual(['Earlier output omitted; this copy contains the retained view.'])
  })

  it('preserves every lifecycle kind and adds only one notice without consuming output capacity', () => {
    const kinds = ['loop_graph', 'runtime-graph', 'loop_step', 'loop_step_end', 'loop_completion', 'workflow-event', 'runtime-result', 'runtime-efficiency-event', 'result']
    const metadata = kinds.map((kind, index) => event(index, kind, {}))
    const retained = retainJobEvents([...metadata, ...Array.from({ length: 10_000 }, (_, index) => event(index + 100))])
    expect(retained.events.slice(0, kinds.length)).toEqual(metadata)
    expect(retained.events.filter(item => item.event_type === 'log')).toHaveLength(8_000)
    const view = jobEventsWithNotice(retained, 'Earlier output omitted')
    expect(view.filter(item => item.id === -1)).toHaveLength(1)
    expect(retainJobEvents(retained.events, retained.omitted)).toEqual(retained)
  })
})
