import type { Request, Response } from 'express'
import { createHash, randomUUID } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { ProjectRegistry } from '../project-registry'
import type { WsMessage } from '../types'
import { getMobileEventBus, type MobileEventBus } from '../mobile/mobile-event-bus'
import { isMcpEnabled, MCP_ENABLED_KEY } from './mcp-tiers'
import { AGENT_CAPABILITY_HEADER } from '../agent-tier'
import { setDesktopSetting } from '../desktop-db'
import { buildToolSpecs } from './tools/catalog'
import { registerTieredTool, type McpToolContext } from './tools/types'
import { registerResources } from './resources'
import { verifyAgentCapability, onAgentCapabilityRevoked } from './agent-capability'

export interface McpServerManagerDeps {
  registry: ProjectRegistry
  broadcast: (msg: WsMessage) => void
  desktopPort: number
  eventBus?: MobileEventBus
  version?: string
}

export interface McpServerStatus {
  enabled: boolean
  running: boolean
  activeSessions: number
  toolCount: number
}

function jsonRpcError(message: string, code = -32000): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id: null }
}

/**
 * Embedded MCP server manager. Mirrors the MobileGateway lifecycle shape
 * (isEnabledSetting / setEnabled / start / stop / status) but mounts on the
 * EXISTING Express app rather than binding a second port. Uses the SDK's
 * stateful streamable-HTTP transport (a transport per MCP session).
 */
interface McpSession {
  transport: StreamableHTTPServerTransport
  server: McpServer
  capabilityHash: string | null
  timer?: ReturnType<typeof setTimeout>
  unsubscribe?: () => void
  closed: boolean
}

const SESSION_IDLE_MS = 30 * 60 * 1000

export class McpServerManager {
  private readonly _ctx: McpToolContext
  private readonly _version: string
  private readonly _sessions = new Map<string, McpSession>()
  private readonly _pending = new Set<McpSession>()
  private readonly _toolCount: number

  constructor(deps: McpServerManagerDeps) {
    this._ctx = {
      registry: deps.registry,
      desktopDb: deps.registry.desktopDb,
      broadcast: deps.broadcast,
      eventBus: deps.eventBus ?? getMobileEventBus(),
      desktopPort: deps.desktopPort,
    }
    this._version = deps.version ?? '1.0.0'
    this._toolCount = buildToolSpecs().length
  }

  isEnabledSetting(): boolean {
    return isMcpEnabled(this._ctx.desktopDb)
  }

  /** Persist the enable flag and tear down sessions when disabling. */
  async setEnabled(enabled: boolean): Promise<McpServerStatus> {
    setDesktopSetting(this._ctx.desktopDb, MCP_ENABLED_KEY, enabled ? 'true' : 'false')
    if (!enabled) await this.stop(true)
    this._ctx.broadcast({ type: 'mcp.state', enabled, running: enabled } as unknown as WsMessage)
    return this.status()
  }

  // Mounting happens on the shared app, so start() has no port to bind; it
  // exists for lifecycle symmetry with MobileGateway. The transport only serves
  // when isEnabledSetting() is true (checked in handleHttp).
  async start(): Promise<void> {
    /* no-op: served on the shared app, gated by isEnabledSetting() */
  }

  /** Shutdown/rotation closes everything; the external Settings toggle must
   * preserve first-party turns governed by their independent permission tier. */
  async stop(externalOnly = false): Promise<void> {
    const sessions = [...new Set([...this._sessions.values(), ...this._pending])]
      .filter((session) => !externalOnly || session.capabilityHash === null)
    await Promise.allSettled(sessions.map((session) => this.closeSession(session)))
  }

  private async closeSession(session: McpSession): Promise<void> {
    if (session.closed) return
    this.forgetSession(session)
    try { await session.server.close() } catch { /* best-effort teardown */ }
  }

  private forgetSession(session: McpSession): void {
    session.closed = true
    if (session.timer) clearTimeout(session.timer)
    session.unsubscribe?.()
    this._pending.delete(session)
    if (session.transport.sessionId) this._sessions.delete(session.transport.sessionId)
  }

  private touchSession(session: McpSession, expiresAt?: number): void {
    if (session.timer) clearTimeout(session.timer)
    session.timer = setTimeout(() => { void this.closeSession(session) }, Math.max(1, Math.min(SESSION_IDLE_MS, (expiresAt ?? Infinity) - Date.now())))
    session.timer.unref?.()
  }

