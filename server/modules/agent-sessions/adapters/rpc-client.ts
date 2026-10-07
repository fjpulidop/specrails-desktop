import { StringDecoder } from 'node:string_decoder'

import { SessionRequestError } from '../domain/errors'
import type { SessionErrorData, SessionEventEnvelope } from '../domain/protocol'
import type { SessionHostClient } from '../ports'

/** Longest accepted response line from the host. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export interface StdioTransport {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * JSON-RPC 2.0 client for the Core session host over NDJSON stdio.
 * Requests time out; every pending request is rejected when the connection
 * ends; notifications fan out to subscribers (session.event, session.lagged,
 * host.leaseLost).
 */
export class StdioSessionHostClient implements SessionHostClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly eventListeners = new Set<(envelope: SessionEventEnvelope) => void>()
  private readonly lagListeners = new Set<(sessionId: string, deliveredSeq: number) => void>()
  private readonly closeListeners = new Set<(reason: string) => void>()
  private closedReason: string | null = null

  constructor(private readonly transport: StdioTransport, private readonly options: { timeoutMs?: number; onClose?: () => Promise<void> } = {}) {
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    transport.stdout.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) this.receive(line)
      }
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) this.markClosed('Session host sent an oversized frame')
    })
    transport.stdout.on('end', () => this.markClosed('Session host closed its output'))
    transport.stdin.on('error', () => this.markClosed('Session host input closed'))
  }

  get closed(): boolean {
    return this.closedReason !== null
  }

  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closedReason) return Promise.reject(new SessionRequestError(this.closedReason, { code: 'host_unavailable', retryable: true }))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SessionRequestError(`Session host did not answer ${method} in time`, { code: 'host_timeout', retryable: true }))
      }, this.options.timeoutMs ?? 60_000)
      timer.unref?.()
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer })
      this.transport.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  onEvent(listener: (envelope: SessionEventEnvelope) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  onLagged(listener: (sessionId: string, deliveredSeq: number) => void): () => void {
    this.lagListeners.add(listener)
    return () => { this.lagListeners.delete(listener) }
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.closedReason) { listener(this.closedReason); return () => {} }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  async close(): Promise<void> {
    if (this.closedReason) return
    await this.options.onClose?.()
    this.markClosed('Session host closed')
  }

  /** The process ended (called by the launcher). */
  markClosed(reason: string): void {
    if (this.closedReason) return
    this.closedReason = reason
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer)
      request.reject(new SessionRequestError(reason, { code: 'host_unavailable', retryable: true }))
      this.pending.delete(id)
    }
    for (const listener of this.closeListeners) listener(reason)
    this.closeListeners.clear()
  }

  private receive(line: string): void {
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
    if (typeof message.method === 'string') {
      const params = (message.params ?? {}) as Record<string, unknown>
      if (message.method === 'session.event') {
        const envelope = { sessionId: String(params.sessionId), seq: Number(params.seq), event: params.event } as SessionEventEnvelope
        for (const listener of this.eventListeners) listener(envelope)
      } else if (message.method === 'session.lagged') {
        for (const listener of this.lagListeners) listener(String(params.sessionId), Number(params.deliveredSeq))
      } else if (message.method === 'host.leaseLost') {
        this.markClosed('Another session host took over this scope')
      }
      return
    }
    if (typeof message.id !== 'number') return
    const request = this.pending.get(message.id)
    if (!request) return
    this.pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error && typeof message.error === 'object') {
      const error = message.error as { code?: number; message?: string; data?: SessionErrorData }
      request.reject(new SessionRequestError(error.message ?? `Session host rejected ${request.method}`, error.data ?? { code: 'internal', retryable: false }, error.code))
    } else {
      request.resolve(message.result ?? {})
    }
  }
}
