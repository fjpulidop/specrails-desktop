import type { DbInstance } from '../../../db'
import { createAgentConversation } from '../../agents/runtime/agent-store'
import type { AgentTierLevel } from '../../missions/runtime/agent-tier'

export interface MissionPlaceholderInput {
  projectId: string
  provider: string
  model: string | null
  tierLevel: AgentTierLevel
  reasoningEffort: string | null
}

export interface MissionPlaceholderResult {
  status: 'created' | 'skipped'
  conversationId: string | null
}

/** Opens one empty mission conversation pinned to a freshly committed project.
 *  Any existing row for the project (deleted or archived included) means the
 *  project already has mission history, so a deleted placeholder is never
 *  resurrected. `listAgentConversations` hides those rows, hence the raw query. */
export function ensureMissionPlaceholderConversation(
  db: DbInstance,
  input: MissionPlaceholderInput,
): MissionPlaceholderResult {
  const existing = db
    .prepare('SELECT 1 FROM agent_conversations WHERE pinned_project_id = ? LIMIT 1')
    .get(input.projectId)
  if (existing) return { status: 'skipped', conversationId: null }

  const conversation = createAgentConversation(db, {
    provider: input.provider,
    model: input.model,
    pinnedProjectId: input.projectId,
    tierLevel: input.tierLevel,
    reasoningEffort: input.reasoningEffort,
  })
  return { status: 'created', conversationId: conversation.id }
}
