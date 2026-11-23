import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z, type ZodRawShape } from 'zod'
import type { ProjectRegistry, ProjectContext } from '../../project-registry'
import type { DbInstance } from '../../db'
import type { WsMessage } from '../../types'
import type { MobileEventBus } from '../../mobile/mobile-event-bus'
import { isTierEnabled, tierRefusalMessage, type McpTier } from '../mcp-tiers'
import { createInternalApi } from '../../internal-api'
import { AGENT_CAPABILITY_HEADER, levelAllowsTier, type AgentTierLevel } from '../../modules/missions/runtime/agent-tier'
import { getAgentConversation } from '../../modules/agents/runtime/agent-store'
import { verifyAgentCapability } from '../agent-capability'
import { getProjectRepositories, resolveProjectRepository, type ProjectRepository } from '../../project-repositories'
import { acknowledgeAgentSteering, acknowledgeAgentInputsRead, onAgentSteering, runWithAgentSteering } from '../../modules/missions/runtime/agent-steering'
import { ENVELOPE_OUTPUT_SHAPE, McpToolError, errorEnvelope, isToolResponse, successEnvelope, type Envelope } from './envelope'
import { summarizeResult } from './summaries'
import { wireInputObject, wireToolDescription } from './wire-schema'
import { validateActionArgs, type ActionAlias, type ActionFields, type ResolvedAlias } from './actions'

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
  /** Request-bound closure; never accepts a conversation id or exposes a bearer. */
  acknowledgeAgentUpdates?: (revision: number) => unknown
  acknowledgeAgentInputsRead?: (inputIds: string[]) => unknown
  /** Authenticated turn-scoped notification; only read-only waits may yield early. */
  onMissionInput?: (listener: () => void) => () => void
}

export class McpApiError extends Error {
  readonly code?: string
  constructor(message: string, readonly status: number, readonly data: unknown, readonly route?: { method: string; path: string }) {
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
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  // Shared loopback client (server/internal-api.ts) — also drives the milestone
  // launch chain's chunk launches, so both stay byte-identical to a dashboard call.
  // MCP calls additionally retain their request cancellation and bounded wait;
  // those lifetimes belong to this call, not to the durable milestone chain.
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000)
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
  const res = await createInternalApi({
    port: ctx.desktopPort,
    fetchImpl: (input, init) => fetch(input, { ...init, signal }),
  }).call(method, path, body)
  if (!res.ok) {
    const data = res.body
    const detail = typeof data === 'object' && data !== null ? JSON.stringify(data) : String(data)
    throw new McpApiError(`API ${method} ${path} → ${res.status}: ${detail}`, res.status, data, { method, path: path.split('?')[0] })
  }
  return res.body
}

/** Convenience: build the `/projects/<id>` path prefix for a resolved project. */
export function projectPath(ctx: McpToolContext, projectId: string | undefined): string {
  return `/projects/${requireProject(ctx, projectId).project.id}`
}

/** Repository identity is relative to the resolved project, never a free path
 * or another project's membership. MCP requires a choice where a file/Git
 * operation could otherwise silently target the primary. */
export function requireRepository(ctx: McpToolContext, projectId?: string, repositoryId?: string): ProjectRepository {
  const { project } = requireProject(ctx, projectId)
  const repositories = getProjectRepositories(project)
  if (repositoryId === undefined && repositories.length > 1) {
    const data = { error: 'repository_required', projectId: project.id, repositories }
    throw new McpApiError(`Provide repositoryId for this multi-repository project: ${JSON.stringify(data)}`, 400, data)
  }
  return resolveProjectRepository(project, repositoryId)
}

export function repositoryPath(ctx: McpToolContext, projectId?: string, repositoryId?: string): string {
  const repository = requireRepository(ctx, projectId, repositoryId)
  const base = `/projects/${encodeURIComponent(repository.projectId)}`
  return repositoryId === undefined ? base : `${base}/repositories/${encodeURIComponent(repository.id)}`
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
  /**
   * In-app agent turns only: true when this call is admitted although the
   * conversation's permission ladder is below the action's tier, because the
   * user already granted that scope elsewhere (an active Intent grants write and
   * execution in its worktree). Never consulted for external MCP clients, whose
   * tiers stay governed by Settings ▸ MCP. Must not throw.
   */
  tierException?: (ctx: McpToolContext, args: Record<string, unknown>) => boolean
  /**
   * Hidden legacy actions that moved to another tool (accepted, never
   * advertised). Wired by `linkAliases` in the catalog; see ./actions.ts.
   */
  aliases?: Record<string, ActionAlias>
  /** Arguments each action takes; validated at runtime before the handler runs. */
  actionFields?: Record<string, ActionFields>
  /** Set by `linkAliases`: the target spec and mapped arguments of an alias call. */
  resolveAlias?: (args: Record<string, unknown>) => ResolvedAlias | null
}

