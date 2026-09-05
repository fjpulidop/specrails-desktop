import { randomUUID } from 'crypto'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { readMcpToken } from './bridge'

type SessionTransport = Transport & { terminateSession?: () => Promise<void> }

/** Read the current scoped token for every request, including SDK reconnects.
 * A 401 is safe to retry only when the file actually contains a new token. */
export function authenticatedFetch(agentHeaders: Record<string, string>, fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const token = readMcpToken()
    const headers = new Headers(init?.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    for (const [key, value] of Object.entries(agentHeaders)) headers.set(key, value)
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

/** Reinitialize only after a protocol 404 confirms the old session rejected the
 * request before dispatch. Network errors never replay a possibly-started tool. */
export class RecoveringHttpTransport implements Transport {
  onmessage?: Transport['onmessage']
  onerror?: Transport['onerror']
  onclose?: Transport['onclose']
  private current: SessionTransport
  private initializeMessage?: JSONRPCMessage
  private recovery?: Promise<void>
  private closed = false

  constructor(private readonly create: () => SessionTransport) {
    this.current = this.attach(create())
  }

  private attach(transport: SessionTransport): SessionTransport {
    transport.onmessage = (message, extra) => {
      if (transport === this.current && !this.closed) this.onmessage?.(message, extra)
    }
    transport.onerror = (error) => {
      if (transport === this.current && !this.closed) this.onerror?.(error)
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
    if (this.recovery) await this.recovery
    const attempted = this.current
    try {
      await attempted.send(message)
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 404 || !this.initializeMessage || message === this.initializeMessage) throw err
      if (attempted === this.current) {
        this.recovery ??= this.reinitialize().finally(() => { this.recovery = undefined })
      }
      if (this.recovery) await this.recovery
      await this.current.send(message)
    }
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
    } catch (err) {
      await this.close()
      throw err
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
