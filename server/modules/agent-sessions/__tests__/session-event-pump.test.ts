import { describe, expect, it } from 'vitest'

import { SessionEventPump } from '../application/session-event-pump'
import type { ProjectionOp } from '../domain/projection'
import type { SessionEvent, SessionEventEnvelope } from '../domain/protocol'
import type { ProjectionSink, SessionHostClient } from '../ports'

const at = '2026-10-07T10:00:00.000Z'

function journal(count: number): SessionEventEnvelope[] {
  const events: Array<Omit<SessionEvent, 'at'>> = [
    { type: 'session.opened', driver: 'claude', model: 'm', resumed: false, providerSessionRef: null },
    { type: 'input.accepted', inputId: 'u1', delivery: 'queue', text: 'hi' },
    { type: 'session.phase', phase: 'turn' },
    { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: ['u1'] },
    { type: 'turn.completed', turnId: 't1', status: 'completed', text: 'ok', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, costUsd: 0.01, costEstimated: false, model: 'm' } },
    { type: 'session.phase', phase: 'idle' },
  ]
  return Array.from({ length: count }, (_, index) => ({ sessionId: 's1', seq: index + 1, event: { ...(events[index] ?? { type: 'provider.diagnostic', level: 'info', code: 'x', message: String(index) }), at } as SessionEvent }))
}

/** Fake host client backed by an in-memory journal (same contract as session.events). */
class FakeClient implements SessionHostClient {
  requests: Array<{ method: string; params?: Record<string, unknown> }> = []
  constructor(public events: SessionEventEnvelope[]) {}
  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.requests.push({ method, params })
    const after = Number(params?.afterSeq ?? 0), limit = Number(params?.limit ?? 500)
    const rest = this.events.filter((event) => event.seq > after)
    return { events: rest.slice(0, limit), hasMore: rest.length > limit, nextSeq: rest.slice(0, limit).at(-1)?.seq ?? after } as T
  }
  onEvent() { return () => {} }
  onLagged() { return () => {} }
  onClose() { return () => {} }
  async close() {}
}

/** Sink with transactional semantics: a failed apply leaves cursor and ops untouched. */
class MemorySink implements ProjectionSink {
  cursors = new Map<string, number>()
  applied: Array<{ seq: number; ops: ProjectionOp[] }> = []
  failAt: number | null = null
  cursor(sessionId: string) { return this.cursors.get(sessionId) ?? 0 }
  apply(sessionId: string, seq: number, ops: ProjectionOp[]) {
    if (seq === this.failAt) { this.failAt = null; throw new Error('disk full') }
    if (seq !== this.cursor(sessionId) + 1) throw new Error(`sink out of order: ${seq} after ${this.cursor(sessionId)}`)
    this.applied.push({ seq, ops })
    this.cursors.set(sessionId, seq)
  }
}

describe('SessionEventPump', () => {
  it('applies live events once and in order, ignoring duplicates', async () => {
    const events = journal(6)
    const sink = new MemorySink()
    const seen: string[] = []
    const pump = new SessionEventPump('s1', new FakeClient(events), sink, (_id, ops) => seen.push(...ops.map((op) => op.kind)))
    for (const envelope of events) await pump.push(envelope)
    await pump.push(events[2]!)
    expect(sink.applied.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(seen).toContain('turn.closed')
    expect(pump.projection).toMatchObject({ lastSeq: 6, phase: 'idle' })
  })

  it('fills a gap from the journal before applying the newer event', async () => {
    const events = journal(6)
    const client = new FakeClient(events)
    const sink = new MemorySink()
    const pump = new SessionEventPump('s1', client, sink)
    await pump.push(events[0]!)
    await pump.push(events[4]!)
    expect(sink.applied.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(client.requests[0]).toMatchObject({ method: 'session.events', params: { afterSeq: 1 } })
  })

  it('rebuilds state up to the stored cursor without re-applying, then continues', async () => {
    const events = journal(6)
    const sink = new MemorySink()
    sink.cursors.set('s1', 4)
    const pump = new SessionEventPump('s1', new FakeClient(events), sink)
    await pump.attach()
    expect(sink.applied.map((entry) => entry.seq)).toEqual([5, 6])
    expect(pump.projection.lastSeq).toBe(6)
    // The turn opened before the cursor is known to the rebuilt state, so its close carries the right origin.
    const closed = sink.applied[0]!.ops.find((op) => op.kind === 'turn.closed')
    expect(closed).toMatchObject({ origin: 'user', turnId: 't1' })
  })

  it('pages through long journals and catches up after a lag notice', async () => {
    const events = journal(1_203)
    const client = new FakeClient(events.slice(0, 600))
    const sink = new MemorySink()
    const pump = new SessionEventPump('s1', client, sink)
    await pump.attach()
    expect(sink.cursor('s1')).toBe(600)
    client.events = events
    await pump.catchUp()
    expect(sink.cursor('s1')).toBe(1_203)
    expect(client.requests.filter((request) => request.method === 'session.events').length).toBeGreaterThanOrEqual(4)
  })

  it('does not advance when the sink transaction fails, and retries the same event later', async () => {
    const events = journal(3)
    const sink = new MemorySink()
    sink.failAt = 2
    const pump = new SessionEventPump('s1', new FakeClient(events), sink)
    await pump.push(events[0]!)
    await expect(pump.push(events[1]!)).rejects.toThrow('disk full')
    expect(pump.projection.lastSeq).toBe(1)
    await pump.push(events[2]!)
    expect(sink.applied.map((entry) => entry.seq)).toEqual([1, 2, 3])
  })

  it('ignores other sessions and stops after detach', async () => {
    const events = journal(2)
    const sink = new MemorySink()
    const pump = new SessionEventPump('s1', new FakeClient(events), sink)
    await pump.push({ ...events[0]!, sessionId: 'other' })
    pump.detach()
    await pump.catchUp()
    expect(sink.applied).toEqual([])
  })
})