/** Resolve a per-project context or throw a clear, LLM-readable error. */
export function requireProject(ctx: McpToolContext, projectId: string | undefined): ProjectContext {
  const id = projectId ?? getActiveProject(ctx)
  if (!id) {
    throw new McpToolError('ambiguous', 'No project specified and no active project selected. Call specrails_select_project or pass projectId.', { choices: projectChoices(ctx) })
  }
  const pc = ctx.registry.getContext(id)
  if (!pc) {
    if (ctx.registry.getProjectRow?.(id)) {
      throw new McpToolError('provider_unavailable', `Project "${id}" is registered but its database is temporarily unavailable. Retry after recovery; do not register a duplicate project.`)
    }
    throw new McpToolError('not_found', `Unknown projectId "${id}". Use specrails_projects(list) to see valid ids.`, { choices: projectChoices(ctx) })
  }
  return pc
}

/** Valid project selectors for an ambiguous/unknown project error (bounded). */
export function projectChoices(ctx: McpToolContext): Array<{ projectId: string; name: string }> {
  try {
    return (ctx.registry.listProjects?.() ?? []).slice(0, 25).map((project) => ({ projectId: project.id, name: project.name }))
  } catch {
    return []
  }
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

/**
 * Success: the envelope as JSON text AND as structuredContent. A prose payload
 * (the guide) keeps its readable text; the structured envelope still carries it.
 */
function envelopeResult(envelope: Envelope): CallToolResult {
  const prose = envelope.ok && typeof envelope.data === 'string'
  const text = prose ? envelope.data as string : JSON.stringify(envelope, null, 2)
  return {
    content: [{ type: 'text', text }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    ...(envelope.ok ? {} : { isError: true }),
  }
}

function errorResult(err: unknown, tool: string, action: string | null): CallToolResult {
  return envelopeResult(errorEnvelope(err, tool, action))
}

const actionOf = (args: Record<string, unknown>): string | null => typeof args.action === 'string' ? args.action : null

// ── Destructive confirmation ─────────────────────────────────────────────────

/** Actions of a facade whose tier resolves to destructive with default arguments. */
export function destructiveActions(spec: McpToolSpec): string[] {
  if (spec.tier === 'destructive') return ['*']
  if (typeof spec.tier !== 'function') return []
  const field = spec.inputSchema.action as { options?: unknown } | undefined
  const options = Array.isArray(field?.options) ? field.options as string[] : []
  const tier = spec.tier
  return options.filter((action) => { try { return tier({ action }) === 'destructive' } catch { return false } })
}

/**
 * Adds `confirm` / `dryRun` to a tool that has destructive actions. External
 * clients must resend a destructive call with `confirm:true`; `dryRun:true`
 * never executes and describes what would happen.
 */
export function withConfirmationFields(spec: McpToolSpec): McpToolSpec {
  if (!destructiveActions(spec).length) return spec
  return {
    ...spec,
    inputSchema: {
      ...spec.inputSchema,
      confirm: z.boolean().optional().describe('Required (true) for destructive actions from external MCP clients, after the person explicitly agreed. Without it the call returns confirmation_required with the exact arguments to resend.'),
      dryRun: z.boolean().optional().describe('true: do not execute; describe what this call would do and which permission tier it needs.'),
    },
  }
}

/** One sentence on what a destructive action does, read from the tool description. */
export function describeEffect(spec: McpToolSpec, action: string | null, args: Record<string, unknown> = {}): string {
  const routed = action ? resolveAliasSafe(spec, { ...args, action }) : null
  if (routed) return describeEffect(routed.spec as unknown as McpToolSpec, String(routed.args.action))
  if (action) {
    const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`${escaped}\\s*\\(([^)]*)\\)`).exec(spec.description)
    if (match?.[1]) return match[1].replace(/^destructive\s*[—–-]\s*/i, '').trim()
  }
  return spec.title
}

function resolveAliasSafe(spec: McpToolSpec, args: Record<string, unknown>): ResolvedAlias | null {
  try { return spec.resolveAlias?.(args) ?? null } catch { return null }
}

function stripControl(args: Record<string, unknown>): Record<string, unknown> {
  const { confirm: _confirm, dryRun: _dryRun, ...rest } = args
  void _confirm; void _dryRun
  return rest
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
 * Agent actions audit for first-party mission agents: one `mcp` row per
 * admitted tool call, in the capability's project, run id = the mission
 * conversation. Only the tool and its action are stored — never arguments.
 * Observing only: a missing project or a failing sink never affects the call.
 */
export function recordMissionMcpAction(ctx: McpToolContext, toolName: string, args: Record<string, unknown>): void {
  try {
    const projectId = ctx.requestProjectId
    const conversationId = ctx.originConversationId
    if (!projectId || !conversationId) return
    const recorder = ctx.registry.getContext(projectId)?.agentAudit?.recorder
    if (!recorder) return
    const action = typeof args.action === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(args.action) ? args.action : null
    recorder.record({
      runId: conversationId,
      role: 'mission',
      kind: 'mcp',
      target: action ? `${toolName}:${action}` : toolName,
      source: 'mcp-wrapper',
    })
  } catch { /* audit is observing only */ }
}

function admittedByException(spec: McpToolSpec, ctx: McpToolContext, args: Record<string, unknown>): boolean {
  try { return spec.tierException?.(ctx, args) === true } catch { return false }
}

/**
 * Registers a tool on the McpServer, wrapping the handler with (1) tier
 * enforcement and (2) uniform success/error result shaping. No tool can forget
 * the tier check because it lives here, not in the handler.
 */
/**
 * Tools an in-app session leaves to Claude Code tool search even when the rest
 * load up front: integration tools a conversation rarely needs. Keeping at
 * least one Specrails tool deferred also keeps tool search on, so a connector
 * that appears mid-session arrives as a deferred name, not a prompt rewrite.
 */
export const DEFERRED_IN_APP_TOOLS: ReadonlySet<string> = new Set(['specrails_jira', 'specrails_plugins'])

/** Claude Code `_meta` key that exempts a tool from tool search deferral. */
export const ALWAYS_LOAD_META_KEY = 'anthropic/alwaysLoad'

export function registerTieredTool(server: McpServer, ctx: McpToolContext, spec: McpToolSpec, options: {
  alwaysLoad?: boolean
  /** Decorates the call handler (the v2 surface adds deprecation warnings to hidden v1 aliases). */
  wrapCallback?: (callback: ReturnType<typeof tieredToolCallback>) => ReturnType<typeof tieredToolCallback>
} = {}): void {
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
      // The compact wire text (./wire-schema.ts); specrails_describe keeps the full docs.
      description: wireToolDescription(spec),
      // Same validators with brief descriptions. A facade with hidden aliases keeps
      // the arguments of the moved actions (validated below against the target
      // tool's own schema).
      inputSchema: wireInputObject(spec),
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations,
      // In-app agents get the Specrails tools up front (a mission is about
      // Specrails); external clients keep their own tool search behavior.
      ...(options.alwaysLoad && !DEFERRED_IN_APP_TOOLS.has(spec.name) ? { _meta: { [ALWAYS_LOAD_META_KEY]: true } } : {}),
    },
    options.wrapCallback ? options.wrapCallback(tieredToolCallback(ctx, spec)) : tieredToolCallback(ctx, spec),
  )
}

