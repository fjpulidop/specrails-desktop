import type { DerivedChangeText, FlowDerivationCoverage, FlowReviewFindings, FlowSession, FlowSettlementEffect, FlowTicketState } from './domain'

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
  /** Flows a rail adopted and whose delivery has not settled yet. */
  listHandedOff(): FlowSession[]
  /** The Flow a rail delivery belongs to. */
  findByDelivery(deliveryId: string): FlowSession | null
}

/** Durable settlement effects (`flow_effects`, project database). */
export interface FlowEffectsStore {
  /** Insert planned effects; existing keys are left untouched (idempotent). */
  enqueue(effects: FlowSettlementEffect[]): void
  list(flowId: string): FlowSettlementEffect[]
  save(effect: FlowSettlementEffect): void
  /** Flows with at least one pending effect. */
  pendingFlowIds(): string[]
}

/** The placeholder spec ("In Flow"). Created through the non-promoting path. */
export interface FlowTickets {
  createPlaceholder(input: { flowId: string; conversationId: string; title: string; description: string; startedAt: string }): number
  setFlowState(ticketId: number, state: FlowTicketState): void
  /** Idempotent: a missing ticket is not an error. */
  deletePlaceholder(ticketId: number): void
  /** Settlement: `metadata.flow.state = 'delivered'` (the "In Flow" label
   * disappears), `metadata.openspecChangeName`, status `on_review` unless the
   * ticket already moved on. Idempotent. */
  markDelivered(ticketId: number, input: { openspecChangeName: string | null }): void
  /** Back to Flow: the spec is worked on again (in progress, "In Flow"); a
   * ticket that moved on (done, cancelled) is left alone. */
  reopen(ticketId: number): void
  /** Current title, idea (description) and status; null when the ticket is gone. */
  read(ticketId: number): { title: string; description: string; status: string } | null
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
  /** `allowedChanges`: active OpenSpec changes this Flow's own Flow → Spec runs
   * derived; the delivery hygiene still blocks every other new active change. */
  freeze(input: { flowId: string; conversationId: string; ticketId: number; worktreePath: string; baseSha: string | null; allowedChanges: string[] }): Promise<{ headSha: string }>
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
  open(input: { flowId: string; conversationId: string; worktreePath: string; renew?: boolean }): Promise<{ coreSessionId: string }>
  /** Stops a running Flow turn and closes the Core session. Never throws. */
  close(input: { flowId: string; conversationId: string; coreSessionId: string }): Promise<void>
}

/** Background processes (dev servers) the Flow agent started in its worktree
 * through Specrails (`specrails_jobs background_start`). */
export interface FlowProcesses {
  /** Stop every live process tagged with this Flow and wait, bounded, for
   * them to exit. Best effort: never throws for a process that is already gone. */
  stop(input: { flowId: string; conversationId: string }): Promise<void>
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
  /** A Flow → Spec delivery that stopped before delivery: its rail, its launch
   * choices (for Relaunch) and the review findings. Null when unknown. */
  stoppedDelivery(deliveryId: string): { railIndex: number; options: FlowLaunchOptions; findings: FlowReviewFindings | null; derivation?: FlowDerivationCoverage | null } | null
  /** Back to Flow: delivery removes its ledger row for the adopted worktree and
   * closes the delivery in ONE transaction; `commit` (the Flow's own state
   * change) runs inside it, so ownership moves atomically. Throws (409) when
   * the delivery cannot give the worktree back. */
  returnWorktree(input: { deliveryId: string; worktreePath: string; detail: string; commit: () => void }): void
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

/** Settlement publication (arch section 4.6): what the settlement reads from
 * the delivery and writes to specs and Jira. Bound per project. */
export interface FlowPublication {
  /** Whether the rail delivery reached review (on_review or later with a
   * succeeded implementation). Null when the delivery row is unknown. */
  deliveryState(deliveryId: string): { delivered: boolean } | null
  /** The derived OpenSpec change on the delivered branch (proposal, design,
   * diffstat). Throws when Git cannot be read (the effect retries). */
  derivedChange(input: { flowId: string; deliveryId: string | null; ticketId: number; branch: string | null; baseSha: string | null }): Promise<DerivedChangeText>
  /** Bounded conversation summary (user messages + decisions). */
  conversationSummary(input: { conversationId: string; ticketId: number; from: string; to: string | null }): string
  /** Rewrite the spec in place (current format) and run the Contract Layer. */
  rewriteSpec(input: { ticketId: number; text: string }): Promise<{ ok: true } | { ok: false; error: string }>
  jira: {
    connected(): boolean
    /** Durable create through the Jira outbox (never throws). */
    enqueueCreate(ticketId: number, idempotencyKey: string): 'enqueued' | 'already_linked' | 'inactive' | 'failed'
    linked(ticketId: number): boolean
    /** Transition to the status mapped for `on_review` (idempotent by refId). */
    enqueueReview(ticketId: number, refId: string): void
  }
}

export interface Clock {
  now(): string
}

/**
 * The mission conversation a Flow belongs to: Back to Flow tells the person
 * what the reviewer asked for and lets the Flow agent start on it. Both are
 * idempotent by delivery and never throw.
 */
export interface FlowConversation {
  /** Post the visible "What the reviewer asked for" card (once per delivery). */
  postReturnCard(input: { conversationId: string; flowId: string; deliveryId: string; findings: FlowReviewFindings | null; derivation: FlowDerivationCoverage | null }): void
  /** Start ONE automatic Flow turn that works on the return briefing (once per delivery). */
  startReturnTurn(input: { conversationId: string; flowId: string; deliveryId: string }): Promise<void>
}

export interface FlowPorts {
  repository: FlowRepository
  tickets: FlowTickets
  worktrees: WorktreeReservation
  agent: FlowAgentSession
  processes: FlowProcesses
  rails: FlowRailLauncher
  effects: FlowEffectsStore
  publication: FlowPublication
  usage: FlowUsage
  notifier: FlowNotifier
  clock: Clock
  ids: () => string
  /** Whether the selected Core can run Flow at all (capability gating). */
  availability: () => Promise<{ available: boolean; reason: string; missing: string[] }>
  /** Back to Flow card + automatic turn (absent: the briefing waits for the person's next turn). */
  conversation?: FlowConversation
}
