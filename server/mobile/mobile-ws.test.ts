import { describe, it, expect } from 'vitest'
import { MobileWsBridge, type SocketLike } from './mobile-ws'
import type { WsMessage } from '../types'

class StubSocket implements SocketLike {
  readyState = 1
  sent: unknown[] = []
  closed: { code?: number } | null = null
  terminated = false
  pinged = 0
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  send(d: string): void { this.sent.push(JSON.parse(d)) }
  on(e: string, cb: (...a: unknown[]) => void): void { (this.handlers[e] ??= []).push(cb) }
  ping(): void { this.pinged++ }
  terminate(): void { this.terminated = true }
  close(code?: number): void { this.closed = { code } }
  emit(e: string, ...a: unknown[]): void { (this.handlers[e] ?? []).forEach((f) => f(...a)) }
}

function sub(s: StubSocket, projects: string[], topics: string[]): void {
  s.emit('message', JSON.stringify({ type: 'subscribe', projects, topics }))
}

describe('MobileWsBridge', () => {
  it('delivers project-scoped topics only to subscribers', () => {
    const bridge = new MobileWsBridge()
    const s = new StubSocket()
    bridge.attach(s, 'dev-1')
    sub(s, ['p1'], ['queue'])

    const qmsg = { type: 'queue', jobs: [], activeJobId: null, paused: false, timestamp: '', projectId: 'p1' } as WsMessage
    bridge.dispatch(qmsg)
    expect(s.sent).toHaveLength(1)

    // Different project → dropped.
    bridge.dispatch({ ...qmsg, projectId: 'p2' } as WsMessage)
    expect(s.sent).toHaveLength(1)

    // Topic not subscribed → dropped.
    bridge.dispatch({ type: 'ticket_updated', projectId: 'p1', ticket: { id: 1 } as never, timestamp: '' } as WsMessage)
    expect(s.sent).toHaveLength(1)
  })

  it('always forwards app-level messages, redacted and translated to the legacy wire type', () => {
    const bridge = new MobileWsBridge()
    const s = new StubSocket()
    bridge.attach(s, 'dev-1') // no subscription
    bridge.dispatch({ type: 'desktop.projects', projects: [{ id: 'p1', path: '/Users/x/p', slug: 's', name: 'n', db_path: '/d', provider: 'claude', providers: ['claude'], added_at: '', last_seen_at: '' }], timestamp: '' } as WsMessage)
    expect(s.sent).toHaveLength(1)
    const msg = s.sent[0] as { type: string; projects: Array<Record<string, unknown>> }
    // mobile-app v1 wire compat — the phone receives the legacy type string.
    expect(msg.type).toBe('hub.projects')
    expect(msg.projects[0].path).toBeUndefined()
    expect(msg.projects[0].db_path).toBeUndefined()
    expect(msg.projects[0].id).toBe('p1')
  })

  it('translates desktop_daily_budget_exceeded to the legacy alert wire shape', () => {
    const bridge = new MobileWsBridge()
    const s = new StubSocket()
    bridge.attach(s, 'dev-1')
    sub(s, ['p1'], ['alerts'])
    bridge.dispatch({
      type: 'desktop_daily_budget_exceeded', projectId: 'p1',
      desktopDailySpend: 12.5, desktopBudget: 10, queuePaused: true,
    } as unknown as WsMessage)
    expect(s.sent).toHaveLength(1)
    const msg = s.sent[0] as Record<string, unknown>
    // mobile-app v1 wire compat — legacy type and payload field names restored.
    expect(msg.type).toBe('hub_daily_budget_exceeded')
    expect(msg.hubDailySpend).toBe(12.5)
    expect(msg.hubBudget).toBe(10)
    expect(msg.desktopDailySpend).toBeUndefined()
    expect(msg.desktopBudget).toBeUndefined()
  })

  it('does NOT deliver desktop_daily_budget_exceeded to a device without the alerts topic (BUG-MOBILE-05)', () => {
    const bridge = new MobileWsBridge()
    const s = new StubSocket()
    bridge.attach(s, 'dev-1')
    // Never subscribed to anything → topics is empty.
    bridge.dispatch({
      type: 'desktop_daily_budget_exceeded', projectId: 'p1',
      desktopDailySpend: 12.5, desktopBudget: 10, queuePaused: true,
    } as unknown as WsMessage)
    expect(s.sent).toHaveLength(0)

    // Subscribed to a different topic but not 'alerts' → still dropped.
    sub(s, ['p1'], ['queue'])
    bridge.dispatch({
      type: 'desktop_daily_budget_exceeded', projectId: 'p1',
      desktopDailySpend: 12.5, desktopBudget: 10, queuePaused: true,
    } as unknown as WsMessage)
    expect(s.sent).toHaveLength(0)

    // Only once it subscribes to 'alerts' does it receive the frame.
    sub(s, ['p1'], ['alerts'])
    bridge.dispatch({
      type: 'desktop_daily_budget_exceeded', projectId: 'p1',
      desktopDailySpend: 12.5, desktopBudget: 10, queuePaused: true,
    } as unknown as WsMessage)
    expect(s.sent).toHaveLength(1)
    expect((s.sent[0] as { type: string }).type).toBe('hub_daily_budget_exceeded')
  })

  it('buffers watched-job logs and flushes them as a batch', () => {
    const bridge = new MobileWsBridge()
    const s = new StubSocket()
    bridge.attach(s, 'dev-1')
    sub(s, ['p1'], [])
    s.emit('message', JSON.stringify({ type: 'watch_job', projectId: 'p1', jobId: 'j1' }))

    bridge.dispatch({ type: 'log', source: 'stdout', line: 'hello', timestamp: '', processId: 'j1', projectId: 'p1' } as WsMessage)
    bridge.dispatch({ type: 'log', source: 'stdout', line: 'world', timestamp: '', processId: 'j1', projectId: 'p1' } as WsMessage)
    // A log for a different job is ignored.
    bridge.dispatch({ type: 'log', source: 'stdout', line: 'nope', timestamp: '', processId: 'jX', projectId: 'p1' } as WsMessage)
    expect(s.sent).toHaveLength(0) // buffered, not yet flushed

    ;(bridge as unknown as { flushLogs(): void }).flushLogs()
    expect(s.sent).toHaveLength(1)
    const batch = s.sent[0] as { type: string; jobId: string; lines: string[] }
    expect(batch.type).toBe('log_batch')
    expect(batch.jobId).toBe('j1')
    expect(batch.lines).toEqual(['hello', 'world'])
  })

  it('forwards chat/spec-draft events to a chat subscriber', () => {
    const bridge = new MobileWsBridge()
    const s = new StubSocket()
    bridge.attach(s, 'dev-1')
    sub(s, ['p1'], ['chat'])
    bridge.dispatch({ type: 'chat_stream', conversationId: 'c1', delta: 'hello', timestamp: '', projectId: 'p1' } as WsMessage)
    bridge.dispatch({ type: 'spec_draft.update', conversationId: 'c1', draft: { title: 'T' }, ready: true, chips: [], changedFields: ['title'], timestamp: '', projectId: 'p1' } as WsMessage)
    expect(s.sent).toHaveLength(2)
    expect((s.sent[0] as { type: string }).type).toBe('chat_stream')
    // Not delivered without the chat topic.
    const s2 = new StubSocket()
    bridge.attach(s2, 'dev-2')
    sub(s2, ['p1'], ['queue'])
    bridge.dispatch({ type: 'chat_done', conversationId: 'c1', fullText: 'x', timestamp: '', projectId: 'p1' } as WsMessage)
    expect(s2.sent).toHaveLength(0)
  })

  it('forwards rail.updated to a rails subscriber', () => {
    const bridge = new MobileWsBridge()
    const s = new StubSocket()
    bridge.attach(s, 'dev-1')
    sub(s, ['p1'], ['rails'])
    bridge.dispatch({
      type: 'rail.updated', projectId: 'p1', railIndex: 0, changed: 'name',
      ticketIds: [1, 2], name: 'Backend', mode: 'implement', profileName: null, aiEngine: null,
    } as WsMessage)
    expect(s.sent).toHaveLength(1)
    const msg = s.sent[0] as { type: string; name: string; ticketIds: number[] }
    expect(msg.type).toBe('rail.updated')
    expect(msg.name).toBe('Backend')
    expect(msg.ticketIds).toEqual([1, 2])
    // Not delivered to a non-rails subscriber.
    const s2 = new StubSocket()
    bridge.attach(s2, 'dev-2')
    sub(s2, ['p1'], ['queue'])
    bridge.dispatch({
      type: 'rail.updated', projectId: 'p1', railIndex: 1, changed: 'tickets',
      ticketIds: [], name: null, mode: 'implement', profileName: null, aiEngine: null,
    } as WsMessage)
    expect(s2.sent).toHaveLength(0)
  })

  it('reduces a watched-job event to a payload-free summary', () => {
    const bridge = new MobileWsBridge()
    const s = new StubSocket()
    bridge.attach(s, 'dev-1')
    sub(s, ['p1'], [])
    s.emit('message', JSON.stringify({ type: 'watch_job', projectId: 'p1', jobId: 'j1' }))
    bridge.dispatch({ type: 'event', jobId: 'j1', event_type: 'assistant', source: 'x', payload: 'HUGE', timestamp: '', seq: 1, projectId: 'p1' } as WsMessage)
    expect(s.sent).toHaveLength(1)
    const ev = s.sent[0] as Record<string, unknown>
    expect(ev.type).toBe('job_event')
    expect(ev.eventType).toBe('assistant')
    expect(ev.payload).toBeUndefined()
  })

  it('closes a socket that floods inbound messages', () => {
    const bridge = new MobileWsBridge({ clock: () => 1000 })
    const s = new StubSocket()
    bridge.attach(s, 'dev-1')
    for (let i = 0; i < 32; i++) s.emit('message', JSON.stringify({ type: 'noop' }))
    expect(s.closed?.code).toBe(1008)
  })

  it('closes a socket that sends an oversized frame', () => {
    const bridge = new MobileWsBridge()
    const s = new StubSocket()
    bridge.attach(s, 'dev-1')
    s.emit('message', 'x'.repeat(5000))
    expect(s.closed?.code).toBe(1009)
  })

  it('closeForDevice closes all sockets of a device', () => {
    const bridge = new MobileWsBridge()
    const s1 = new StubSocket(), s2 = new StubSocket(), s3 = new StubSocket()
    bridge.attach(s1, 'dev-1')
    bridge.attach(s2, 'dev-1')
    bridge.attach(s3, 'dev-2')
    bridge.closeForDevice('dev-1')
    expect(s1.closed?.code).toBe(4401)
    expect(s2.closed?.code).toBe(4401)
    expect(s3.closed).toBeNull()
    expect(bridge.socketCount).toBe(1)
  })

  it('heartbeat pings, then terminates an unresponsive socket', () => {
    const bridge = new MobileWsBridge()
    const s = new StubSocket()
    bridge.attach(s, 'dev-1')
    ;(bridge as unknown as { heartbeat(): void }).heartbeat()
    expect(s.pinged).toBe(1)
    // No pong arrived → next beat terminates.
    ;(bridge as unknown as { heartbeat(): void }).heartbeat()
    expect(s.terminated).toBe(true)
  })

  it('start()/stop() are safe and clear sockets', () => {
    const bridge = new MobileWsBridge()
    const s = new StubSocket()
    bridge.attach(s, 'dev-1')
    bridge.start()
    bridge.start() // idempotent
    bridge.stop()
    expect(s.closed?.code).toBe(1001)
    expect(bridge.socketCount).toBe(0)
  })

  it('intersects subscribe.projects against the device ACL (BUG-MOBILE-02)', () => {
    // dev-scoped is granted only p1; dev-open is unrestricted (null).
    const bridge = new MobileWsBridge({
      allowedProjectsFor: (id) => (id === 'dev-scoped' ? new Set(['p1']) : null),
    })
    const scoped = new StubSocket()
    bridge.attach(scoped, 'dev-scoped')
    // Companion tries to subscribe to p1 AND p2 — only p1 should stick.
    sub(scoped, ['p1', 'p2'], ['queue'])

    bridge.dispatch({ type: 'queue', jobs: [], activeJobId: null, paused: false, timestamp: '', projectId: 'p1' } as WsMessage)
    expect(scoped.sent).toHaveLength(1) // granted project delivered
    bridge.dispatch({ type: 'queue', jobs: [], activeJobId: null, paused: false, timestamp: '', projectId: 'p2' } as WsMessage)
    expect(scoped.sent).toHaveLength(1) // non-granted project never reaches the device

    // An unrestricted device still gets both.
    const open = new StubSocket()
    bridge.attach(open, 'dev-open')
    sub(open, ['p1', 'p2'], ['queue'])
    bridge.dispatch({ type: 'queue', jobs: [], activeJobId: null, paused: false, timestamp: '', projectId: 'p2' } as WsMessage)
    expect(open.sent).toHaveLength(1)
  })

  it('removes a socket on close/error events', () => {
    const bridge = new MobileWsBridge()
    const s = new StubSocket()
    bridge.attach(s, 'dev-1')
    expect(bridge.socketCount).toBe(1)
    s.emit('close')
    expect(bridge.socketCount).toBe(0)
  })
})
