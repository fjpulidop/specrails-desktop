import { describe, expect, it } from 'vitest'

import { SessionRequestError } from '../domain/errors'
import type { ProjectionOp } from '../domain/projection'
import type { SessionEventEnvelope } from '../domain/protocol'
import type { Clock, HostProcessLauncher, ProjectionSink, SessionHostClient, TimerHandle } from '../ports'
import { SessionHostRegistry } from '../runtime/session-host-registry'

const tick = async () => { for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve)) }

class ManualClock implements Clock {
  current = 0
  timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  now() { return this.current }
  after(ms: number, fn: () => void): TimerHandle {
    const timer = { at: this.current + ms, fn, cancelled: false }
    this.timers.push(timer)
    return { cancel: () => { timer.cancelled = true } }
  }
  advance(ms: number) {
    this.current += ms
    for (const timer of this.timers.filter((item) => !item.cancelled && item.at <= this.current)) { timer.cancelled = true; timer.fn() }
  }
}

/** Fake host: a shared journal across restarts (like Core's SQLite journal). */
class FakeHost implements SessionHostClient {
  closed = false
  requests: string[] = []
  private events = new Set<(envelope: SessionEventEnvelope) => void>()
  private closes = new Set<(reason: string, code?: string) => void>()
  constructor(readonly journal: SessionEventEnvelope[]) {}
  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push(method)
    if (this.closed) throw new SessionRequestError('closed', { code: 'host_unavailable', retryable: true })
    if (method === 'session.events') {
      const rest = this.journal.filter((event) => event.seq > Number(params.afterSeq))
      return { events: rest, hasMore: false } as T
    }
    return {} as T
  }
  onEvent(listener: (envelope: SessionEventEnvelope) => void) { this.events.add(listener); return () => { this.events.delete(listener) } }
  onLagged() { return () => {} }
  onClose(listener: (reason: string, code?: string) => void) { this.closes.add(listener); return () => { this.closes.delete(listener) } }
  async close() { this.crash('closed') }
  emit(envelope: SessionEventEnvelope) { this.journal.push(envelope); for (const listener of this.events) listener(envelope) }
  crash(reason = 'exit 1', code?: string) { if (this.closed) return; this.closed = true; for (const listener of this.closes) listener(reason, code) }
}

class FakeLauncher implements HostProcessLauncher {
  hosts: FakeHost[] = []
  failNext = 0
  failWith: Error | null = null
  readonly journal: SessionEventEnvelope[] = []
  async launch(): Promise<SessionHostClient> {
    if (this.failWith) { const error = this.failWith; this.failWith = null; throw error }
    if (this.failNext > 0) { this.failNext -= 1; throw new Error('spawn failed') }
    const host = new FakeHost(this.journal)
    this.hosts.push(host)
    return host
  }
}

class Sink implements ProjectionSink {
  cursorBySession = new Map<string, number>()
  ops: ProjectionOp[] = []
  cursor(id: string) { return this.cursorBySession.get(id) ?? 0 }
  apply(id: string, seq: number, ops: ProjectionOp[]) { this.cursorBySession.set(id, seq); this.ops.push(...ops) }
}

const event = (seq: number): SessionEventEnvelope => ({ sessionId: 's1', seq, event: { type: 'provider.diagnostic', level: 'warning', code: `c${seq}`, message: 'x', at: 't' } })

