import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { InteractiveJobSession, type SettleInfo } from './interactive-job-session'
import { initDb, createJob, getJob, type DbInstance } from './db'
import { getAdapter } from './providers'
import type { WsMessage } from './types'

const tick = () => new Promise((r) => setImmediate(r))

function makeFakeChild() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  const writes: string[] = []
  child.stdin = { write: (s: string) => { writes.push(s); return true }, destroyed: false }
  child.stdinWrites = writes
  child.pid = 4242
  child.killed = false
  child.kill = (_sig?: string) => {
    child.killed = true
    // Simulate the process dying on signal — emit close on the next tick.
    queueMicrotask(() => child.emit('close', 0))
    return true
  }
  return child
}

function resultFrame(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    total_cost_usd: 0.05,
    num_turns: 3,
    model: 'claude-opus-4-8',
    session_id: 'sess-1',
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
    ...over,
  }) + '\n'
}

interface Harness {
  db: DbInstance
  child: any
  broadcasts: WsMessage[]
  settled: SettleInfo[]
  session: InteractiveJobSession
}

function setup(jobId = 'job-1'): Harness {
  const db = initDb(':memory:')
  createJob(db, { id: jobId, command: '/specrails:ultracode #1 --yes', started_at: new Date().toISOString(), interactive: true })
  const broadcasts: WsMessage[] = []
  const settled: SettleInfo[] = []
  const child = makeFakeChild()
  const session = new InteractiveJobSession({
    jobId,
    projectId: 'p1',
    db,
    adapter: getAdapter('claude'),
    broadcast: (m) => broadcasts.push(m),
    onSettle: (info) => settled.push(info),
    spawn: (() => child) as any,
  })
  return { db, child, broadcasts, settled, session }
}

