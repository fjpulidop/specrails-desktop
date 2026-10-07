import type { DbInstance } from '../../../db'
import { prepareAgentMcpSpec, removeAgentCapabilityFile, type AgentMcpServerSpec } from '../../../agent-mcp-config'
import type { ResolvedExternalServer } from '../../../external-mcp'
import type { ProviderAdapter } from '../../../providers/types'
import { resolveSubagentRuntime, type CoreSessionsAvailability, type DriverDescriptor, type SessionPolicyInput, type SubagentRuntimeChoice } from '../../agent-sessions'
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
  /** Sub-agent policy for a conversation (project / app "Allow sub-agents"). */
  subagentPolicy?: (conversation: AgentConversation) => SessionPolicyInput['subagents']
  /** "Run sub-agents with" for a conversation; null = the mission agent's own provider. */
  subagentRuntime?: (conversation: AgentConversation) => SubagentRuntimeChoice | null
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
  private readonly contexts = new Map<string, Pick<CoreSessionTurnContext, 'policy' | 'mcpServers'> & { projectId: string | null; scope: string; provider: string; drivers: DriverDescriptor[]; delegation: boolean }>()

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
    if (!this.deps.registry.available(scope)) {
      this.noticeFallback(conversation.id, scope)
      return null
    }
    let client
    try {
      client = await this.deps.registry.acquire(scope)
    } catch (error) {
      console.warn(`[agent-chat] Core sessions unavailable for ${scope}; using the legacy transport: ${(error as Error).message}`)
      this.noticeFallback(conversation.id, scope)
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
    const delegation = client.initialize?.capabilities?.delegation === 1
    const policy: SessionPolicyInput = {
      subagents: this.subagentPolicy(conversation),
      permissions: adapter.capabilities.sessionPermissions ?? 'workspace-write',
      mcp: { inheritUserScope: true },
      subagentRuntime: this.subagentRuntime(conversation, adapter.id, drivers, delegation),
    }
    this.contexts.set(conversationId, { policy, mcpServers, projectId: conversation.pinned_project_id ?? null, scope, provider: adapter.id, drivers, delegation })
    return {
      sessionId: conversationId,
      client,
      driver: adapter.id,
      policy,
      mcpServers,
      ...(policy.subagentRuntime?.mode === 'delegated' ? { systemPromptAddendum: delegationGuidance(policy.subagentRuntime) } : {}),
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
      const subagentRuntime = this.subagentRuntime(conversation, context.provider, context.drivers, context.delegation)
      if (subagents === context.policy.subagents && JSON.stringify(subagentRuntime) === JSON.stringify(context.policy.subagentRuntime)) continue
      const next = { ...context, policy: { ...context.policy, subagents, subagentRuntime } }
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

  /** The turn runs on the legacy transport because its scope is degraded: say why, once per turn. */
  private noticeFallback(conversationId: string, scope: string): void {
    if (this.deps.registry.status(scope) !== 'degraded') return
    const code = this.deps.registry.degradedCode(scope) === 'journal_locked' ? 'journal_locked' : 'host_degraded'
    const detail = this.deps.registry.hosts().find((host) => host.scope === scope)?.detail ?? null
    this.deps.broadcast({ type: 'agent_session_notice', conversationId, level: 'warning', code, scope, message: detail ?? code, timestamp: new Date().toISOString() })
  }

  /** The hybrid runtime for this mission; says so in the mission when a choice cannot be honoured. */
  private subagentRuntime(conversation: AgentConversation, provider: string, drivers: DriverDescriptor[], delegation: boolean): NonNullable<SessionPolicyInput['subagentRuntime']> {
    const choice = this.deps.subagentRuntime?.(conversation) ?? null
    const resolution = resolveSubagentRuntime({ choice, missionProvider: provider, drivers, delegation })
    if (resolution.unavailable && choice && this.subagentPolicy(conversation) === 'enabled') {
      this.deps.broadcast({ type: 'agent_session_notice', conversationId: conversation.id, level: 'warning', code: resolution.unavailable, message: `${choice.provider} sub-agents are not available here; the mission agent runs its own.`, timestamp: new Date().toISOString() })
    }
    return resolution.runtime
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

  /** True when this mission's sub-agents are launched by Core (another provider). */
  delegates(conversationId: string): boolean {
    return this.contexts.get(conversationId)?.policy.subagentRuntime?.mode === 'delegated'
  }

  /** Launch a sub-agent on the configured provider (delegated runtime only). */
  async delegate(conversation: Pick<AgentConversation, 'id' | 'pinned_project_id'>, params: { description: string; prompt: string; agentType?: string; contextTurns?: number }): Promise<{ subagentId: string }> {
    this.assertDelegates(conversation.id)
    const client = await this.deps.registry.acquire(this.scopeOf(conversation))
    return client.request<{ subagentId: string }>('session.delegate', { sessionId: conversation.id, ...params })
  }

  /** Results of delegated sub-agents that finished (or what still runs at the timeout). */
  async waitSubagents(conversation: Pick<AgentConversation, 'id' | 'pinned_project_id'>, subagentIds: string[] | undefined, timeoutMs: number): Promise<{ results: Array<{ subagentId: string; description: string; status: string; result: string }>; running: string[] }> {
    this.assertDelegates(conversation.id)
    const client = await this.deps.registry.acquire(this.scopeOf(conversation))
    return client.request('session.waitSubagents', { sessionId: conversation.id, ...(subagentIds ? { subagentIds } : {}), timeoutMs })
  }

  private assertDelegates(conversationId: string): void {
    if (!this.tracked.has(conversationId) || !this.delegates(conversationId)) {
      throw new Error('This mission does not delegate sub-agents: its agent launches them with its own tool, or sub-agents are off.')
    }
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

/** What the mission agent needs to know when Core launches its sub-agents. */
function delegationGuidance(runtime: { driver: string; model: string }): string {
  return [
    '## Sub-agents',
    `In this mission, sub-agents run on ${runtime.driver} (${runtime.model}) and are launched by Specrails, not by your own sub-agent tool (it is unavailable).`,
    'To delegate a self-contained task, call `specrails_mission` with `action: "subagent_start"`, a short `description` and complete `instructions`; set `contextTurns` when it needs this conversation.',
    'Start several to work in parallel. Collect results with `subagent_wait`; results you do not wait for arrive later as a message. Use `subagent_list` to see them and `subagent_stop` to stop them.',
  ].join('\n')
}

