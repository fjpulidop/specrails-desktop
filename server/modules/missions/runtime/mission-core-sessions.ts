import type { DbInstance } from '../../../db'
import { prepareAgentMcpSpec, removeAgentCapabilityFile, type AgentMcpServerSpec } from '../../../agent-mcp-config'
import type { ResolvedExternalServer } from '../../../external-mcp'
import type { ProviderAdapter } from '../../../providers/types'
import type { CoreSessionsAvailability, SessionPolicyInput } from '../../agent-sessions'
import type { SessionHostRegistry } from '../../agent-sessions/runtime/session-host-registry'
import { getAgentConversation, type AgentConversation } from '../../agents/runtime/agent-store'
import { ensureSessionCursor, getSessionCursor, listSubagents, resetSessionProjection } from './agent-session-store'
import { sessionPolicyFor, type CoreSessionTurnContext, type TurnHandle } from './core-session-runner'
import { MissionSessionProjector } from './mission-session-projector'

export interface MissionCoreSessionsDeps {
  db: DbInstance
  registry: SessionHostRegistry
  port: number
  broadcast: (message: Record<string, unknown>) => void
  adapterFor: (providerId: string) => ProviderAdapter
  availability: () => Promise<CoreSessionsAvailability>
  /** Project key Core uses for the session scope (the project slug). */
  projectKey: (projectId: string) => string | null
  revokeCapability: (capability: string) => void
  /** Sub-agent policy for a conversation (the project toggle lands here later). */
  subagentPolicy?: (conversation: AgentConversation) => SessionPolicyInput['subagents']
}

export const GLOBAL_SCOPE = 'global'

/**
 * Missions' side of Core agent sessions: decides whether a turn runs in Core,
 * keeps each mission's session tracked and projected, and owns the lifetime of
 * the Specrails MCP capability a resident session presents (it lives until the
 * next turn rotates it or Core retires the provider process — continuation
 * turns after sub-agents finish must still reach Specrails tools).
 */
export class MissionCoreSessions {
  private readonly capabilities = new Map<string, string>()
  private readonly handles = new Map<string, TurnHandle>()
  private readonly tracked = new Set<string>()
  /** Last turn context per mission: the policy its session runs with. */
  private readonly contexts = new Map<string, Pick<CoreSessionTurnContext, 'policy' | 'mcpServers'> & { projectId: string | null; scope: string }>()

  constructor(private readonly deps: MissionCoreSessionsDeps) {}

  scopeOf(conversation: Pick<AgentConversation, 'pinned_project_id'>): string {
    return (conversation.pinned_project_id && this.deps.projectKey(conversation.pinned_project_id)) || GLOBAL_SCOPE
  }

  handle(conversationId: string): TurnHandle | undefined {
    return this.handles.get(conversationId)
  }

  /**
   * The Core turn context for this mission turn, or null when the turn must use
   * the legacy runners (sessions disabled, scope degraded, provider not served).
   */
  async prepareTurn(conversation: AgentConversation, adapter: ProviderAdapter, turn: { capability: string; external: ResolvedExternalServer[]; plugins?: AgentMcpServerSpec[] }): Promise<CoreSessionTurnContext | null> {
    const availability = await this.deps.availability()
    if (!availability.enabled) return null
    const scope = this.scopeOf(conversation)
    if (!this.deps.registry.available(scope)) return null
    let client
    try {
      client = await this.deps.registry.acquire(scope)
    } catch (error) {
      console.warn(`[agent-chat] Core sessions unavailable for ${scope}; using the legacy transport: ${(error as Error).message}`)
      return null
    }
    const drivers = client.initialize?.drivers ?? []
    if (!drivers.some((driver) => driver.id === adapter.id)) return null

    const conversationId = conversation.id
    if (!this.tracked.has(conversationId)) await this.track(scope, conversationId, this.deps.broadcast)

    // Rotate the capability the resident bridge presents; the previous one is revoked.
    const mcpServers = prepareAgentMcpSpec({ conversationId, port: this.deps.port, capability: turn.capability, external: turn.external })
    // App-installed plugin servers (same set a legacy spawn passes as argv); never shadow a configured name.
    for (const plugin of turn.plugins ?? []) if (!mcpServers.some((server) => server.name === plugin.name)) mcpServers.push(plugin)
    const previous = this.capabilities.get(conversationId)
    this.capabilities.set(conversationId, turn.capability)
    if (previous && previous !== turn.capability) this.deps.revokeCapability(previous)

    // Parity with legacy missions: the adapter declares its permission level; user-scope MCP servers stay inherited.
    const policy: SessionPolicyInput = { subagents: this.subagentPolicy(conversation), permissions: adapter.capabilities.sessionPermissions ?? 'workspace-write', mcp: { inheritUserScope: true } }
    this.contexts.set(conversationId, { policy, mcpServers, projectId: conversation.pinned_project_id ?? null, scope })
    return {
      sessionId: conversationId,
      client,
      driver: adapter.id,
      policy,
      mcpServers,
      legacyProviderSessionRef: conversation.session_id ?? null,
      metadata: { conversationId, surface: 'mission' },
      onHandle: (handle) => { if (handle) this.handles.set(conversationId, handle); else this.handles.delete(conversationId) },
    }
  }

