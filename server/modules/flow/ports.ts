import type { DerivedChangeText, FlowDerivationCoverage, FlowRepositoryMember, FlowReviewFindings, FlowRunFailure, FlowSession, FlowSettlementEffect, FlowSettlementSummary, FlowSpecSnapshot, FlowTicketState } from './domain'

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

/** Why an existing spec cannot start a Flow now (null ⇒ it can). */
export interface FlowSpecBlocker {
  /** `spec_not_found`, `spec_closed` (done/cancelled), `spec_in_flow`, `spec_on_rail`, `spec_running`. */
  code: string
  message: string
}

/** The Flow's spec ("In Flow"): the placeholder it creates through the
 * non-promoting path, or the existing spec it started from. */
export interface FlowTickets {
  /** `repositoryIds`: the Flow's non-primary target repository (absent ⇒ primary). */
  createPlaceholder(input: { flowId: string; conversationId: string; title: string; description: string; startedAt: string; repositoryIds?: string[] }): number
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
  /** Current title, idea (description), status and target repositories; null when the ticket is gone. */
  read(ticketId: number): { title: string; description: string; status: string; repositoryIds?: string[]; nonGoals?: string[] } | null
  /** Read-only: whether an existing spec can start a Flow now, and its content. */
  inspectExisting(ticketId: number): { spec: FlowSpecSnapshot | null; blocker: FlowSpecBlocker | null }
  /** Flow from an existing spec: label it "In Flow" for `flowId` (metadata.flow
   * with origin `existing` and the status it had), status in progress.
   * Re-checks eligibility atomically (throws FlowConflictError); idempotent for
   * the same Flow. Returns the spec the first Flow turn receives. */
  adoptExisting(input: { ticketId: number; flowId: string; conversationId: string; startedAt: string }): FlowSpecSnapshot
  /** Undo `adoptExisting` (discard, failed start): the label goes and the
   * status it had comes back unless the spec moved on. Never deletes; a spec
   * this Flow does not hold is left alone. Idempotent. */
  restoreExisting(ticketId: number, flowId: string): void
  /** Settlement of a Flow from an existing spec, BEFORE the rewrite: keep the
   * spec's current content as a comment ("Original spec before Flow").
   * Idempotent by Flow. */
  preserveOriginal(ticketId: number, flowId: string): void
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

/** The single worktree machinery (delivery) seen from Flow. Every call names
 * the Flow's repository: absent/null ⇒ the primary repository at the project
 * root; otherwise that Git member's checkout and its own mount root. */
export interface WorktreeReservation {
  /** Fresh worktree + branch for the placeholder ticket, owned by this Flow. */
  reserve(input: { flowId: string; conversationId: string; ticketId: number; repositoryId?: string | null }): Promise<ReservedWorktree>
  /** Remove only what Flow created. A null path derives the Flow-owned mount. */
  release(input: { flowId: string; ticketId: number; worktreePath: string | null; branch: string | null; repositoryId?: string | null }): Promise<void>
  /** Commit the worktree's deliverable changes (overlay excluded) and return HEAD. */
  /** `allowedChanges`: active OpenSpec changes this Flow's own Flow → Spec runs
   * derived; the delivery hygiene still blocks every other new active change. */
  freeze(input: { flowId: string; conversationId: string; ticketId: number; worktreePath: string; baseSha: string | null; allowedChanges: string[]; repositoryId?: string | null }): Promise<{ headSha: string; adoptedChange?: string }>
  exists(worktreePath: string): boolean
  diff(input: { worktreePath: string; baseSha: string | null; branch: string | null; repositoryId?: string | null }): Promise<FlowDiffSummary>
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
  /** The conversation's CURRENT engine (provider/model/effort) when that
   * provider can run Flow → Spec on this machine; null otherwise (the run
   * keeps its previous choices or the rail default). */
  launchEngine?(conversationId: string): Pick<FlowLaunchOptions, 'aiEngine' | 'model' | 'reasoningEffort'> | null
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
  /** `repositoryId`: the Flow's non-primary repository, launched as that one
   * repository (absent ⇒ the primary repository, as before workspaces). */
  launch(input: { flowId: string; conversationId: string; ticketId: number; railIndex: number; options: FlowLaunchOptions; repositoryId?: string | null }): Promise<{ loopRunIds: string[]; deliveryId: string | null }>
  /** A Flow → Spec delivery that stopped before delivery: its rail, its launch
   * choices (for Relaunch) and the review findings. Null when unknown. */
  stoppedDelivery(deliveryId: string): { railIndex: number; options: FlowLaunchOptions; findings: FlowReviewFindings | null; derivation?: FlowDerivationCoverage | null; failure?: FlowRunFailure | null } | null
  /** A run that failed outright (no review findings): the failing step and the
   * first line of the runtime's own error, read from the run's runtime. Null
   * when unknown; never throws. Absent ⇒ only the delivery codes are known. */
  runFailure?(deliveryId: string): Promise<Pick<FlowRunFailure, 'stepId' | 'cause'> | null>
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
  deliveryState(deliveryId: string): {
    delivered: boolean
    /** A Flow → Spec run that failed outright — a technical failure, not
     * requested changes — and whose delivery is idle: the worktree goes back
     * to its Flow automatically. */
    crashed?: boolean
  } | null
  /** The derived OpenSpec change on the delivered branch (proposal, design,
   * diffstat). Throws when Git cannot be read (the effect retries). */
  derivedChange(input: { flowId: string; deliveryId: string | null; ticketId: number; branch: string | null; baseSha: string | null; repositoryId?: string | null }): Promise<DerivedChangeText>
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
    /** A spec already linked to an issue (a Flow from an existing spec): push
     * its rewritten summary and description to THAT issue through a durable
     * outbox `update` (never a second issue). Idempotent by key. Never throws. */
    enqueueUpdate(ticketId: number, idempotencyKey: string): 'enqueued' | 'not_linked' | 'inactive' | 'failed'
  }
}

