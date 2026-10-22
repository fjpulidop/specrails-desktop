import type { DbInstance } from '../../../db'
import { prepareAgentMcpSpec, removeAgentCapabilityFile, type AgentMcpServerSpec } from '../../../agent-mcp-config'
import type { ResolvedExternalServer } from '../../../external-mcp'
import type { ProviderAdapter } from '../../../providers/types'
import { hostSupportsFlowSessions, resolveSubagentRuntime, type CoreSessionsAvailability, type DriverDescriptor, type SessionPolicyInput, type SubagentRuntimeChoice } from '../../agent-sessions'
import type { SessionHostRegistry } from '../../agent-sessions/runtime/session-host-registry'
import type { AgentAuditRecorder } from '../../audit'
import { getAgentConversation, type AgentConversation } from '../../agents/runtime/agent-store'
import { conversationSessionState, ensureSessionCursor, getSessionCursor, listSessionCursors, listSubagents, resetSessionProjection } from './agent-session-store'
import { FLOW_SUBAGENTS_ADDENDUM } from './agent-flow-prompt'
import { sessionPolicyFor, type CoreSessionTurnContext, type TurnHandle } from './core-session-runner'
import { MissionSessionProjector } from './mission-session-projector'
import { missionSessionBoundary } from './mission-tool-policy'
import type { FlowTurn } from './flow-turn-context'

/** Why a Flow turn cannot run on Core sessions (there is no legacy Flow path). */
export class FlowSessionUnavailableError extends Error {
  readonly code = 'flow_sessions_unavailable'
  constructor(message: string) {
    super(message)
    this.name = 'FlowSessionUnavailableError'
  }
}

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
  /** Agent actions audit sink of a project (tool calls of its missions). */
  agentAudit?: (projectId: string) => Pick<AgentAuditRecorder, 'record'> | null
}

export const GLOBAL_SCOPE = 'global'

