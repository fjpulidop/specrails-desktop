/**
 * Intent mode wiring for one project.
 *
 * Owns binding the Intent use cases to THIS project's connection and the
 * Intent → rail hand-off authority. The mission host is app-global and
 * late-bound (agent chat starts after the registry), as is the machine's
 * provider billing lookup.
 */
import type { DbInstance } from './db'
import type { InternalApi } from './internal-api'
import { createFlowService, type IntentService } from './modules/intent'
import { createFlowHandOffAuthority, createFlowPorts, flowAcceptedScope, flowConversationSummary, systemClock } from './modules/intent/adapters/bindings'
import { createSqliteFlowEffectsStore, createSqliteFlowRepository } from './modules/intent/adapters/sqlite'
import { flowAvailability } from './modules/agent-sessions/runtime/core-sessions-availability'
import type { IntentHandOffAuthority } from './modules/delivery/runtime/flow-worktree-handoff'
import { getAgentChatManager } from './modules/missions/runtime/agent-chat-registry'
import { normalizeSpecIntent, renderIntentForAgents } from './modules/specs/domain/intent'
import type { ProjectBroadcastTaps } from './project-context-broadcast'
import type { ProjectTicketAccess } from './project-context-tickets'
import type { ProjectContext } from './project-registry'
import { stopBackgroundProcessesForFlow } from './transient-children'

export type ProviderBillingLookup = (provider: string) => Promise<{ billing: 'plan' | 'api' | 'unknown'; plan: string | null }>

/** Creates the Intent service and hand-off authority and attaches both to `ctx`. */
export function createProjectIntent(deps: {
  ctx: ProjectContext
  db: DbInstance
  desktopDb: DbInstance
  internalApi: InternalApi
  /** Machine-scope billing lookup; read per call (bound after the registry). */
  providerBilling: () => ProviderBillingLookup | null
  readFlowTicket: ProjectTicketAccess['readFlowTicket']
  taps: ProjectBroadcastTaps
}): { flow: IntentService; flowHandOff: IntentHandOffAuthority } {
  const { ctx, db, internalApi, readFlowTicket } = deps
  const project = ctx.project
  const flowRepository = createSqliteFlowRepository(db)
  const flowPorts = createFlowPorts({
    ctx, repository: flowRepository, effects: createSqliteFlowEffectsStore(db), internalApi, availability: () => flowAvailability(),
    agentHost: () => getAgentChatManager(),
    providerBilling: async (provider) => (await deps.providerBilling()?.(provider)) ?? { billing: 'unknown', plan: null },
    // Dev servers the Intent agent started in the worktree stop with the Intent.
    processes: {
      async stop({ flowId }) {
        const { unresolved } = await stopBackgroundProcessesForFlow(flowId, project.id)
        if (unresolved.length) console.warn(`[flow] ${unresolved.length} background process(es) of Intent ${flowId} did not confirm exit`)
      },
    },
  })
  // Order: the service is visible on the context (and to the broadcast tap)
  // before the hand-off authority is created, as in the original wiring.
  const flow = createFlowService(flowPorts)
  ctx.flow = flow
  deps.taps.flowService = flow
  const flowHandOff = createFlowHandOffAuthority(flowRepository, systemClock, (session) => flowPorts.notifier.changed(session),
    // Intent -> Spec: the bounded conversation summary Core's derive-change reads,
    // and the accepted scope (the person's requests and decisions) every step receives.
    (session) => {
      const ticket = session.ticketId !== null ? readFlowTicket(session.ticketId) : undefined
      const intent = normalizeSpecIntent(ticket?.intent)
      const window = { conversationId: session.conversationId, from: session.createdAt, to: null }
      return {
        summary: flowConversationSummary(deps.desktopDb, { ...window, idea: ticket?.description ?? null, intent: renderIntentForAgents(intent) }),
        acceptedScope: flowAcceptedScope(deps.desktopDb, { ...window, constraints: intent?.constraints ?? [] }),
      }
    })
  ctx.flowHandOff = flowHandOff
  return { flow, flowHandOff }
}