export interface Clock {
  now(): string
}

/**
 * The mission conversation a Flow belongs to: Back to Flow tells the person
 * what the reviewer asked for (or why the run failed) and lets the Flow agent
 * start on it. Both are
 * idempotent by delivery and never throw.
 */
export interface FlowConversation {
  /** Post the visible "What the reviewer asked for" card (once per delivery). */
  postReturnCard(input: { conversationId: string; flowId: string; deliveryId: string; findings: FlowReviewFindings | null; derivation: FlowDerivationCoverage | null; failure?: FlowRunFailure }): void
  /** Start ONE automatic Flow turn that works on the return briefing (once per
   * delivery); `failure` ⇒ the run failed outright (no review findings). */
  startReturnTurn(input: { conversationId: string; flowId: string; deliveryId: string; failure?: FlowRunFailure }): Promise<void>
  /** The closing summary once a delivered Flow settled its spec and Jira
   * (PR link, rewritten spec, archived OpenSpec change, Jira key). Once per
   * Flow; never throws. Absent ⇒ the run card alone tells the outcome. */
  postDeliveredSummary?(input: { conversationId: string; flowId: string; deliveryId: string | null; ticketId: number; settlement: FlowSettlementSummary }): void
  /** A boundary of the conversation's Flow mode, as one history line: the
   * conversation entered Flow (started, or the work came back from a rail) or
   * left it (handed off to a rail, discarded). The client marks the agent
   * turns in between as Flow turns. Never throws; absent ⇒ no boundary lines. */
  postBoundary?(input: FlowBoundary): void
}

export interface FlowBoundary {
  conversationId: string
  flowId: string
  event: 'entered' | 'left'
  reason: 'started' | 'returned' | 'handed_off' | 'discarded' | 'closed'
  branch: string | null
}

/** The project's repositories (target triage of a new Flow). */
export interface FlowRepositoryCatalog {
  list(): FlowRepositoryMember[]
}

export interface FlowPorts {
  repository: FlowRepository
  /** Absent ⇒ a single-repository project (every Flow runs in the primary). */
  repositories?: FlowRepositoryCatalog
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