/**
 * The call handler `registerTieredTool` registers: admission (capability,
 * tier, confirmation), dispatch and envelope shaping. Exported so the v2
 * surface can keep serving a v1 tool as a hidden alias with the exact same
 * behavior (server/mcp/v2/legacy.ts).
 */
export function tieredToolCallback(ctx: McpToolContext, spec: McpToolSpec): (args: Record<string, unknown>, extra?: ToolHandlerExtra) => Promise<CallToolResult> {
  return async (args: Record<string, unknown>, extra?: ToolHandlerExtra): Promise<CallToolResult> => {
      const action = actionOf(args ?? {})
      const fail = (message: string, code: 'unauthorized' | 'provider_unavailable' = 'unauthorized') =>
        errorResult(new McpToolError(code, message), spec.name, action)
      if (extra?.signal?.aborted) return fail('MCP request was cancelled before execution.', 'provider_unavailable')
      // Loopback identifies a machine, not a trusted caller. All first-party
      // authority and context come from this unguessable, server-minted bearer;
      // legacy tier/project/conversation headers are deliberately ignored.
      const suppliedCapability = extra?.requestInfo?.headers?.[AGENT_CAPABILITY_HEADER]
      const capability = verifyAgentCapability(suppliedCapability)
      if (suppliedCapability !== undefined && !capability) {
        return fail('Agent capability expired or was revoked. Start a new mission turn to reconnect.')
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
      if (!toolTierAllowed(callCtx, tier) && !(callCtx.firstPartyAgent && admittedByException(spec, callCtx, args ?? {}))) {
        return fail(tierRefusalMessage(tier))
      }
      const confirmable = 'confirm' in spec.inputSchema
      if (confirmable && args?.dryRun === true) {
        const effect = describeEffect(spec, action, args ?? {})
        const label = action ? `${spec.name}(${action})` : spec.name
        return envelopeResult(successEnvelope({
          tool: spec.name, action, tier, args: stripControl(args ?? {}), effect,
          wouldExecute: false, requiresConfirm: tier === 'destructive' && !callCtx.firstPartyAgent,
        }, { tool: spec.name, action, meta: {
          status: 'dry_run',
          summary: `Dry run, nothing executed: ${label} would ${tier === 'destructive' ? 'perform a destructive change' : `run with the ${tier} tier`} (${effect}).`,
          next: [{ tool: spec.name, args: { ...stripControl(args ?? {}), ...(tier === 'destructive' ? { confirm: true } : {}) }, why: 'Execute it for real once the person agrees.' }],
        } }))
      }
      // External clients confirm destructive calls explicitly; the in-app agent's
      // live permission ladder (and its own confirmation cards) already governs it.
      if (confirmable && tier === 'destructive' && !callCtx.firstPartyAgent && args?.confirm !== true) {
        const resend = { tool: spec.name, args: { ...stripControl(args ?? {}), confirm: true } }
        return errorResult(new McpToolError('confirmation_required',
          `${action ? `${spec.name}(${action})` : spec.name} is destructive (${describeEffect(spec, action, args ?? {})}). Ask the person to confirm, then resend with confirm:true.`,
          { resend, next: [{ ...resend, why: 'Resend after the person explicitly confirmed.' }, { tool: spec.name, args: { ...stripControl(args ?? {}), dryRun: true }, why: 'Preview what it would do without executing.' }] }), spec.name, action)
      }
      const handlerArgs = confirmable ? stripControl(args ?? {}) : (args ?? {})
      if (capability) recordMissionMcpAction(callCtx, spec.name, handlerArgs)
      const operation = async (): Promise<CallToolResult> => {
        try {
          // An alias is validated and summarized as the call it stands for.
          const routed = resolveAliasSafe(spec, handlerArgs)
          const canonical = routed
            ? { name: routed.spec.name, args: routed.args, fields: (routed.spec as unknown as McpToolSpec).actionFields }
            : { name: spec.name, args: handlerArgs, fields: spec.actionFields }
          let data: unknown
          if (routed) {
            const parsed = z.object(routed.spec.inputSchema as ZodRawShape).safeParse(routed.args)
            if (!parsed.success) {
              throw new McpToolError('invalid_input', `${spec.name}(${action}) is now ${routed.spec.name}(${String(routed.args.action)}): ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ')}.`)
            }
            validateActionArgs(canonical.name, canonical.fields, parsed.data)
            data = await routed.spec.handler(callCtx as never, parsed.data)
          } else {
            validateActionArgs(canonical.name, canonical.fields, canonical.args)
            data = await spec.handler(callCtx, handlerArgs)
          }
          if (tier !== 'read') emitMcpActivity(callCtx, spec, handlerArgs, tier)
          let meta
          if (!isToolResponse(data)) {
            try { meta = summarizeResult(canonical.name, actionOf(canonical.args), canonical.args, data) } catch { meta = undefined }
          }
          return envelopeResult(successEnvelope(data, { tool: spec.name, action, meta }))
        } catch (err) {
          return errorResult(err, spec.name, action)
        }
      }
      if (capability && typeof suppliedCapability === 'string') {
        callCtx.acknowledgeAgentUpdates = revision => acknowledgeAgentSteering(ctx.desktopDb, suppliedCapability, revision)
        callCtx.acknowledgeAgentInputsRead = inputIds => acknowledgeAgentInputsRead(ctx.desktopDb, suppliedCapability, inputIds)
        callCtx.onMissionInput = listener => onAgentSteering(ctx.desktopDb, suppliedCapability, listener)
        return runWithAgentSteering(ctx.desktopDb, suppliedCapability, extra?.signal, operation, {
          acknowledgement: spec.name === 'specrails_mission' && args?.action === 'acknowledge_updates',
        })
      }
      callCtx.acknowledgeAgentUpdates = undefined
      callCtx.acknowledgeAgentInputsRead = undefined
      callCtx.onMissionInput = undefined
      return operation()
  }
}
