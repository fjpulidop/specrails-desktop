import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ZodRawShape } from 'zod'
import type { ProjectRegistry, ProjectContext } from '../../project-registry'
import type { DbInstance } from '../../db'
import type { WsMessage } from '../../types'
import type { MobileEventBus } from '../../mobile/mobile-event-bus'
import { isTierEnabled, tierRefusalMessage, type McpTier } from '../mcp-tiers'
import { createInternalApi } from '../../internal-api'
import { AGENT_CAPABILITY_HEADER, levelAllowsTier, type AgentTierLevel } from '../../agent-tier'
import { getAgentConversation } from '../../agent-store'
import { verifyAgentCapability } from '../agent-capability'

export type { McpTier } from '../mcp-tiers'

/**
 * The subset of the MCP SDK's per-call `RequestHandlerExtra` we read: the
 * inbound HTTP request headers (populated by StreamableHTTPServerTransport).
 * Kept structural so we don't couple to the SDK's exact type export.
 */
export interface ToolHandlerExtra {
  requestInfo?: { headers?: Record<string, string | string[] | undefined> }
  signal?: AbortSignal
}

/** Everything a tool handler needs to drive the in-process managers. */
export interface McpToolContext {
  registry: ProjectRegistry
  desktopDb: DbInstance
  broadcast: (msg: WsMessage) => void
  eventBus: MobileEventBus
  /** Port the loopback REST API listens on (for apiCall). */
  desktopPort: number
  /**
   * Per-REQUEST active project, set by `registerTieredTool` from the verified
   * in-app agent capability. Scoped to a single tool call (a fresh ctx
   * copy per dispatch) so a concurrent external client and the in-app agent can
   * never clobber each other's active project. Takes precedence over the sticky
   * process-wide selection made via `specrails_select_project`.
   */
  requestProjectId?: string | null
  /**
   * Per-REQUEST launching agent-chat conversation id (safe-pr-review-flow origin
   * link), set by `registerTieredTool` from the verified in-app capability.
   * Tool handlers thread it into launch bodies so the PR decision can be posted
   * back into the authenticated conversation.
   */
  originConversationId?: string | null
  /** True only when the request presented a live server-minted capability. */
  firstPartyAgent?: boolean
  agentTierLevel?: AgentTierLevel
  /** Mutable defaults shared only by requests belonging to this MCP session. */
  sessionState?: { activeProjectId: string | null }
  /** SDK cancellation for this request; never stored in the session context. */
  signal?: AbortSignal
}

export class McpApiError extends Error {
  readonly code?: string
  constructor(message: string, readonly status: number, readonly data: unknown) {
    super(message)
    this.name = 'McpApiError'
    const error = (data as { error?: unknown } | null)?.error
    if (typeof error === 'string') this.code = error
  }
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
  // Shared loopback client (server/internal-api.ts) — also drives the milestone
  // launch chain's chunk launches, so both stay byte-identical to a dashboard call.
  // MCP calls additionally retain their request cancellation and bounded wait;
  // those lifetimes belong to this call, not to the durable milestone chain.
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000)
  const res = await createInternalApi({
    port: ctx.desktopPort,
    fetchImpl: (input, init) => fetch(input, { ...init, signal }),
  }).call(method, path, body)
  if (!res.ok) {
    const data = res.body
    const detail = typeof data === 'object' && data !== null ? JSON.stringify(data) : String(data)
    throw new McpApiError(`API ${method} ${path} → ${res.status}: ${detail}`, res.status, data)
  }
  return res.body
}

/** Convenience: build the `/projects/<id>` path prefix for a resolved project. */
export function projectPath(ctx: McpToolContext, projectId: string | undefined): string {
  return `/projects/${requireProject(ctx, projectId).project.id}`
}

/**
 * Launch defaults derived from the LAUNCHING agent-chat conversation (the
 * authenticated origin carried on `ctx.originConversationId`). When the in-app agent
 * drives a rail launch / job spawn WITHOUT an explicit engine, the job must
 * run on the CONVERSATION's provider — a codex conversation asking to
 * implement must not silently launch claude via the router's fall-through to
 * the project primary. This is STRUCTURAL (looked up from the agent store),
 * never prompt-dependent; explicit args always win at the callsite, and
 * provider validation stays with the router (an uninstalled provider surfaces
 * its existing clear 400 as the tool error). No origin conversation
 * (dashboard / external MCP client), an unknown/malformed id, or a store
 * failure all yield `{}` — those calls proceed byte-identically to before.
 */