type SessionContext = Pick<CoreSessionTurnContext, 'policy' | 'mcpServers'> & { conversationId: string; projectId: string | null; scope: string; provider: string; drivers: DriverDescriptor[]; delegation: boolean; flow: boolean }

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
  /** Missions with a turn being prepared or running: their capability belongs to that turn. */
  private readonly activeTurns = new Set<string>()
  /** Core sessions with a projector: the mission's (its conversation id) and Flow sessions (`flow:<flowId>`). */
  private readonly tracked = new Set<string>()
  /** Last turn context per Core session: the policy it runs with. */
  private readonly contexts = new Map<string, SessionContext>()
  /** The Core session the conversation's latest turn ran in (sub-agent tools act on it). */
  private readonly current = new Map<string, string>()

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
  async prepareTurn(conversation: AgentConversation, adapter: ProviderAdapter, turn: { capability: string; external: ResolvedExternalServer[]; plugins?: AgentMcpServerSpec[]; flow?: FlowTurn | null }): Promise<CoreSessionTurnContext | null> {
    if (turn.flow) return this.prepareFlowTurn(conversation, adapter, { ...turn, flow: turn.flow })
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
    if (!this.tracked.has(conversationId)) await this.track(scope, conversationId, conversationId, this.deps.broadcast)
    this.current.set(conversationId, conversationId)

    // Rotate the capability the resident bridge presents; the previous one is revoked.
    const mcpServers = prepareAgentMcpSpec({ conversationId, port: this.deps.port, capability: turn.capability, external: turn.external })
    // App-installed plugin servers (same set a legacy spawn passes as argv); never shadow a configured name.
    for (const plugin of turn.plugins ?? []) if (!mcpServers.some((server) => server.name === plugin.name)) mcpServers.push(plugin)
    const previous = this.capabilities.get(conversationId)
    this.capabilities.set(conversationId, turn.capability)
    this.activeTurns.add(conversationId)
    if (previous && previous !== turn.capability) this.deps.revokeCapability(previous)

    // Missions are read-only (mission-read-only-policy): the adapter declares how its
    // Core driver enforces that while MCP tools stay callable. User-scope MCP stays inherited.
    const delegation = client.initialize?.capabilities?.delegation === 1
    const policy: SessionPolicyInput = {
      subagents: this.subagentPolicy(conversation),
      ...missionSessionBoundary(adapter, drivers.find((driver) => driver.id === adapter.id)),
      mcp: { inheritUserScope: true },
      subagentRuntime: this.subagentRuntime(conversation, adapter.id, drivers, delegation),
    }
    this.contexts.set(conversationId, { conversationId, policy, mcpServers, projectId: conversation.pinned_project_id ?? null, scope, provider: adapter.id, drivers, delegation, flow: false })
    return {
      sessionId: conversationId,
      client,
      driver: adapter.id,
      policy,
      mcpServers,
      ...(policy.subagentRuntime?.mode === 'delegated' ? { systemPromptAddendum: delegationGuidance(policy.subagentRuntime) } : {}),
      legacyProviderSessionRef: conversation.session_id ?? null,
      metadata: { conversationId, surface: 'mission' },
      onHandle: (handle) => {
        if (handle) { this.handles.set(conversationId, handle); return }
        this.handles.delete(conversationId)
        this.activeTurns.delete(conversationId)
      },
    }
  }

  /**
   * Can this conversation's provider run a Flow session in its scope right now?
   * Resolves the host client; throws `FlowSessionUnavailableError` otherwise.
   */
  async assertFlowSupport(conversation: Pick<AgentConversation, 'id' | 'pinned_project_id'>, providerId: string) {
    const availability = await this.deps.availability()
    if (!availability.enabled) throw new FlowSessionUnavailableError(`Flow needs Core agent sessions: ${availability.reason}`)
    const scope = this.scopeOf(conversation)
    if (!this.deps.registry.available(scope)) throw new FlowSessionUnavailableError(`Core sessions are unavailable for ${scope} (${this.deps.registry.status(scope)})`)
    let client
    try {
      client = await this.deps.registry.acquire(scope)
    } catch (error) {
      throw new FlowSessionUnavailableError(`Core sessions are unavailable for ${scope}: ${(error as Error).message}`)
    }
    if (!hostSupportsFlowSessions(client.initialize)) throw new FlowSessionUnavailableError('The Core session host does not support Flow sessions (flowSessions); update Core')
    if (!(client.initialize?.drivers ?? []).some((driver) => driver.id === providerId)) {
      throw new FlowSessionUnavailableError(`Core has no session driver for ${providerId}; Flow cannot run with this provider`)
    }
    return { scope, client }
  }

  /**
   * A Flow turn: its own Core session (`flow:<flowId>`) with the worktree as
   * cwd, the rail write-role permissions (FLOW_SESSION_BOUNDARY), default tools and the same Specrails MCP
   * the mission presents. Sub-agents follow the mission's project policy
   * ("Allow sub-agents", "Run sub-agents with"); they inherit the session's cwd
   * and permissions (Core gives delegated children the parent's cwd). The Flow
   * session has its own projection (cursor, sub-agents, usage billed `flow`).
   */
  private async prepareFlowTurn(conversation: AgentConversation, adapter: ProviderAdapter, turn: { capability: string; external: ResolvedExternalServer[]; plugins?: AgentMcpServerSpec[]; flow: FlowTurn }): Promise<CoreSessionTurnContext> {
    const { scope, client } = await this.assertFlowSupport(conversation, adapter.id)
    const conversationId = conversation.id
    const sessionId = turn.flow.coreSessionId
    if (!this.tracked.has(sessionId)) await this.track(scope, conversationId, sessionId, this.deps.broadcast)
    this.current.set(conversationId, sessionId)
    const mcpServers = prepareAgentMcpSpec({ conversationId, port: this.deps.port, capability: turn.capability, external: turn.external })
    for (const plugin of turn.plugins ?? []) if (!mcpServers.some((server) => server.name === plugin.name)) mcpServers.push(plugin)
    const previous = this.capabilities.get(conversationId)
    this.capabilities.set(conversationId, turn.capability)
    this.activeTurns.add(conversationId)
    if (previous && previous !== turn.capability) this.deps.revokeCapability(previous)
    const drivers = client.initialize?.drivers ?? []
    const delegation = client.initialize?.capabilities?.delegation === 1
    const subagents = this.subagentPolicy(conversation)
    const policy: SessionPolicyInput = {
      subagents,
      ...turn.flow.policy,
      mcp: { inheritUserScope: true },
      ...(subagents === 'enabled' ? { subagentRuntime: this.subagentRuntime(conversation, adapter.id, drivers, delegation) } : {}),
    }
    this.contexts.set(sessionId, { conversationId, policy, mcpServers, projectId: conversation.pinned_project_id ?? null, scope, provider: adapter.id, drivers, delegation, flow: true })
    const addendum = subagents !== 'enabled'
      ? null
      : policy.subagentRuntime?.mode === 'delegated'
        ? `${FLOW_SUBAGENTS_ADDENDUM}\n\n${delegationGuidance(policy.subagentRuntime)}`
        : FLOW_SUBAGENTS_ADDENDUM
    return {
      sessionId,
      client,
      driver: adapter.id,
      policy,
      mcpServers,
      ...(addendum ? { systemPromptAddendum: addendum } : {}),
      inputDelivery: 'interrupt',
      metadata: { conversationId, surface: 'flow', flowId: turn.flow.flowId },
      onHandle: (handle) => {
        if (handle) { this.handles.set(conversationId, handle); return }
        this.handles.delete(conversationId)
        this.activeTurns.delete(conversationId)
      },
    }
  }

  /** Close a Flow's Core session (pause, discard, hand-off). Core keeps its
   * journal; a later turn resumes it. Never throws. */
  async closeFlowSession(conversation: Pick<AgentConversation, 'id' | 'pinned_project_id'>, coreSessionId: string, reason: string): Promise<void> {
    // Later sub-agent tools act on the mission again; the projection keeps
    // following the Flow session (background sub-agents may still settle).
    if (this.current.get(conversation.id) === coreSessionId) this.current.delete(conversation.id)
    try {
      const client = await this.deps.registry.acquire(this.scopeOf(conversation))
      await client.request('session.close', { sessionId: coreSessionId, reason })
    } catch (error) {
      if ((error as { code?: string }).code === 'session_not_found' || (error as { code?: string }).code === 'session_closed') return
      console.warn(`[agent-chat] could not close Flow session ${coreSessionId}: ${(error as Error).message}`)
    }
  }

  /**
   * The "Allow sub-agents" setting of a scope changed (`projectId: null` = missions
   * without a project): send the new policy to each open session of that scope.
   * Core applies it at the next idle point; with sub-agents running it reports
   * the change as deferred, which the mission shows with "Stop agents and apply now".
   */
  async refreshSubagentPolicy(scope: { projectId: string | null }): Promise<void> {
    for (const [sessionId, context] of [...this.contexts]) {
      if (context.projectId !== scope.projectId || !this.tracked.has(sessionId)) continue
      const conversation = getAgentConversation(this.deps.db, context.conversationId)
      if (!conversation) continue
      const subagents = this.subagentPolicy(conversation)
      const subagentRuntime = context.flow && subagents !== 'enabled'
        ? undefined
        : this.subagentRuntime(conversation, context.provider, context.drivers, context.delegation)
      if (subagents === context.policy.subagents && JSON.stringify(subagentRuntime) === JSON.stringify(context.policy.subagentRuntime)) continue
      const { subagentRuntime: _previous, ...rest } = context.policy
      const next = { ...context, policy: { ...rest, subagents, ...(subagentRuntime ? { subagentRuntime } : {}) } }
      this.contexts.set(sessionId, next)
      try {
        const client = await this.deps.registry.acquire(context.scope)
        await client.request('session.update', { sessionId, policy: sessionPolicyFor(next) })
      } catch (error) {
        // The next turn sends the policy again; nothing is lost.
        console.warn(`[agent-chat] could not update the sub-agent policy of ${sessionId}: ${(error as Error).message}`)
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
      this.deps.broadcast({ type: 'agent_session_notice', conversationId: conversation.id, level: 'warning', code: `subagents.${resolution.unavailable}`, provider: choice.provider, message: `${choice.provider} sub-agents are not available here; the mission agent runs its own.`, timestamp: new Date().toISOString() })
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

  /**
   * Core retired the provider process: nothing can present the capability anymore.
   * While a turn is prepared or running the capability is that turn's: a process
   * retired by its own config change (model, effort, policy) is replaced at once
   * and the new process presents the same capability, so it must stay valid.
   */
  releaseCapability(conversationId: string, options: { force?: boolean } = {}): void {
    if (!options.force && this.activeTurns.has(conversationId)) return
    const capability = this.capabilities.get(conversationId)
    if (!capability) return
    this.capabilities.delete(conversationId)
    this.deps.revokeCapability(capability)
    removeAgentCapabilityFile(conversationId)
  }

  /** The Core session the conversation's sub-agent tools act on: its Flow's while a Flow turn ran last. */
  private sessionOf(conversationId: string): string {
    return this.current.get(conversationId) ?? conversationId
  }

  /** True when this mission's sub-agents (or its Flow's, while in Flow) are launched by Core (another provider). */
  delegates(conversationId: string): boolean {
    return this.contexts.get(this.sessionOf(conversationId))?.policy.subagentRuntime?.mode === 'delegated'
  }

  /** Launch a sub-agent on the configured provider (delegated runtime only), in the current session. */
  async delegate(conversation: Pick<AgentConversation, 'id' | 'pinned_project_id'>, params: { description: string; prompt: string; agentType?: string; contextTurns?: number }): Promise<{ subagentId: string }> {
    const sessionId = this.assertDelegates(conversation.id)
    const client = await this.deps.registry.acquire(this.scopeOf(conversation))
    return client.request<{ subagentId: string }>('session.delegate', { sessionId, ...params })
  }

  /** Results of delegated sub-agents that finished (or what still runs at the timeout). */
  async waitSubagents(conversation: Pick<AgentConversation, 'id' | 'pinned_project_id'>, subagentIds: string[] | undefined, timeoutMs: number): Promise<{ results: Array<{ subagentId: string; description: string; status: string; result: string }>; running: string[] }> {
    const sessionId = this.assertDelegates(conversation.id)
    const client = await this.deps.registry.acquire(this.scopeOf(conversation))
    return client.request('session.waitSubagents', { sessionId, ...(subagentIds ? { subagentIds } : {}), timeoutMs })
  }

  private assertDelegates(conversationId: string): string {
    const sessionId = this.sessionOf(conversationId)
    if (!this.tracked.has(sessionId) || !this.delegates(conversationId)) {
      throw new Error('This mission does not delegate sub-agents: its agent launches them with its own tool, or sub-agents are off.')
    }
    return sessionId
  }

  /** Stop sub-agents of a mission's Core sessions (its own and its Flow's; all when `subagentIds` is omitted). */
  async stopSubagents(conversation: Pick<AgentConversation, 'id' | 'pinned_project_id'>, subagentIds?: string[]): Promise<string[]> {
    const sessions = this.sessionsOf(conversation.id)
    if (sessions.length === 0) return []
    // Route each id to the session that launched it.
    const owner = new Map(listSubagents(this.deps.db, conversation.id).map((row) => [row.subagentId, row.coreSessionId]))
    const client = await this.deps.registry.acquire(this.scopeOf(conversation))
    const stopped: string[] = []
    for (const sessionId of sessions) {
      const ids = subagentIds?.filter((id) => (owner.get(id) ?? conversation.id) === sessionId)
      if (ids && ids.length === 0) continue
      const result = await client.request<{ stopped: string[] }>('session.stopSubagents', { sessionId, ...(ids ? { subagentIds: ids } : {}) })
      stopped.push(...(result.stopped ?? []))
    }
    return stopped
  }

  /** Tracked Core sessions of a conversation (its own first). */
  private sessionsOf(conversationId: string): string[] {
    const flows = [...this.contexts].filter(([sessionId, context]) => context.conversationId === conversationId && sessionId !== conversationId).map(([sessionId]) => sessionId)
    return [conversationId, ...flows].filter((sessionId) => this.tracked.has(sessionId))
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
    // Every Core session of the mission (its own and its Flows'), each from its own journal.
    const cursors = listSessionCursors(this.deps.db, conversationId)
    if (cursors.length === 0) return null
    let lastSeq = 0
    for (const { coreSessionId } of cursors) {
      this.deps.registry.untrack(scope, coreSessionId)
      this.tracked.delete(coreSessionId)
      resetSessionProjection(this.deps.db, conversationId, coreSessionId)
      let muted = true
      try {
        await this.track(scope, conversationId, coreSessionId, (message) => { if (!muted) this.deps.broadcast(message) })
      } finally {
        muted = false
      }
      if (coreSessionId === conversationId) lastSeq = getSessionCursor(this.deps.db, conversationId)?.lastSeq ?? 0
    }
    const state = conversationSessionState(this.deps.db, conversationId)
    const subagents = listSubagents(this.deps.db, conversationId)
    const timestamp = new Date().toISOString()
    if (state) this.deps.broadcast({ type: 'agent_resident_state', conversationId, phase: state.residentPhase, liveSubagents: state.liveSubagents, processAlive: state.processAlive, timestamp })
    for (const { conversationId: _owner, ...subagent } of subagents) this.deps.broadcast({ type: 'agent_subagent', conversationId, subagent, timestamp })
    return { lastSeq, subagents: subagents.length }
  }

  /** Project one Core session of a conversation; any session other than its own is a Flow's (billed `flow`). */
  private async track(scope: string, conversationId: string, sessionId: string, broadcast: MissionCoreSessionsDeps['broadcast']): Promise<void> {
    ensureSessionCursor(this.deps.db, conversationId, sessionId, scope)
    const projector = new MissionSessionProjector(conversationId, {
      db: this.deps.db,
      broadcast,
      adapterFor: this.deps.adapterFor,
      onProcessEnded: (id) => this.releaseCapability(id),
      ...(this.deps.agentAudit ? { agentAudit: this.deps.agentAudit } : {}),
    }, sessionId === conversationId ? {} : { coreSessionId: sessionId, surface: 'flow' })
    try {
      await this.deps.registry.track(scope, sessionId, projector, () => {})
    } catch (error) {
      // A session that does not exist yet has nothing to replay; tracking starts empty.
      if ((error as { code?: string }).code !== 'session_not_found') throw error
    }
    this.tracked.add(sessionId)
  }

  /** Conversation deleted: close its Core session and drop all local state. */
  async close(conversation: Pick<AgentConversation, 'id' | 'pinned_project_id'>): Promise<void> {
    const scope = this.scopeOf(conversation)
    this.handles.delete(conversation.id)
    this.activeTurns.delete(conversation.id)
    this.current.delete(conversation.id)
    // Flow sessions: stop projecting them (the Flow module closes them in Core).
    for (const [sessionId, context] of [...this.contexts]) {
      if (context.conversationId !== conversation.id || sessionId === conversation.id) continue
      this.contexts.delete(sessionId)
      if (this.tracked.delete(sessionId)) this.deps.registry.untrack(scope, sessionId)
    }
    this.contexts.delete(conversation.id)
    this.releaseCapability(conversation.id, { force: true })
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
    for (const conversationId of [...this.capabilities.keys()]) this.releaseCapability(conversationId, { force: true })
    this.handles.clear()
    this.activeTurns.clear()
    this.contexts.clear()
    this.current.clear()
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