describe('InteractiveJobSession', () => {
  let h: Harness
  beforeEach(() => { h = setup() })

  it('writes the first turn to stdin on start', () => {
    h.session.start({ binary: 'claude', args: [] }, 'implement the spec')
    expect(h.child.stdinWrites.length).toBe(1)
    const framed = h.child.stdinWrites[0]
    expect(framed).toContain('"role":"user"')
    expect(framed).toContain('implement the spec')
    expect(framed.endsWith('\n')).toBe(true)
    expect(h.session.isStreaming()).toBe(true)
  })

  it('accumulates real usage into the job row + broadcasts turn_done on a result event', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(resultFrame())
    await tick()

    const totals = h.session.getTotals()
    expect(totals.tokens_in).toBe(100)
    expect(totals.tokens_out).toBe(200)
    expect(totals.tokens_cache_read).toBe(10)
    expect(totals.tokens_cache_create).toBe(5)
    expect(totals.total_cost_usd).toBeCloseTo(0.05)
    expect(totals.num_turns).toBe(3)
    expect(h.session.isStreaming()).toBe(false)

    const row = getJob(h.db, 'job-1')!
    expect(row.tokens_in).toBe(100)
    expect(row.total_cost_usd).toBeCloseTo(0.05)
    expect(row.num_turns).toBe(3)
    expect(row.status).toBe('running') // not terminal until finalize

    const turnDone = h.broadcasts.find((m) => m.type === 'job.turn_done') as any
    expect(turnDone).toBeTruthy()
    expect(turnDone.totals.total_cost_usd).toBeCloseTo(0.05)
    expect(turnDone.jobId).toBe('job-1')
  })

  it('sums usage across multiple turns', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(resultFrame())
    await tick()
    h.session.send('again')
    h.child.stdout.push(resultFrame())
    await tick()
    const totals = h.session.getTotals()
    expect(totals.tokens_in).toBe(200)
    expect(totals.num_turns).toBe(6)
    expect(totals.total_cost_usd).toBeCloseTo(0.1)
  })

  it('sends immediately when idle; broadcasts turn_user(queued=false) + a log echo', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(resultFrame())
    await tick()
    const before = h.child.stdinWrites.length
    const ok = h.session.send('next prompt')
    expect(ok).toBe(true)
    expect(h.child.stdinWrites.length).toBe(before + 1)
    expect(h.child.stdinWrites[before]).toContain('next prompt')
    const userMsg = h.broadcasts.filter((m) => m.type === 'job.turn_user').pop() as any
    expect(userMsg.queued).toBe(false)
    expect(userMsg.text).toBe('next prompt')
    const logEcho = h.broadcasts.filter((m) => m.type === 'log' && (m as any).line?.includes('next prompt')).pop()
    expect(logEcho).toBeTruthy()
  })

  it('queues a prompt while streaming, then feeds it after the active turn settles', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go') // streaming
    const before = h.child.stdinWrites.length
    const ok = h.session.send('queued one')
    expect(ok).toBe(true)
    // Not written yet — a turn is active.
    expect(h.child.stdinWrites.length).toBe(before)
    const userMsg = h.broadcasts.filter((m) => m.type === 'job.turn_user').pop() as any
    expect(userMsg.queued).toBe(true)
    // First turn settles → the queued prompt is fed.
    h.child.stdout.push(resultFrame())
    await tick()
    expect(h.child.stdinWrites.length).toBe(before + 1)
    expect(h.child.stdinWrites[before]).toContain('queued one')
  })

  it('finalize() kills the child and settles as finalized with accumulated totals', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(resultFrame())
    await tick()
    h.session.finalize()
    await tick()
    expect(h.child.killed).toBe(true)
    expect(h.settled.length).toBe(1)
    expect(h.settled[0].reason).toBe('finalized')
    expect(h.settled[0].totals.total_cost_usd).toBeCloseTo(0.05)
    expect(h.settled[0].sessionId).toBe('sess-1')
    expect(h.settled[0].model).toBe('claude-opus-4-8')
  })

  it('finalize() is idempotent', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.session.finalize()
    h.session.finalize()
    await tick()
    expect(h.settled.length).toBe(1)
  })

  it('an unexpected child close settles as crashed', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.emit('close', 1)
    await tick()
    expect(h.settled.length).toBe(1)
    expect(h.settled[0].reason).toBe('crashed')
  })

  it('send() returns false after finalize and after dispose', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.session.finalize()
    expect(h.session.send('too late')).toBe(false)
    await tick()
    const h2 = setup('job-2')
    h2.session.start({ binary: 'claude', args: [] }, 'go')
    h2.session.dispose()
    expect(h2.session.send('gone')).toBe(false)
    expect(h2.settled.length).toBe(0) // dispose does NOT settle
  })

  it('counts a turn only once even if a duplicate result frame arrives', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(resultFrame())
    h.child.stdout.push(resultFrame()) // duplicate for the same turn
    await tick()
    const totals = h.session.getTotals()
    expect(totals.tokens_in).toBe(100) // not 200
    expect(totals.num_turns).toBe(3)
    expect(getJob(h.db, 'job-1')!.tokens_in).toBe(100)
  })

  it('surfaces queued prompts that never ran when the session ends', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go') // streaming
    h.session.send('queued one') // pending behind the active turn
    h.session.finalize()
    await tick()
    const note = h.broadcasts.find(
      (m) => m.type === 'log' && (m as any).source === 'stderr' && (m as any).line?.includes('were not sent'),
    )
    expect(note).toBeTruthy()
  })

  it('persists streamed assistant frames + display log lines as events', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello world' }] } }) + '\n')
    await tick()
    const eventMsg = h.broadcasts.find((m) => m.type === 'event' && (m as any).event_type === 'assistant')
    expect(eventMsg).toBeTruthy()
    const logMsg = h.broadcasts.find((m) => m.type === 'log' && (m as any).line === 'hello world')
    expect(logMsg).toBeTruthy()
  })
})