export function originConversationDefaults(ctx: McpToolContext): { provider?: string; model?: string; reasoningEffort?: string } {
  if (!ctx.originConversationId) return {}
  try {
    const conv = getAgentConversation(ctx.desktopDb, ctx.originConversationId)
    if (!conv) return {}
    return {
      ...(conv.provider ? { provider: conv.provider } : {}),
      ...(conv.model ? { model: conv.model } : {}),
      ...(conv.reasoning_effort ? { reasoningEffort: conv.reasoning_effort } : {}),
    }
  } catch {
    return {}
  }
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
  /** Display grouping hint. Dynamic facades still receive conservative protocol
   * annotations because clients may use readOnlyHint for automatic approval. */
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
  if (!pc) {
    if (ctx.registry.getProjectRow?.(id)) {
      throw new Error(`Project "${id}" is registered but its database is temporarily unavailable. Retry after recovery; do not register a duplicate project.`)
    }
    throw new Error(`Unknown projectId "${id}". Use specrails_projects(list) to see valid ids.`)
  }
  return pc
}

// ── Active-project stickiness (per server process) ────────────────────────────
// The active project is a soft default; an explicit projectId always wins, and
// a per-request pin (ctx.requestProjectId, from the verified in-app capability)
// wins over the process-wide selection. `setActiveProject` remains for
// `specrails_select_project`; request context must never mutate this global.
let _activeProjectId: string | null = null
export function setActiveProject(ctx: McpToolContext, id: string | null): void
export function setActiveProject(id: string | null): void
export function setActiveProject(ctxOrId: McpToolContext | string | null, id?: string | null): void {
  if (typeof ctxOrId === 'object' && ctxOrId !== null) {
    ctxOrId.sessionState ??= { activeProjectId: null }
    ctxOrId.sessionState.activeProjectId = id ?? null
  } else {
    // Compatibility for direct legacy unit callers. Live transports always
    // provide sessionState and never consult or change this fallback.
    _activeProjectId = ctxOrId
  }
}
export function getActiveProject(ctx: McpToolContext): string | null {
  return ctx.requestProjectId !== undefined ? ctx.requestProjectId
    : ctx.sessionState ? ctx.sessionState.activeProjectId : _activeProjectId
}

export function toolTierAllowed(ctx: McpToolContext, tier: McpTier): boolean {
  return ctx.firstPartyAgent && ctx.agentTierLevel !== undefined
    ? levelAllowsTier(ctx.agentTierLevel, tier)
    : isTierEnabled(ctx.desktopDb, tier)
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
  const text = typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2)
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
      (typeof args.projectId === 'string' ? args.projectId : null) ??
      ctx.requestProjectId ??
      getActiveProject(ctx)
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
  // An action facade may read, write, launch AI and delete data through ONE
  // protocol tool. Advertising the common read action as readOnlyHint:true
  // misleads clients that use annotations when approving mutations.
  const annotations = typeof spec.tier === 'function'
    ? { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    : tierAnnotations(spec.tier)
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations,
    },
    async (args: Record<string, unknown>, extra?: ToolHandlerExtra): Promise<CallToolResult> => {
      if (extra?.signal?.aborted) return errorResult('MCP request was cancelled before execution.')
      // Loopback identifies a machine, not a trusted caller. All first-party
      // authority and context come from this unguessable, server-minted bearer;
      // legacy tier/project/conversation headers are deliberately ignored.
      const suppliedCapability = extra?.requestInfo?.headers?.[AGENT_CAPABILITY_HEADER]
      const capability = verifyAgentCapability(suppliedCapability)
      if (suppliedCapability !== undefined && !capability) {
        return errorResult('Agent capability expired or was revoked. Start a new mission turn to reconnect.')
      }
      const callCtx: McpToolContext = capability
        ? {
            ...ctx,
            requestProjectId: capability.projectId,
            originConversationId: capability.conversationId,
            firstPartyAgent: true,
            agentTierLevel: capability.tierLevel,
          }
        : { ...ctx }
      callCtx.signal = extra?.signal
      const tier: McpTier = typeof spec.tier === 'function' ? spec.tier(args ?? {}) : spec.tier
      if (!toolTierAllowed(callCtx, tier)) {
        return errorResult(tierRefusalMessage(tier))
      }
      try {
        const data = await spec.handler(callCtx, args ?? {})
        if (tier !== 'read') emitMcpActivity(callCtx, spec, args ?? {}, tier)
        return toResult(data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err))
      }
    },
  )
}
