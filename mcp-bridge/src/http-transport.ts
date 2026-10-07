import { randomUUID } from 'crypto'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { readMcpToken } from './bridge'

type SessionTransport = Transport & { terminateSession?: () => Promise<void> }

/** Read the current scoped token for every request, including SDK reconnects.
 * A 401 is safe to retry only when the file actually contains a new token.
 * Agent headers may be a function so a long-lived bridge (resident agent
 * session) presents the capability of the CURRENT turn on every request. */
export function authenticatedFetch(agentHeaders: Record<string, string> | (() => Record<string, string>), fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const token = readMcpToken()
    const headers = new Headers(init?.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    for (const [key, value] of Object.entries(typeof agentHeaders === 'function' ? agentHeaders() : agentHeaders)) headers.set(key, value)
    const response = await fetchImpl(input, { ...init, headers })
    const refreshed = response.status === 401 ? readMcpToken() : null
    if (refreshed && refreshed !== token) {
      await response.body?.cancel()
      headers.set('Authorization', `Bearer ${refreshed}`)
      return fetchImpl(input, { ...init, headers })
    }
    return response
  }
}

/** The server rejected the request before dispatch because the session is not
 * usable any more: expired (404), or bound to a previous turn's capability (403
 * asking to reinitialize; a resident agent session rotates capabilities per turn). */
function rejectsStaleSession(err: unknown): boolean {
  const failure = err as { code?: unknown; message?: unknown } | null
  if (failure?.code === 404) return true
  return failure?.code === 403 && typeof failure.message === 'string' && /reinitiali[sz]e/i.test(failure.message)
}

/** SDK errors meaning the session's SSE stream is gone for good. */
export function isLostStream(error: Error): boolean {
  return /SSE stream disconnected|Maximum reconnection attempts|Failed to reconnect/i.test(error.message)
}

/** Lifecycle notes for diagnosing a bridge that a client reports as closed. */
export type BridgeLog = (event: string, detail?: string) => void

/** Reinitialize only after the server confirms the old session rejected the
 * request before dispatch. Network errors never replay a possibly-started tool.
 * A failed recovery fails that request but keeps the bridge open: the next
 * request tries again, so one bad moment never ends the client's MCP server. */
export class RecoveringHttpTransport implements Transport {
  /** connectBridge keeps the client side open when the app side can recover. */
  readonly recoverable = true
  onmessage?: Transport['onmessage']
  onerror?: Transport['onerror']
  onclose?: Transport['onclose']
  private current: SessionTransport
  private initializeMessage?: JSONRPCMessage
  private recovery?: Promise<void>
  private closed = false
  /** The last recovery failed; the next request must reinitialize first. */
  private stale = false

  constructor(private readonly create: () => SessionTransport, private readonly log: BridgeLog = () => {}) {
    this.current = this.attach(create())
  }

  private attach(transport: SessionTransport): SessionTransport {
    transport.onmessage = (message, extra) => {
      if (transport === this.current && !this.closed) this.onmessage?.(message, extra)
    }
    transport.onerror = (error) => {
      if (transport !== this.current || this.closed) return
      // The server ended this session's stream (e.g. the turn that owned it ended):
      // the next request starts a fresh session instead of the bridge giving up.
      if (isLostStream(error)) { this.stale = true; this.log('stream-lost', error.message) }
      this.onerror?.(error)
    }
    transport.onclose = () => {
      if (transport === this.current && !this.closed) this.onclose?.()
    }
    return transport
  }

  async start(): Promise<void> { await this.current.start() }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('MCP bridge is closed')
    if ('method' in message && message.method === 'initialize') this.initializeMessage = message
    if (this.stale && this.initializeMessage && message !== this.initializeMessage) this.recovery ??= this.recover('retry after a failed recovery')
    if (this.recovery) await this.recovery
    const attempted = this.current
    try {
      await attempted.send(message)
    } catch (err) {
      if (!rejectsStaleSession(err) || !this.initializeMessage || message === this.initializeMessage) throw err
      if (attempted === this.current) this.recovery ??= this.recover(`session rejected (${(err as { code?: unknown }).code})`)
      if (this.recovery) await this.recovery
      await this.current.send(message)
    }
  }

  private recover(reason: string): Promise<void> {
    this.log('recover', reason)
    return this.reinitialize()
      .then(() => { this.stale = false; this.log('recovered') })
      .catch((error: unknown) => {
        this.stale = true
        this.log('recover-failed', error instanceof Error ? error.message : String(error))
        throw error
      })
      .finally(() => { this.recovery = undefined })
  }

  private async reinitialize(): Promise<void> {
    const previous = this.current
    const next = this.attach(this.create())
    this.current = next
    await previous.close().catch(() => {})
    const id = `specrails-bridge-${randomUUID()}`
    let timer: ReturnType<typeof setTimeout> | undefined
    const relay = next.onmessage
    try {
      await next.start()
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('MCP session recovery timed out. Reconnect the client.')), 10_000)
        next.onmessage = (message, extra) => {
          if ('id' in message && message.id === id) {
            if ('error' in message) reject(new Error(message.error.message))
            else if ('result' in message) resolve()
          } else relay?.(message, extra)
        }
        void next.send({ ...this.initializeMessage!, id } as JSONRPCMessage).catch(reject)
      })
      await next.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    } finally {
      if (timer) clearTimeout(timer)
      next.onmessage = relay
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // SDK close() alone leaves a stateful server session behind. Bound DELETE
      // teardown so a stopped sidecar cannot keep the stdio process alive.
      await Promise.race([
        this.current.terminateSession?.().catch(() => {}),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      await this.current.close().catch(() => {})
      this.onclose?.()
    }
  }
}
