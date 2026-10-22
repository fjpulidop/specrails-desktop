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
  /** A Core session distinct from the mission's (`flow:<flowId>[:<generation>]`): cwd is fixed at open. */
  coreSessionId: string
  /** The static Flow persona (byte-stable). */
  systemPrompt: string
  /** Permission/tool fields of the Flow session policy. */
  policy: Required<Pick<SessionPolicyInput, 'permissions' | 'tools'>>
  /** Back to Flow: the review the agent must see on this turn (rides the user
   * turn, never the byte-stable system prompt). Absent once delivered. */
  briefing?: string
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
  /** A turn that carried `briefing` completed: the Flow clears it. Optional; never throws into a turn. */
  briefingDelivered?(conversationId: string, flowId: string): Promise<void>
  /** The Flow's Core session cannot serve this turn (closed, or another provider):
   * commit a new session id and return the turn for it (null: no active Flow). */
  renewSession?(conversationId: string, flowId: string): Promise<FlowTurn | null>
}

/**
 * The Flow session boundary, the same one rail write roles run with: no
 * interactive approvals (Claude `--dangerously-skip-permissions`, Codex
 * `danger-full-access`) so the agent can run the typecheck, tests and
 * installs a headless session cannot get approved, default tools. Containment
 * is the same as a rail's, not an OS sandbox: cwd = the Flow worktree, the
 * persona rule never to touch anything outside it, and the worktree's own
 * branch (docs/internals/flow-mode.md#permissions). Normal mission turns keep
 * their read-only boundary (missionSessionBoundary).
 */
export const FLOW_SESSION_BOUNDARY: FlowTurn['policy'] = Object.freeze({
  permissions: 'bypass',
  tools: Object.freeze({ mode: 'default' }),
}) as FlowTurn['policy']
