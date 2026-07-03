import { describe, it, expect, beforeEach, vi } from 'vitest'
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

  it('sums per-turn tokens but records cost/turns as deltas of the cumulative reading (HIGH-2)', async () => {
    // The resident stream-json child reports total_cost_usd + num_turns
    // CUMULATIVELY per turn (turn 2's result carries the running session total).
    // Tokens are per-turn. So two $0.05 turns report cumulative 0.05 then 0.10.
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(resultFrame()) // cumulative: cost 0.05, num_turns 3
    await tick()
    h.session.send('again')
    h.child.stdout.push(resultFrame({ total_cost_usd: 0.1, num_turns: 6 })) // cumulative
    await tick()
    const totals = h.session.getTotals()
    expect(totals.tokens_in).toBe(200) // per-turn: 100 + 100
    expect(totals.num_turns).toBe(6) // deltas 3 + 3, NOT 3 + 6 = 9
    expect(totals.total_cost_usd).toBeCloseTo(0.1) // deltas 0.05 + 0.05, NOT 0.15
    // The jobs row mirrors the deltas.
    const row = getJob(h.db, 'job-1')!
    expect(row.total_cost_usd).toBeCloseTo(0.1)
    expect(row.num_turns).toBe(6)
  })

  it('clamps a lower cumulative cost reading to a 0 delta (never subtracts)', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(resultFrame({ total_cost_usd: 0.2, num_turns: 4 }))
    await tick()
    h.session.send('again')
    // A stray lower reading (or a mid-session counter reset) must not subtract.
    h.child.stdout.push(resultFrame({ total_cost_usd: 0.1, num_turns: 2 }))
    await tick()
    const totals = h.session.getTotals()
    expect(totals.total_cost_usd).toBeCloseTo(0.2) // 0.2 + max(0, 0.1-0.2)
    expect(totals.num_turns).toBe(4) // 4 + max(0, 2-4)
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
    // Clean finalize (no in-flight turn) is authoritative, not estimated (CRIT-4).
    expect(h.settled[0].estimated).toBe(false)
    // Active duration is tracked per turn-segment (LOW-15).
    expect(h.settled[0].activeDurationMs).toBeGreaterThanOrEqual(0)
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

  // ─── BUG-INTJOB-03: stray/late result for a finished turn must not corrupt the next ──
  it('rejects a stray duplicate result for the prior turn so it cannot corrupt the next turn', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go') // turn 1 streaming
    // Queue a second prompt behind the active turn.
    h.session.send('next')
    // The REAL trigger: turn 1's result AND a stray duplicate of it are both already
    // buffered in stdout. The next queued prompt (turn 2) is fed off turn 1's result;
    // the stray duplicate (same synchronous batch) must be rejected, NOT folded into
    // the freshly-armed turn 2.
    h.child.stdout.push(resultFrame())
    h.child.stdout.push(resultFrame()) // stray/duplicate for turn 1
    await tick()

    // Totals reflect exactly turn 1 — the stray was not counted into turn 2.
    const totals = h.session.getTotals()
    expect(totals.tokens_in).toBe(100) // not 200
    expect(totals.num_turns).toBe(3)
    expect(getJob(h.db, 'job-1')!.tokens_in).toBe(100)
    // Turn 2 was fed and is genuinely awaiting its OWN result.
    expect(h.session.isStreaming()).toBe(true)
    expect(h.child.stdinWrites.length).toBe(2) // turn1 + turn2 written

    // Turn 2's real result then arrives (cumulative) and is counted correctly.
    h.child.stdout.push(resultFrame({ total_cost_usd: 0.1, num_turns: 6 }))
    await tick()
    expect(h.session.getTotals().tokens_in).toBe(200)
    expect(h.session.getTotals().num_turns).toBe(6)
  })

  // ─── BUG-INTJOB-02: hard-deadline settle even if the child never emits 'close' ──
  it('settles via the kill-timer fallback when the child never emits close after finalize', async () => {
    vi.useFakeTimers()
    try {
      const h2 = setup('job-stuck')
      // A child that swallows signals — kill() never emits 'close'.
      h2.child.kill = (_sig?: string) => { h2.child.killed = true; return true }
      h2.session.start({ binary: 'claude', args: [] }, 'go')
      h2.session.finalize()
      // Before the grace window the slot is NOT yet released.
      expect(h2.settled.length).toBe(0)
      // Advance past the SIGKILL grace window — the timer must force the settle.
      vi.advanceTimersByTime(2001)
      expect(h2.settled.length).toBe(1)
      expect(h2.settled[0].reason).toBe('finalized')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not double-settle when close arrives after the kill-timer already settled', async () => {
    vi.useFakeTimers()
    try {
      const h2 = setup('job-late-close')
      h2.child.kill = (_sig?: string) => { h2.child.killed = true; return true }
      h2.session.start({ binary: 'claude', args: [] }, 'go')
      h2.session.finalize()
      vi.advanceTimersByTime(2001)
      expect(h2.settled.length).toBe(1)
      // A late 'close' now fires — must be a no-op (idempotent settle).
      h2.child.emit('close', 0)
      expect(h2.settled.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // ─── BUG-INTJOB-04: do not echo a turn that could not be delivered to stdin ──
  it('does not echo the turn and settles crashed when stdin is destroyed at send time', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(resultFrame())
    await tick() // turn idle, stdin writable so far

    // Simulate stdin gone (mid-crash) while the child object is still alive.
    h.child.stdin.destroyed = true
    const broadcastsBefore = h.broadcasts.length
    const ok = h.session.send('lost message')
    expect(ok).toBe(false)

    // No turn_user echo for the undelivered prompt.
    const echoed = h.broadcasts
      .slice(broadcastsBefore)
      .find((m) => m.type === 'job.turn_user' && (m as any).text === 'lost message')
    expect(echoed).toBeUndefined()
    // A delivery-failure note is surfaced on stderr.
    const note = h.broadcasts
      .slice(broadcastsBefore)
      .find((m) => m.type === 'log' && (m as any).source === 'stderr' && (m as any).line?.includes('Could not deliver'))
    expect(note).toBeTruthy()
    // The session settled (transport gone) as crashed.
    expect(h.settled.length).toBe(1)
    expect(h.settled[0].reason).toBe('crashed')
  })

  it('echoes the turn only after a confirmed stdin write', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(resultFrame())
    await tick()
    const ok = h.session.send('delivered')
    expect(ok).toBe(true)
    const echoed = h.broadcasts.find((m) => m.type === 'job.turn_user' && (m as any).text === 'delivered')
    expect(echoed).toBeTruthy()
    expect(h.child.stdinWrites.some((w: string) => w.includes('delivered'))).toBe(true)
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

  // ─── CRIT-4: fold an in-flight turn's streamed usage on a mid-turn finalize ──
  function assistantFrame(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm-inflight',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
        content: [{ type: 'text', text: 'working' }],
        ...over,
      },
    }) + '\n'
  }

  it('folds an in-flight turn (no result frame) into the totals on a mid-turn finalize (CRIT-4)', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(assistantFrame()) // work streams, but no terminal `result`
    await tick()
    expect(h.session.isStreaming()).toBe(true) // still awaiting result

    h.session.finalize()
    await tick()

    expect(h.settled.length).toBe(1)
    const info = h.settled[0]
    expect(info.reason).toBe('finalized')
    // The killed turn's tokens are folded in, not dropped.
    expect(info.totals.tokens_in).toBe(1000)
    expect(info.totals.tokens_out).toBe(500)
    // Its cost is rate-card estimated (no native `result` cost arrived).
    expect(info.totals.total_cost_usd).toBeGreaterThan(0)
    expect(info.estimated).toBe(true)
    // The jobs row also carries the folded usage (not an authoritative $0).
    const row = getJob(h.db, 'job-1')!
    expect(row.tokens_in).toBe(1000)
    expect(row.total_cost_usd!).toBeGreaterThan(0)
  })

  it('folds an in-flight turn on an unexpected crash mid-turn (CRIT-4)', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(assistantFrame())
    await tick()
    h.child.emit('close', 1) // crash before the result frame
    await tick()
    expect(h.settled.length).toBe(1)
    expect(h.settled[0].reason).toBe('crashed')
    expect(h.settled[0].totals.tokens_in).toBe(1000)
    expect(h.settled[0].totals.total_cost_usd).toBeGreaterThan(0)
    expect(h.settled[0].estimated).toBe(true)
  })

  // ─── HIGH-1: snapshotForAbort folds + returns totals without settling ────────
  it('snapshotForAbort folds an in-flight turn and returns accumulated totals without settling', async () => {
    h.session.start({ binary: 'claude', args: [] }, 'go')
    h.child.stdout.push(resultFrame()) // turn 1 completes: native cost 0.05
    await tick()
    h.session.send('next')
    h.child.stdout.push(assistantFrame({ id: 'm2' })) // turn 2 streams, no result
    await tick()

    const snap = h.session.snapshotForAbort()
    expect(snap.totals.tokens_in).toBe(100 + 1000)
    // turn 1 native (0.05) + turn 2 estimated (>0).
    expect(snap.totals.total_cost_usd).toBeGreaterThan(0.05)
    expect(snap.estimated).toBe(true)
    expect(snap.activeDurationMs).toBeGreaterThanOrEqual(0)
    // Does NOT settle — the caller writes the aborted row then disposes.
    expect(h.settled.length).toBe(0)

    // Fold is idempotent: a following dispose neither settles nor re-folds.
    h.session.dispose()
    expect(h.settled.length).toBe(0)
  })
})
