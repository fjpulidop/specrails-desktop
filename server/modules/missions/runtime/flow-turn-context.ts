import type { SessionPolicyInput } from '../../agent-sessions'

/**
 * Flow mode as missions see it (arch section 4.5). An injected port: the
 * composition root binds it to the Flow module, so missions never import Flow
 * or delivery and learn nothing about worktrees beyond a cwd.
 */
export interface FlowTurn {
  flowId: string
  /** The Flow worktree: the Core session's cwd. */
  cwd: string
  /** Branch checked out in the worktree (shown to the agent on the user turn). */
  branch: string | null
  /** A Core session distinct from the mission's (`flow:<flowId>`): cwd is fixed at open. */
  coreSessionId: string
  /** The static Flow persona (byte-stable). */
  systemPrompt: string
  /** Permission/tool fields of the Flow session policy. */
  policy: Required<Pick<SessionPolicyInput, 'permissions' | 'tools'>>
}

export interface FlowTurnContext {
  /** The ACTIVE Flow of a conversation, or null (paused, ended or none):
   * the turn then runs exactly like a normal read-only mission turn. */
  forConversation(conversationId: string): FlowTurn | null
  /** Whether the operator may OFFER Flow on this turn (Flow available for the
   * pinned project and no Flow open in this conversation). Optional; a missing
   * or failing check means "not offerable". Rides the user turn, never the
   * byte-stable system prompt. */
  offerable?(conversationId: string): Promise<boolean>
}

/** The Flow session boundary: writes in the worktree, default tools. */
export const FLOW_SESSION_BOUNDARY: FlowTurn['policy'] = Object.freeze({
  permissions: 'workspace-write',
  tools: Object.freeze({ mode: 'default' }),
}) as FlowTurn['policy']
