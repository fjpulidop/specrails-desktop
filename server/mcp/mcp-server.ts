import type { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { ProjectRegistry } from '../project-registry'
import type { WsMessage } from '../types'
import { getMobileEventBus, type MobileEventBus } from '../mobile/mobile-event-bus'
import { isMcpEnabled, MCP_ENABLED_KEY } from './mcp-tiers'
import { setDesktopSetting } from '../desktop-db'
import { buildToolSpecs } from './tools/catalog'
import { registerTieredTool, type McpToolContext } from './tools/types'
import { registerResources } from './resources'

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
export class McpServerManager {
  private readonly _ctx: McpToolContext
  private readonly _version: string
  private readonly _transports: Record<string, StreamableHTTPServerTransport> = {}
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
    if (!enabled) await this.stop()
    this._ctx.broadcast({ type: 'mcp.state', enabled, running: enabled } as unknown as WsMessage)
    return this.status()
  }

  // Mounting happens on the shared app, so start() has no port to bind; it
  // exists for lifecycle symmetry with MobileGateway. The transport only serves
  // when isEnabledSetting() is true (checked in handleHttp).
  async start(): Promise<void> {
    /* no-op: served on the shared app, gated by isEnabledSetting() */
  }

  /** Close all open MCP sessions. */
  async stop(): Promise<void> {
    for (const sid of Object.keys(this._transports)) {
      try {
        await this._transports[sid].close()
      } catch {
        /* ignore */
      }
      delete this._transports[sid]
    }
  }

  status(): McpServerStatus {
    return {
      enabled: this.isEnabledSetting(),
      running: this.isEnabledSetting(),
      activeSessions: Object.keys(this._transports).length,
      toolCount: this._toolCount,
    }
  }

  /** Build a fresh McpServer with the full tool + resource catalog registered. */
  private buildServer(): McpServer {
    const server = new McpServer(
      { name: 'specrails-desktop', version: this._version },
      { capabilities: { logging: {}, tools: {}, resources: {} } },
    )
    for (const spec of buildToolSpecs()) {
      registerTieredTool(server, this._ctx, spec)
    }
    registerResources(server, this._ctx)
    return server
  }

  /**
   * Express handler for the `/api/mcp` streamable-HTTP endpoint. Stateful:
   * an initialize POST mints a session + transport; subsequent POST/GET/DELETE
   * carry the `mcp-session-id` header.
   */
  async handleHttp(req: Request, res: Response): Promise<void> {
    if (!this.isEnabledSetting()) {
      res.status(404).json(jsonRpcError('MCP is disabled. Enable it in the Specrails app under Settings ▸ MCP.', -32004))
      return
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined

    try {
      if (req.method === 'POST') {
        let transport = sessionId ? this._transports[sessionId] : undefined
        if (!transport) {
          if (sessionId) {
            res.status(400).json(jsonRpcError('Unknown or expired MCP session. Reinitialize.'))
            return
          }
          if (!isInitializeRequest(req.body)) {
            res.status(400).json(jsonRpcError('Missing mcp-session-id and body is not an initialize request.'))
            return
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              this._transports[sid] = transport as StreamableHTTPServerTransport
            },
          })
          transport.onclose = () => {
            const sid = transport?.sessionId
            if (sid && this._transports[sid]) delete this._transports[sid]
          }
          const server = this.buildServer()
          await server.connect(transport)
        }
        await transport.handleRequest(req, res, req.body)
        return
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        const transport = sessionId ? this._transports[sessionId] : undefined
        if (!transport) {
          res.status(400).json(jsonRpcError('Missing or unknown mcp-session-id.'))
          return
        }
        await transport.handleRequest(req, res)
        return
      }

      res.status(405).json(jsonRpcError('Method not allowed.'))
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(err instanceof Error ? err.message : 'Internal MCP error', -32603))
      }
    }
  }
}