  status(): McpServerStatus {
    return {
      enabled: this.isEnabledSetting(),
      running: this.isEnabledSetting(),
      activeSessions: this._sessions.size,
      toolCount: this._toolCount,
    }
  }

  /** Build a fresh McpServer with the full tool + resource catalog registered. */
  private buildServer(): McpServer {
    const server = new McpServer(
      { name: 'specrails-desktop', version: this._version },
      { capabilities: { logging: {}, tools: {}, resources: {} } },
    )
    const context = { ...this._ctx, sessionState: { activeProjectId: null } }
    for (const spec of buildToolSpecs()) {
      registerTieredTool(server, context, spec)
    }
    registerResources(server, context)
    return server
  }

  /**
   * Express handler for the `/api/mcp` streamable-HTTP endpoint. Stateful:
   * an initialize POST mints a session + transport; subsequent POST/GET/DELETE
   * carry the `mcp-session-id` header.
   */
  async handleHttp(req: Request, res: Response): Promise<void> {
    // The external Settings toggle gates third-party clients. Only a live,
    // server-minted per-turn capability identifies the in-app agent and may
    // bypass it; caller-authored context headers grant no authority.
    const suppliedCapability = req.headers[AGENT_CAPABILITY_HEADER]
    const capability = verifyAgentCapability(suppliedCapability)
    if (suppliedCapability !== undefined && !capability) {
      res.status(401).json(jsonRpcError('Agent capability expired or was revoked. Start a new mission turn.', -32001))
      return
    }
    if (!this.isEnabledSetting() && !capability) {
      res.status(404).json(jsonRpcError('MCP is disabled. Enable it in the Specrails app under Settings ▸ MCP.', -32004))
      return
    }
    const suppliedSession = req.headers['mcp-session-id']
    if (suppliedSession !== undefined && (typeof suppliedSession !== 'string' || !suppliedSession.trim())) {
      res.status(400).json(jsonRpcError('Invalid mcp-session-id.'))
      return
    }
    const sessionId = suppliedSession as string | undefined
    const capabilityHash = capability && typeof suppliedCapability === 'string'
      ? createHash('sha256').update(suppliedCapability.trim()).digest('hex') : null
    let session = sessionId ? this._sessions.get(sessionId) : undefined
    if (sessionId && !session) {
      // Streamable HTTP clients recognize 404 as an expired session and must
      // initialize again. 400 left SDK clients stuck with the stale id forever.
      res.status(404).json(jsonRpcError('Unknown or expired MCP session. Reinitialize.'))
      return
    }
    if (session && session.capabilityHash !== capabilityHash) {
      res.status(403).json(jsonRpcError('MCP session belongs to a different agent turn or client. Reinitialize.'))
      return
    }

    try {
      if (req.method === 'POST') {
        if (!session) {
          if (!isInitializeRequest(req.body)) {
            res.status(400).json(jsonRpcError('Missing mcp-session-id and body is not an initialize request.'))
            return
          }
          const server = this.buildServer()
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              this._pending.delete(created)
              this._sessions.set(sid, created)
            },
          })
          const created: McpSession = { transport, server, capabilityHash, closed: false }
          session = created
          this._pending.add(created)
          transport.onclose = () => { this.forgetSession(created) }
          if (capability && typeof suppliedCapability === 'string') {
            created.unsubscribe = onAgentCapabilityRevoked(suppliedCapability, () => { void this.closeSession(created) })
          }
          await server.connect(transport)
        }
        if (session.closed) {
          res.status(503).json(jsonRpcError('MCP session closed during initialization. Reconnect.'))
          return
        }
        this.touchSession(session, capability?.expiresAt)
        await session.transport.handleRequest(req, res, req.body)
        if (!session.transport.sessionId) await this.closeSession(session)
        return
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!session) {
          res.status(400).json(jsonRpcError('Missing mcp-session-id.'))
          return
        }
        this.touchSession(session, capability?.expiresAt)
        await session.transport.handleRequest(req, res)
        return
      }

      res.status(405).json(jsonRpcError('Method not allowed.'))
    } catch (err) {
      if (session && !session.transport.sessionId) await this.closeSession(session)
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(err instanceof Error ? err.message : 'Internal MCP error', -32603))
      }
    }
  }
}
