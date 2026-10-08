import type { ProjectionOp } from './domain/projection'
import type { SessionEventEnvelope } from './domain/protocol'

/** A connected Core session host for one scope (JSON-RPC over stdio). */
export interface SessionHostClient {
  /** Resolve with `result`, or reject with a `SessionRequestError`. */
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
  onEvent(listener: (envelope: SessionEventEnvelope) => void): () => void
  /** Queued notifications after `deliveredSeq` were discarded; replay them. */
  onLagged(listener: (sessionId: string, deliveredSeq: number) => void): () => void
  /** The connection ended (process exit, lease lost, explicit close). */
  /** `code` is set when the host ended for a known reason (e.g. `journal_locked`). */
  onClose(listener: (reason: string, code?: string) => void): () => void
  close(): Promise<void>
}

/** Starts a host process for a scope and returns its initialized client. */
export interface HostProcessLauncher {
  launch(scope: string): Promise<SessionHostClient>
}

/**
 * A surface's persistence for projected session state (missions, explore, ...).
 * `apply` writes the operations AND advances the cursor in one transaction.
 */
export interface ProjectionSink {
  cursor(sessionId: string): number
  apply(sessionId: string, seq: number, ops: ProjectionOp[]): void
}

export interface TimerHandle { cancel(): void }

export interface Clock {
  now(): number
  after(ms: number, callback: () => void): TimerHandle
}
