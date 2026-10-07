/**
 * Conversational surfaces whose agents run in Core sessions. Implement
 * pipelines are not a surface here: they never resolve a sub-agent policy, so
 * the "Allow sub-agents" setting cannot affect them.
 */
export type ConversationalSurface = 'mission' | 'explore' | 'refinement'

export type SubagentPolicy = 'enabled' | 'disabled'

export interface SubagentPolicyInput {
  surface: ConversationalSurface
  /** The project's "Allow sub-agents" setting; `null` when the conversation has no project. */
  projectAllows: boolean | null
  /** The app-global setting for conversations without a project. */
  globalAllows: boolean
}

/** The project setting decides; conversations without a project use the global one. */
export function resolveSubagentPolicy(input: SubagentPolicyInput): SubagentPolicy {
  const allowed = input.projectAllows ?? input.globalAllows
  return allowed ? 'enabled' : 'disabled'
}
