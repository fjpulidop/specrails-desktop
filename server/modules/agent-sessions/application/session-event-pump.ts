import { initialProjection, reduceEnvelope, type ProjectionOp, type ProjectionState } from '../domain/projection'
import type { SessionEventEnvelope } from '../domain/protocol'
import type { ProjectionSink, SessionHostClient } from '../ports'

const PAGE = 500

export type PumpListener = (sessionId: string, ops: ProjectionOp[], state: ProjectionState) => void

/**
 * Applies one Core session's committed events to a surface sink exactly once
 * and in order. Duplicates are ignored, gaps are filled from the host's
 * journal (`session.events`), and `attach` rebuilds the in-memory projection
 * by replaying up to the sink's cursor without re-applying anything.
 */
export class SessionEventPump {
  private state: ProjectionState
  private chain: Promise<void> = Promise.resolve()
  private detached = false

  constructor(
    readonly sessionId: string,
    private readonly client: SessionHostClient,
    private readonly sink: ProjectionSink,
    private readonly listener: PumpListener = () => {},
  ) {
    this.state = initialProjection(sessionId)
  }

  get projection(): ProjectionState {
    return this.state
  }

  /** Rebuild state up to the sink cursor, then apply everything after it. */
  attach(): Promise<void> {
    return this.enqueue(async () => {
      const cursor = this.sink.cursor(this.sessionId)
      this.state = initialProjection(this.sessionId)
      await this.fetchFrom(0, cursor)
      await this.fetchFrom(this.state.lastSeq)
    })
  }

  /** A live notification. */
  push(envelope: SessionEventEnvelope): Promise<void> {
    if (envelope.sessionId !== this.sessionId) return Promise.resolve()
    return this.enqueue(async () => {
      const result = reduceEnvelope(this.state, envelope)
      if (result.status === 'duplicate') return
      if (result.status === 'gap') { await this.fetchFrom(this.state.lastSeq); return }
      this.commit(envelope.seq, result.state, result.ops)
    })
  }

  /** The host dropped queued notifications; catch up from the journal. */
  catchUp(): Promise<void> {
    return this.enqueue(() => this.fetchFrom(this.state.lastSeq))
  }

  detach(): void {
    this.detached = true
  }

  /** Page through the journal; events up to `rebuildUntil` only rebuild state. */
  private async fetchFrom(afterSeq: number, rebuildUntil = 0): Promise<void> {
    let cursor = afterSeq
    for (;;) {
      if (this.detached) return
      if (rebuildUntil > 0 && cursor >= rebuildUntil) return
      const page = await this.client.request<{ events: SessionEventEnvelope[]; hasMore: boolean }>('session.events', { sessionId: this.sessionId, afterSeq: cursor, limit: PAGE })
      for (const envelope of page.events) {
        const result = reduceEnvelope(this.state, envelope)
        if (result.status !== 'applied') continue
        if (envelope.seq <= rebuildUntil) this.state = result.state
        else this.commit(envelope.seq, result.state, result.ops)
        cursor = envelope.seq
        if (rebuildUntil > 0 && cursor >= rebuildUntil) return
      }
      if (!page.hasMore || page.events.length === 0) return
    }
  }

  private commit(seq: number, state: ProjectionState, ops: ProjectionOp[]): void {
    // The sink owns the transaction (ops + cursor); state advances only after it committed.
    this.sink.apply(this.sessionId, seq, ops)
    this.state = state
    if (ops.length > 0) this.listener(this.sessionId, ops, state)
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task)
    this.chain = run.catch(() => undefined)
    return run
  }
}