describe('SessionHostRegistry', () => {
  it('starts one host per scope lazily and reuses it', async () => {
    const launcher = new FakeLauncher()
    const statuses: string[] = []
    const registry = new SessionHostRegistry({ launcher, clock: new ManualClock(), onStatus: (scope, status) => statuses.push(`${scope}:${status}`) })
    expect(registry.status('p1')).toBe('absent')
    const [a, b] = await Promise.all([registry.acquire('p1'), registry.acquire('p1')])
    expect(a).toBe(b)
    await registry.acquire('p2')
    expect(launcher.hosts).toHaveLength(2)
    expect(statuses).toEqual(['p1:starting', 'p1:ready', 'p2:starting', 'p2:ready'])
  })

  it('restarts after a crash with backoff, resumes tracked sessions and replays from the cursor', async () => {
    const launcher = new FakeLauncher()
    const clock = new ManualClock()
    const registry = new SessionHostRegistry({ launcher, clock })
    const sink = new Sink()
    await registry.track('p1', 's1', sink, () => {})
    launcher.hosts[0]!.emit(event(1))
    await tick()
    expect(sink.cursor('s1')).toBe(1)

    launcher.hosts[0]!.crash()
    expect(registry.status('p1')).toBe('restarting')
    expect(registry.available('p1')).toBe(true)
    // Events committed while Desktop was not connected are recovered by replay.
    launcher.journal.push(event(2), event(3))
    clock.advance(500)
    await tick()
    expect(registry.status('p1')).toBe('ready')
    expect(launcher.hosts[1]!.requests[0]).toBe('session.open')
    expect(launcher.hosts[1]!.requests.slice(1).every((method) => method === 'session.events')).toBe(true)
    expect(sink.cursor('s1')).toBe(3)
    launcher.hosts[1]!.emit(event(4))
    await tick()
    expect(sink.cursor('s1')).toBe(4)
  })

  it('degrades after repeated failures, refuses new sessions, and recovers on manual retry', async () => {
    const launcher = new FakeLauncher()
    const clock = new ManualClock()
    const registry = new SessionHostRegistry({ launcher, clock, policy: { baseDelayMs: 10, maxDelayMs: 100, maxFailures: 3, failureWindowMs: 60_000 } })
    launcher.failNext = 3
    await expect(registry.acquire('p1')).rejects.toThrow('spawn failed')
    clock.advance(10); await tick()
    clock.advance(20); await tick()
    expect(registry.status('p1')).toBe('degraded')
    expect(registry.available('p1')).toBe(false)
    await expect(registry.acquire('p1')).rejects.toMatchObject({ code: 'host_degraded' })
    await registry.retry('p1')
    expect(registry.status('p1')).toBe('ready')
  })

  it('starts immediately when a caller needs a restarting host', async () => {
    const launcher = new FakeLauncher()
    const registry = new SessionHostRegistry({ launcher, clock: new ManualClock() })
    await registry.acquire('p1')
    launcher.hosts[0]!.crash()
    expect(registry.status('p1')).toBe('restarting')
    await registry.acquire('p1')
    expect(registry.status('p1')).toBe('ready')
    expect(launcher.hosts).toHaveLength(2)
  })

  it('stops scopes gracefully and refuses work after stopAll', async () => {
    const launcher = new FakeLauncher()
    const registry = new SessionHostRegistry({ launcher, clock: new ManualClock() })
    await registry.track('p1', 's1', new Sink(), () => {})
    await registry.acquire('p2')
    await registry.stop('p1')
    expect(launcher.hosts[0]!.closed).toBe(true)
    expect(registry.status('p1')).toBe('absent')
    expect(launcher.hosts[1]!.closed).toBe(false)
    await registry.stopAll()
    expect(launcher.hosts[1]!.closed).toBe(true)
    await expect(registry.acquire('p3')).rejects.toMatchObject({ code: 'busy' })
    registry.untrack('p1', 's1')
  })
})

describe('fatal host failures', () => {
  function setup() {
    const launcher = new FakeLauncher()
    const clock = new ManualClock()
    const statuses: Array<[string, string, string | undefined]> = []
    const registry = new SessionHostRegistry({ launcher, clock, onStatus: (scope, status, _detail, code) => statuses.push([scope, status, code]) })
    return { launcher, clock, registry, statuses }
  }

  it('degrades at once when another host owns the journal, without restart attempts', async () => {
    const { launcher, clock, registry, statuses } = setup()
    launcher.failWith = new SessionRequestError('Another session host owns this scope', { code: 'journal_locked', retryable: false })
    await expect(registry.acquire('proj')).rejects.toMatchObject({ code: 'journal_locked' })
    expect(registry.status('proj')).toBe('degraded')
    expect(registry.degradedCode('proj')).toBe('journal_locked')
    expect(registry.available('proj')).toBe(false)
    expect(statuses.at(-1)).toEqual(['proj', 'degraded', 'journal_locked'])
    clock.advance(60_000)
    await tick()
    expect(launcher.hosts).toHaveLength(0)
    expect(registry.hosts()).toEqual([{ scope: 'proj', status: 'degraded', detail: 'Another session host owns this scope', code: 'journal_locked' }])
  })

  it('degrades when a running host loses its lease, and a retry clears the cause', async () => {
    const { launcher, registry } = setup()
    await registry.acquire('proj')
    launcher.hosts[0]!.crash('Another session host took over this scope', 'journal_locked')
    expect(registry.status('proj')).toBe('degraded')
    await registry.retry('proj')
    await tick()
    expect(registry.status('proj')).toBe('ready')
    expect(registry.degradedCode('proj')).toBeNull()
    expect(registry.hosts()[0]).toMatchObject({ status: 'ready', code: null, detail: null })
  })

  it('keeps restarting with backoff for ordinary crashes', async () => {
    const { launcher, clock, registry } = setup()
    await registry.acquire('proj')
    launcher.hosts[0]!.crash('exit 1')
    expect(registry.status('proj')).toBe('restarting')
    clock.advance(60_000)
    await tick()
    expect(registry.status('proj')).toBe('ready')
    expect(launcher.hosts).toHaveLength(2)
  })
})

