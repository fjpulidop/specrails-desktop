import type { FlowSession, FlowTicketState } from './domain'

/**
 * Outbound contracts owned by the Flow use cases. Production implementations
 * live in `adapters/` and are bound to ONE project at composition time; the
 * application never sees a project registry, SQL connection, Git or Core.
 */

/** Persistence of `flow_sessions` (project database). */
export interface FlowRepository {
  /** Insert a new Flow. Throws `FlowConflictError` when the conversation
   * already has an active or paused Flow (unique index) or the id exists. */
  insert(session: FlowSession): void
  /** Replace the stored row (same id). */
  save(session: FlowSession): void
  get(flowId: string): FlowSession | null
  /** The conversation's active or paused Flow, if any. */
  findOpenByConversation(conversationId: string): FlowSession | null
  /** Most recent Flow of a conversation in any state. */
  latestByConversation(conversationId: string): FlowSession | null
  /** Flows reconciliation must inspect (not terminal and not handed off). */
  listUnsettled(): FlowSession[]
}

/** The placeholder spec ("In Flow"). Created through the non-promoting path. */
export interface FlowTickets {
  createPlaceholder(input: { flowId: string; conversationId: string; title: string; description: string; startedAt: string }): number
  setFlowState(ticketId: number, state: FlowTicketState): void
  /** Idempotent: a missing ticket is not an error. */
  deletePlaceholder(ticketId: number): void
}

export interface ReservedWorktree {
  branch: string
  worktreePath: string
  baseSha: string | null
  headSha: string | null
}

export interface FlowDiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  /** Null for binary files or untracked files whose size is not counted. */
  additions: number | null
  deletions: number | null
}

export interface FlowDiffSummary {
  branch: string | null
  baseSha: string | null
  headSha: string | null
  files: FlowDiffFile[]
  totals: { files: number; additions: number; deletions: number }
}

/** The single worktree machinery (delivery) seen from Flow. */
export interface WorktreeReservation {
  /** Fresh worktree + branch for the placeholder ticket, owned by this Flow. */
  reserve(input: { flowId: string; conversationId: string; ticketId: number }): Promise<ReservedWorktree>
  /** Remove only what Flow created. A null path derives the Flow-owned mount. */
  release(input: { flowId: string; ticketId: number; worktreePath: string | null; branch: string | null }): Promise<void>
  /** Commit the worktree's deliverable changes (overlay excluded) and return HEAD. */
  freeze(input: { flowId: string; conversationId: string; ticketId: number; worktreePath: string; baseSha: string | null }): Promise<{ headSha: string }>
  exists(worktreePath: string): boolean
  diff(input: { worktreePath: string; baseSha: string | null; branch: string | null }): Promise<FlowDiffSummary>
}

/** Core agent session of a Flow (`flow:<flowId>`). Turns open it lazily with
 * the worktree as cwd; this port checks support and closes it. */
export interface FlowAgentSession {
  /** Throws `FlowValidationError`/`FlowUnavailableError` when this conversation
   * cannot run a Flow now (not pinned to the project, provider without a Core
   * session driver, host without flowSessions). Checked before any effect. */
  assertReady(input: { conversationId: string }): Promise<void>
  /** Throws `FlowUnavailableError` when Flow cannot run for this conversation. */
  open(input: { flowId: string; conversationId: string; worktreePath: string }): Promise<{ coreSessionId: string }>
  /** Stops a running Flow turn and closes the Core session. Never throws. */
  close(input: { flowId: string; conversationId: string; coreSessionId: string }): Promise<void>
}

export interface FlowLaunchOptions {
  loopId?: string
  aiEngine?: string
  model?: string
  reasoningEffort?: string
}

/** Launch the Flow ticket on a rail through the single launch authority. The
 * ownership transfer happens inside that launch, atomically. */
export interface FlowRailLauncher {
  launch(input: { flowId: string; conversationId: string; ticketId: number; railIndex: number; options: FlowLaunchOptions }): Promise<{ loopRunIds: string[]; deliveryId: string | null }>
}

/** Real (provider-reported) usage of a Flow's turns. Never estimates. */
export interface FlowUsage {
  costSoFar(input: { conversationId: string; from: string; to: string | null }): {
    costUsd: number
    turns: number
    /** Turns whose cost the provider did not bill (not included in costUsd). */
    unpricedTurns: number
    tokensIn: number
    tokensOut: number
  }
}

/** Observer for committed state changes (WebSocket fan-out). Never throws. */
export interface FlowNotifier {
  changed(session: FlowSession): void
}

/** Settlement publication (Jira create + review transition). Bound by the
 * flow-spec loop PR; this PR records the transition only. */
export interface FlowPublication {
  publish(input: { flowId: string; ticketId: number; deliveryId: string }): void
}

export interface Clock {
  now(): string
}

export interface FlowPorts {
  repository: FlowRepository
  tickets: FlowTickets
  worktrees: WorktreeReservation
  agent: FlowAgentSession
  rails: FlowRailLauncher
  usage: FlowUsage
  notifier: FlowNotifier
  clock: Clock
  ids: () => string
  /** Whether the selected Core can run Flow at all (capability gating). */
  availability: () => Promise<{ available: boolean; reason: string; missing: string[] }>
}
