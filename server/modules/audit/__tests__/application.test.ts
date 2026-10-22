import { describe, expect, it, vi } from 'vitest'
import { createAgentAuditRecorder, createAgentAuditService, createStreamAuditTap, recordToolCall, type AgentAuditTimer } from '../application'
import type { AgentActionRow } from '../domain'
import type { AgentActionStore } from '../ports'

function manualClock() {
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  let now = 0
  return {
    schedule(fn: () => void, ms: number): AgentAuditTimer {
      const timer = { at: now + ms, fn, cancelled: false }
      timers.push(timer)
      return { cancel: () => { timer.cancelled = true } }
    },
    advance(ms: number) {
      now += ms
      for (const timer of timers.splice(0)) {
        if (timer.cancelled) continue
        if (timer.at <= now) timer.fn()
        else timers.push(timer)
      }
    },
    now: () => Date.parse('2026-10-21T10:00:00.000Z') + now,
    pending: () => timers.filter(t => !t.cancelled).length,
  }
}

const action = (target: string) => ({ runId: 'run-1', jobId: 'run-1', kind: 'read' as const, target, source: 'claude-stream' })

describe('batched recorder', () => {
  it('never writes inside record(); flushes on the interval in one batch', () => {
    const clock = manualClock()
    const batches: AgentActionRow[][] = []
    const recorder = createAgentAuditRecorder({ store: { insertMany: rows => { batches.push([...rows]) } }, schedule: clock.schedule, now: clock.now })
    recorder.record(action('a'))
    recorder.record([action('b'), action('c')])
    expect(batches).toEqual([])
    clock.advance(249)
    expect(batches).toEqual([])
    clock.advance(1)
    expect(batches.map(batch => batch.map(row => row.target))).toEqual([['a', 'b', 'c']])
    expect(recorder.stats()).toMatchObject({ recorded: 3, written: 3, failed: 0, pending: 0 })
  })

  it('flushes early once a full batch is pending, in batches of maxBatch', () => {
    const clock = manualClock()
    const sizes: number[] = []
    const recorder = createAgentAuditRecorder({ store: { insertMany: rows => { sizes.push(rows.length) } }, schedule: clock.schedule, now: clock.now, maxBatch: 2 })
    recorder.record(action('a'))
    recorder.record([action('b'), action('c')])
    clock.advance(0)
    expect(sizes).toEqual([2, 1])
  })

  it('isolates storage failures: record never throws, failures are counted and logged once per window', () => {
    const clock = manualClock()
    const log = vi.fn()
    const recorder = createAgentAuditRecorder({ store: { insertMany: () => { throw new Error('disk full') } }, schedule: clock.schedule, now: clock.now, log })
    expect(() => recorder.record(action('a'))).not.toThrow()
    clock.advance(250)
    recorder.record(action('b'))
    expect(() => recorder.flush()).not.toThrow()
    expect(recorder.stats()).toMatchObject({ recorded: 2, written: 0, failed: 2, pending: 0 })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toContain('disk full')
  })

  it('drops invalid rows, caps pending rows, hashes hashSource and stops after dispose', () => {
    const clock = manualClock()
    const rows: AgentActionRow[] = []
    const recorder = createAgentAuditRecorder({ store: { insertMany: batch => { rows.push(...batch) } }, schedule: clock.schedule, now: clock.now, maxBatch: 1, maxPending: 1, hash: content => `h(${content.length})` })
    recorder.record([{ ...action('x'), runId: '' }, { ...action('file.ts'), kind: 'write', hashSource: 'abcd' }, action('overflow')])
    expect(recorder.stats()).toMatchObject({ recorded: 1, dropped: 1 })
    recorder.dispose()
    expect(rows).toEqual([expect.objectContaining({ target: 'file.ts', hash: 'h(4)', ts: '2026-10-21T10:00:00.000Z' })])
    expect(JSON.stringify(rows)).not.toContain('abcd')
    recorder.record(action('late'))
    expect(recorder.stats().pending).toBe(0)
    expect(clock.pending()).toBe(0)
  })
})

describe('stream taps', () => {
  it('turns parsed frames into run-addressed actions and swallows recorder failures', () => {
    const recorded: unknown[] = []
    const tap = createStreamAuditTap({ record: rows => { recorded.push(...(rows as unknown[])) } }, { runId: 'job-9', jobId: 'job-9', role: 'loop' })
    tap({ type: 'assistant', message: { content: [{ type: 'tool_use', id: '1', name: 'Bash', input: { command: 'ls' } }] } })
    tap('not an event')
    expect(recorded).toEqual([expect.objectContaining({ runId: 'job-9', jobId: 'job-9', role: 'loop', kind: 'exec', target: 'ls' })])

    const throwing = createStreamAuditTap({ record: () => { throw new Error('boom') } }, { runId: 'job-9' })
    expect(() => throwing({ type: 'assistant', message: { content: [{ type: 'tool_use', id: '1', name: 'Read', input: { file_path: 'a' } }] } })).not.toThrow()
    expect(() => recordToolCall({ record: () => { throw new Error('boom') } }, { runId: 'c', source: 'provider-stream' }, 'Read', '{"file_path":"a"}')).not.toThrow()
  })

  it('records a tool call from a truncated adapter preview', () => {
    const recorded: Array<{ target: string }> = []
    recordToolCall({ record: rows => { recorded.push(...(rows as Array<{ target: string }>)) } }, { runId: 'conv', role: 'mission', source: 'provider-stream' }, 'Edit', '{"file_path":"src/app.ts","old_string":"aaaa')
    expect(recorded).toEqual([expect.objectContaining({ kind: 'write', target: 'src/app.ts', role: 'mission' })])
  })
})

describe('service', () => {
  function fakeStore(): AgentActionStore & { rows: AgentActionRow[]; cutoff?: string } {
    const store = {
      rows: [] as AgentActionRow[],
      cutoff: undefined as string | undefined,
      insertMany(rows: readonly AgentActionRow[]) { store.rows.push(...rows) },
      listByRun: (runId: string) => store.rows.filter(row => row.runId === runId).map((row, index) => ({ ...row, id: index + 1 })),
      listWindow: () => store.rows.map((row, index) => ({ ...row, id: index + 1 })),
      countByKind: () => ({ read: store.rows.length, write: 0, exec: 0, mcp: 0, network: 0 }),
      deleteBefore(cutoff: string) { store.cutoff = cutoff; return 3 },
    }
    return store
  }

  it('flushes pending rows before exporting and prunes with the retention cutoff', () => {
    const store = fakeStore()
    const clock = manualClock()
    const recorder = createAgentAuditRecorder({ store, schedule: clock.schedule, now: clock.now })
    const service = createAgentAuditService({ store, recorder, now: () => Date.parse('2026-10-31T00:00:00.000Z') })
    recorder.record(action('a'))
    const jsonl = service.exportRun('run-1', 'jsonl')
    expect(jsonl.rows).toBe(1)
    expect(JSON.parse(jsonl.body.trim())).toMatchObject({ run_id: 'run-1', target: 'a', kind: 'read' })
    expect(service.exportWindow({}, 'csv').body.split('\n')[0]).toBe('id,ts,run_id,job_id,role,kind,target,hash,source')
    expect(service.prune(30)).toBe(3)
    expect(store.cutoff).toBe('2026-10-01T00:00:00.000Z')
  })
})