  /**
   * The "Allow sub-agents" setting of a scope changed (`projectId: null` = missions
   * without a project): send the new policy to each open session of that scope.
   * Core applies it at the next idle point; with sub-agents running it reports
   * the change as deferred, which the mission shows with "Stop agents and apply now".
   */
  async refreshSubagentPolicy(scope: { projectId: string | null }): Promise<void> {
    for (const [conversationId, context] of [...this.contexts]) {
      if (context.projectId !== scope.projectId || !this.tracked.has(conversationId)) continue
      const conversation = getAgentConversation(this.deps.db, conversationId)
      if (!conversation) continue
      const subagents = this.subagentPolicy(conversation)
      if (subagents === context.policy.subagents) continue
      const next = { ...context, policy: { ...context.policy, subagents } }
      this.contexts.set(conversationId, next)
      try {
        const client = await this.deps.registry.acquire(context.scope)
        await client.request('session.update', { sessionId: conversationId, policy: sessionPolicyFor(next) })
      } catch (error) {
        // The next turn sends the policy again; nothing is lost.
        console.warn(`[agent-chat] could not update the sub-agent policy of ${conversationId}: ${(error as Error).message}`)
      }
    }
  }

  private subagentPolicy(conversation: AgentConversation): SessionPolicyInput['subagents'] {
    return this.deps.subagentPolicy?.(conversation) ?? 'enabled'
  }

  /** True when the capability of this turn must outlive the turn (resident session). */
  retains(conversationId: string, capability: string): boolean {
    return this.capabilities.get(conversationId) === capability
  }

  /** Core retired the provider process: nothing can present the capability anymore. */
  releaseCapability(conversationId: string): void {
    const capability = this.capabilities.get(conversationId)
    if (!capability) return
    this.capabilities.delete(conversationId)
    this.deps.revokeCapability(capability)
    removeAgentCapabilityFile(conversationId)
  }

  /** Stop sub-agents of a mission's Core session (all when `subagentIds` is omitted). */
  async stopSubagents(conversation: Pick<AgentConversation, 'id' | 'pinned_project_id'>, subagentIds?: string[]): Promise<string[]> {
    if (!this.tracked.has(conversation.id)) return []
    const client = await this.deps.registry.acquire(this.scopeOf(conversation))
    const result = await client.request<{ stopped: string[] }>('session.stopSubagents', { sessionId: conversation.id, ...(subagentIds ? { subagentIds } : {}) })
    return result.stopped ?? []
  }

  /**
   * Rebuild a mission's derived session rows (sub-agents, their output, resident
   * state, cursor) by replaying Core's journal from the start. Turns already
   * recorded as messages/invocations are recognized, not duplicated. The replay
   * is silent; clients then receive the rebuilt state in one pass.
   */
  async rebuildProjection(conversation: Pick<AgentConversation, 'id' | 'pinned_project_id'>): Promise<{ lastSeq: number; subagents: number } | null> {
    const scope = this.scopeOf(conversation)
    const conversationId = conversation.id
    if (!getSessionCursor(this.deps.db, conversationId)) return null
    this.deps.registry.untrack(scope, conversationId)
    this.tracked.delete(conversationId)
    resetSessionProjection(this.deps.db, conversationId)
    let muted = true
    try {
      await this.track(scope, conversationId, (message) => { if (!muted) this.deps.broadcast(message) })
    } finally {
      muted = false
    }
    const cursor = getSessionCursor(this.deps.db, conversationId)
    const subagents = listSubagents(this.deps.db, conversationId)
    const timestamp = new Date().toISOString()
    if (cursor) this.deps.broadcast({ type: 'agent_resident_state', conversationId, phase: cursor.residentPhase, liveSubagents: cursor.liveSubagents, processAlive: cursor.processAlive, timestamp })
    for (const { conversationId: _owner, ...subagent } of subagents) this.deps.broadcast({ type: 'agent_subagent', conversationId, subagent, timestamp })
    return { lastSeq: cursor?.lastSeq ?? 0, subagents: subagents.length }
  }

  private async track(scope: string, conversationId: string, broadcast: MissionCoreSessionsDeps['broadcast']): Promise<void> {
    ensureSessionCursor(this.deps.db, conversationId, conversationId, scope)
    const projector = new MissionSessionProjector(conversationId, {
      db: this.deps.db,
      broadcast,
      adapterFor: this.deps.adapterFor,
      onProcessEnded: (id) => this.releaseCapability(id),
    })
    try {
      await this.deps.registry.track(scope, conversationId, projector, () => {})
    } catch (error) {
      // A session that does not exist yet has nothing to replay; tracking starts empty.
      if ((error as { code?: string }).code !== 'session_not_found') throw error
    }
    this.tracked.add(conversationId)
  }

  /** Conversation deleted: close its Core session and drop all local state. */
  async close(conversation: Pick<AgentConversation, 'id' | 'pinned_project_id'>): Promise<void> {
    const scope = this.scopeOf(conversation)
    this.handles.delete(conversation.id)
    this.contexts.delete(conversation.id)
    this.releaseCapability(conversation.id)
    if (!this.tracked.delete(conversation.id)) return
    this.deps.registry.untrack(scope, conversation.id)
    try {
      const client = await this.deps.registry.acquire(scope)
      await client.request('session.close', { sessionId: conversation.id, reason: 'conversation_deleted' })
    } catch (error) {
      console.warn(`[agent-chat] could not close Core session ${conversation.id}: ${(error as Error).message}`)
    }
  }

  shutdown(): void {
    for (const conversationId of [...this.capabilities.keys()]) this.releaseCapability(conversationId)
    this.handles.clear()
    this.contexts.clear()
    this.tracked.clear()
  }
}
