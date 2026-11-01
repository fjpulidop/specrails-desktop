import type { SessionPolicyInput } from '../../agent-sessions'

/**
 * Intent mode as missions see it (arch section 4.5). An injected port: the
 * composition root binds it to the Intent module, so missions never import Intent
 * or delivery and learn nothing about worktrees beyond a cwd.
 */
export interface IntentTurn {
  flowId: string
  /** The Intent worktree: the Core session's cwd. */
  cwd: string
  /** Branch checked out in the worktree (shown to the agent on the user turn). */
  branch: string | null
  /** A Core session distinct from the mission's (`flow:<flowId>[:<generation>]`): cwd is fixed at open. */
  coreSessionId: string
  /** The static Intent persona (byte-stable). */
  systemPrompt: string
  /** Permission/tool fields of the Intent session policy. */
  policy: Required<Pick<SessionPolicyInput, 'permissions' | 'tools'>>
  /** Back to Intent: the review the agent must see on this turn (rides the user
   * turn, never the byte-stable system prompt). Absent once delivered. */
  briefing?: string
}

export interface IntentTurnContext {
  /** The ACTIVE Intent of a conversation, or null (paused, ended or none):
   * the turn then runs exactly like a normal read-only mission turn. */
  forConversation(conversationId: string): IntentTurn | null
  /** Whether the operator may OFFER Intent on this turn (Intent available for the
   * pinned project and no Intent open in this conversation). Optional; a missing
   * or failing check means "not offerable". Rides the user turn, never the
   * byte-stable system prompt. */
  offerable?(conversationId: string): Promise<boolean>
  /** A turn that carried `briefing` completed: the Intent clears it. Optional; never throws into a turn. */
  briefingDelivered?(conversationId: string, flowId: string): Promise<void>
  /** The Intent's Core session cannot serve this turn (closed, or another provider):
   * commit a new session id and return the turn for it (null: no active Intent). */
  renewSession?(conversationId: string, flowId: string): Promise<IntentTurn | null>
}

/**
 * The Intent session boundary, the same one rail write roles run with: no
 * interactive approvals (Claude `--dangerously-skip-permissions`, Codex
 * `danger-full-access`) so the agent can run the typecheck, tests and
 * installs a headless session cannot get approved, default tools. Containment
 * is the same as a rail's, not an OS sandbox: cwd = the Intent worktree, the
 * persona rule never to touch anything outside it, and the worktree's own
 * branch (docs/internals/flow-mode.md#permissions). Normal mission turns keep
 * their read-only boundary (missionSessionBoundary).
 */
export const FLOW_SESSION_BOUNDARY: IntentTurn['policy'] = Object.freeze({
  permissions: 'bypass',
  tools: Object.freeze({ mode: 'default' }),
}) as IntentTurn['policy']
