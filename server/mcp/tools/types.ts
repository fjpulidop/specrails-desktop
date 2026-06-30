import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ZodRawShape } from 'zod'
import type { ProjectRegistry, ProjectContext } from '../../project-registry'
import type { DbInstance } from '../../db'
import type { WsMessage } from '../../types'
import type { MobileEventBus } from '../../mobile/mobile-event-bus'
import { isTierEnabled, tierRefusalMessage, type McpTier } from '../mcp-tiers'
import { loadOrGenerateToken } from '../../auth'

export type { McpTier } from '../mcp-tiers'

/** Everything a tool handler needs to drive the in-process managers. */
export interface McpToolContext {
  registry: ProjectRegistry
  desktopDb: DbInstance
  broadcast: (msg: WsMessage) => void
  eventBus: MobileEventBus
  /** Port the loopback REST API listens on (for apiCall). */
  desktopPort: number
}

/**
 * Calls the app's own REST API over loopback using the MASTER token (held
 * server-side, never exposed to the MCP client). This reuses every router's
 * existing logic/validation rather than re-implementing it in tools — the same
 * loopback-forward pattern the Mobile Gateway uses for REST. `path` is appended
 * after `/api` (e.g. `/projects/<id>/tickets`).
 */
export async function apiCall(
  ctx: McpToolContext,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `http://127.0.0.1:${ctx.desktopPort}/api${path}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${loadOrGenerateToken()}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const detail = typeof data === 'object' && data !== null ? JSON.stringify(data) : String(data)
    throw new Error(`API ${method} ${path} → ${res.status}: ${detail}`)
  }
  return data
}

/** Convenience: build the `/projects/<id>` path prefix for a resolved project. */
export function projectPath(ctx: McpToolContext, projectId: string | undefined): string {
  return `/projects/${requireProject(ctx, projectId).project.id}`
}

/**
 * A single MCP tool. Handlers return plain data (serialized to JSON text by the
 * framework) or a string; throwing yields an `isError` result. The framework
 * enforces the tier before dispatch.
 *
 * `tier` may be a fixed tier or a function of the args — domain-facade tools
 * with an `action` enum mix tiers (e.g. list=read, delete=destructive), so the
 * tier is resolved per call from the chosen action.
 */
export interface McpToolSpec {
  name: string
  title: string
  description: string
  tier: McpTier | ((args: Record<string, unknown>) => McpTier)
  /** Static hint for tool annotations when `tier` is dynamic. */
  hintTier?: McpTier
  inputSchema: ZodRawShape
  handler: (ctx: McpToolContext, args: Record<string, unknown>) => Promise<unknown> | unknown
}

/** Resolve a per-project context or throw a clear, LLM-readable error. */
export function requireProject(ctx: McpToolContext, projectId: string | undefined): ProjectContext {
  const id = projectId ?? getActiveProject(ctx)
  if (!id) {
    throw new Error('No project specified and no active project selected. Call specrails_select_project or pass projectId.')
  }
  const pc = ctx.registry.getContext(id)
  if (!pc) throw new Error(`Unknown projectId "${id}". Use specrails_projects(list) to see valid ids.`)
  return pc
}

// ── Active-project stickiness (per server process) ────────────────────────────
// The active project is a soft default; an explicit projectId always wins.
let _activeProjectId: string | null = null
export function setActiveProject(id: string | null): void {
  _activeProjectId = id
}
export function getActiveProject(_ctx: McpToolContext): string | null {
  return _activeProjectId
}

function tierAnnotations(tier: McpTier): { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } {
  switch (tier) {
    case 'read':
      return { readOnlyHint: true, openWorldHint: false }
    case 'write':
      return { readOnlyHint: false, openWorldHint: false }
    case 'ai-spawn':
      return { readOnlyHint: false, openWorldHint: true }
    case 'destructive':
      return { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }
}

function toResult(data: unknown): CallToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text', text }] }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

/**
 * Broadcasts an app-level `mcp.activity` event after a successful mutating tool
 * call so the UI can surface what an external LLM did — regardless of which
 * project is currently active. Deliberately carries NO top-level `projectId`
 * (so the client's per-project WS filter does not drop it); the affected project
 * is in `affectedProjectId` for cache invalidation. Read-tier calls don't emit.
 * A notify failure must never break the tool, so it's wrapped.
 */
function emitMcpActivity(ctx: McpToolContext, spec: McpToolSpec, args: Record<string, unknown>, tier: McpTier): void {
  try {
    const affectedProjectId =
      (typeof args.projectId === 'string' ? args.projectId : null) ?? getActiveProject(ctx)
    ctx.broadcast({
      type: 'mcp.activity',
      tool: spec.name,
      action: typeof args.action === 'string' ? args.action : null,
      tier,
      affectedProjectId,
      title: spec.title,
      at: new Date().toISOString(),
    } as unknown as WsMessage)
  } catch {
    /* a notification failure must never fail the tool */
  }
}

/**
 * Registers a tool on the McpServer, wrapping the handler with (1) tier
 * enforcement and (2) uniform success/error result shaping. No tool can forget
 * the tier check because it lives here, not in the handler.
 */
export function registerTieredTool(server: McpServer, ctx: McpToolContext, spec: McpToolSpec): void {
  const hintTier: McpTier = spec.hintTier ?? (typeof spec.tier === 'string' ? spec.tier : 'write')
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: tierAnnotations(hintTier),
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const tier: McpTier = typeof spec.tier === 'function' ? spec.tier(args ?? {}) : spec.tier
      if (!isTierEnabled(ctx.desktopDb, tier)) {
        return errorResult(tierRefusalMessage(tier))
      }
      try {
        const data = await spec.handler(ctx, args ?? {})
        if (tier !== 'read') emitMcpActivity(ctx, spec, args ?? {}, tier)
        return toResult(data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err))
      }
    },
  )
}
