import type { DerivedChangeText, IntentDerivationCoverage, IntentRepositoryMember, IntentReviewFindings, IntentRunFailure, IntentSession, IntentSettlementEffect, IntentSettlementSummary, IntentSpecSnapshot, IntentTicketState } from './domain'

/**
 * Outbound contracts owned by the Intent use cases. Production implementations
 * live in `adapters/` and are bound to ONE project at composition time; the
 * application never sees a project registry, SQL connection, Git or Core.
 */

/** Persistence of `flow_sessions` (project database). */
export interface IntentRepository {
  /** Insert a new Intent. Throws `IntentConflictError` when the conversation
   * already has an active or paused Intent (unique index) or the id exists. */
  insert(session: IntentSession): void
  /** Replace the stored row (same id). */
  save(session: IntentSession): void
  get(flowId: string): IntentSession | null
  /** The conversation's active or paused Intent, if any. */
  findOpenByConversation(conversationId: string): IntentSession | null
  /** Most recent Intent of a conversation in any state. */
  latestByConversation(conversationId: string): IntentSession | null
  /** Flows reconciliation must inspect (not terminal and not handed off). */
  listUnsettled(): IntentSession[]
  /** Flows a rail adopted and whose delivery has not settled yet. */
  listHandedOff(): IntentSession[]
  /** The Intent a rail delivery belongs to. */
  findByDelivery(deliveryId: string): IntentSession | null
}

/** Durable settlement effects (`flow_effects`, project database). */
export interface IntentEffectsStore {
  /** Insert planned effects; existing keys are left untouched (idempotent). */
  enqueue(effects: IntentSettlementEffect[]): void
  list(flowId: string): IntentSettlementEffect[]
  save(effect: IntentSettlementEffect): void
  /** Flows with at least one pending effect. */
  pendingFlowIds(): string[]
}

/** Why an existing spec cannot start an Intent session now (null ⇒ it can). */
export interface IntentSpecBlocker {
  /** `spec_not_found`, `spec_closed` (done/cancelled), `spec_in_flow`, `spec_on_rail`, `spec_running`. */
  code: string
  message: string
}

/** The Intent's spec ("In Intent"): the placeholder it creates through the
 * non-promoting path, or the existing spec it started from. */
export interface IntentTickets {
  /** `repositoryIds`: the Intent's non-primary target repository (absent ⇒ primary). */
  createPlaceholder(input: { flowId: string; conversationId: string; title: string; description: string; startedAt: string; repositoryIds?: string[]; intent?: unknown }): number
  setFlowState(ticketId: number, state: IntentTicketState): void
  /** Idempotent: a missing ticket is not an error. */
  deletePlaceholder(ticketId: number): void
  /** Settlement: `metadata.flow.state = 'delivered'` (the "In Intent" label
   * disappears), `metadata.openspecChangeName`, status `on_review` unless the
   * ticket already moved on. Idempotent. */
  markDelivered(ticketId: number, input: { openspecChangeName: string | null }): void
  /** Back to Intent: the spec is worked on again (in progress, "In Intent"); a
   * ticket that moved on (done, cancelled) is left alone. */
  reopen(ticketId: number): void
  /** Current title, idea (description), status and target repositories; null when the ticket is gone. */
  read(ticketId: number): { title: string; description: string; status: string; repositoryIds?: string[]; nonGoals?: string[]; intent?: string } | null
  /** Read-only: whether an existing spec can start an Intent session now, and its content. */
  inspectExisting(ticketId: number): { spec: IntentSpecSnapshot | null; blocker: IntentSpecBlocker | null }
  /** Intent from an existing spec: label it "In Intent" for `flowId` (metadata.flow
   * with origin `existing` and the status it had), status in progress.
   * Re-checks eligibility atomically (throws IntentConflictError); idempotent for
   * the same Intent. Returns the spec the first Intent turn receives. */
  adoptExisting(input: { ticketId: number; flowId: string; conversationId: string; startedAt: string }): IntentSpecSnapshot
  /** Undo `adoptExisting` (discard, failed start): the label goes and the
   * status it had comes back unless the spec moved on. Never deletes; a spec
   * this Intent does not hold is left alone. Idempotent. */
  restoreExisting(ticketId: number, flowId: string): void
  /** Settlement of an Intent session from an existing spec, BEFORE the rewrite: keep the
   * spec's current content as a comment ("Original spec before Intent").
   * Idempotent by Intent. */
  preserveOriginal(ticketId: number, flowId: string): void
  /** Settlement, AFTER a successful rewrite: the spec's live addenda (open, or
   * in flight on the Intent's hand-off run) become applied, recording `causalId`
   * (the Intent's delivery). Only the spec THIS Intent holds; idempotent. */
  applyAddenda(ticketId: number, flowId: string, causalId: string): void
}

export interface ReservedWorktree {
  branch: string
  worktreePath: string
  baseSha: string | null
  headSha: string | null
}

export interface IntentDiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  /** Null for binary files or untracked files whose size is not counted. */
  additions: number | null
  deletions: number | null
}

export interface IntentDiffSummary {
  branch: string | null
  baseSha: string | null
  headSha: string | null
  files: IntentDiffFile[]
  totals: { files: number; additions: number; deletions: number }
}

/** The single worktree machinery (delivery) seen from Intent. Every call names
 * the Intent's repository: absent/null ⇒ the primary repository at the project
 * root; otherwise that Git member's checkout and its own mount root. */
export interface WorktreeReservation {
  /** Fresh worktree + branch for the placeholder ticket, owned by this Intent. */
  reserve(input: { flowId: string; conversationId: string; ticketId: number; repositoryId?: string | null }): Promise<ReservedWorktree>
  /** Remove only what Intent created. A null path derives the Intent-owned mount. */
  release(input: { flowId: string; ticketId: number; worktreePath: string | null; branch: string | null; repositoryId?: string | null }): Promise<void>
  /** Commit the worktree's deliverable changes (overlay excluded) and return HEAD. */
  /** `allowedChanges`: active OpenSpec changes this Intent's own Intent → Spec runs
   * derived; the delivery hygiene still blocks every other new active change. */
  freeze(input: { flowId: string; conversationId: string; ticketId: number; worktreePath: string; baseSha: string | null; allowedChanges: string[]; repositoryId?: string | null; branch?: string | null }): Promise<{ headSha: string; adoptedChange?: string }>
  exists(worktreePath: string): boolean
  diff(input: { worktreePath: string; baseSha: string | null; branch: string | null; repositoryId?: string | null }): Promise<IntentDiffSummary>
  /** Totals of the committed change between two commits of the Intent's
   * repository (the project checkout, not the worktree: a delivered Intent's
   * worktree may be gone). Null when either commit is unknown or the diff
   * cannot be measured; never throws. */
  diffTotals?(input: { baseSha: string | null; headSha: string | null; repositoryId?: string | null }): Promise<{ files: number; additions: number; deletions: number } | null>
}

/** Core agent session of an Intent session (`flow:<flowId>`). Turns open it lazily with
 * the worktree as cwd; this port checks support and closes it. */
export interface IntentAgentSession {
  /** Throws `IntentValidationError`/`IntentUnavailableError` when this conversation
   * cannot run an Intent session now (not pinned to the project, provider without a Core
   * session driver, host without flowSessions). Checked before any effect. */
  assertReady(input: { conversationId: string }): Promise<void>
  /** Throws `IntentUnavailableError` when Intent cannot run for this conversation. */
  open(input: { flowId: string; conversationId: string; worktreePath: string; renew?: boolean }): Promise<{ coreSessionId: string }>
  /** Stops a running Intent turn and closes the Core session. Never throws. */
  close(input: { flowId: string; conversationId: string; coreSessionId: string }): Promise<void>
  /** The conversation's CURRENT engine (provider/model/effort) when that
   * provider can run Intent → Spec on this machine; null otherwise (the run
   * keeps its previous choices or the rail default). */
  launchEngine?(conversationId: string): Pick<IntentLaunchOptions, 'aiEngine' | 'model' | 'reasoningEffort'> | null
}

/** Background processes (dev servers) the Intent agent started in its worktree
 * through Specrails (`specrails_jobs background_start`). */
export interface IntentProcesses {
  /** Stop every live process tagged with this Intent and wait, bounded, for
   * them to exit. Best effort: never throws for a process that is already gone. */
  stop(input: { flowId: string; conversationId: string }): Promise<void>
}

export interface IntentLaunchOptions {
  loopId?: string
  aiEngine?: string
  model?: string
  reasoningEffort?: string
}

/** Launch the Intent ticket on a rail through the single launch authority. The
 * ownership transfer happens inside that launch, atomically. */
export interface IntentRailLauncher {
  /** `repositoryId`: the Intent's non-primary repository, launched as that one
   * repository (absent ⇒ the primary repository, as before workspaces). */
  launch(input: { flowId: string; conversationId: string; ticketId: number; railIndex: number; options: IntentLaunchOptions; repositoryId?: string | null }): Promise<{ loopRunIds: string[]; deliveryId: string | null }>
  /** An Intent session → Spec delivery that stopped before delivery: its rail, its launch
   * choices (for Relaunch) and the review findings. Null when unknown. */
  stoppedDelivery(deliveryId: string): { railIndex: number; options: IntentLaunchOptions; findings: IntentReviewFindings | null; derivation?: IntentDerivationCoverage | null; failure?: IntentRunFailure | null } | null
  /** A run that failed outright (no review findings): the failing step and the
   * first line of the runtime's own error, read from the run's runtime. Null
   * when unknown; never throws. Absent ⇒ only the delivery codes are known. */
  runFailure?(deliveryId: string): Promise<Pick<IntentRunFailure, 'stepId' | 'cause'> | null>
  /** Back to Intent: delivery removes its ledger row for the adopted worktree and
   * closes the delivery in ONE transaction; `commit` (the Intent's own state
   * change) runs inside it, so ownership moves atomically. Throws (409) when
   * the delivery cannot give the worktree back. */
  returnWorktree(input: { deliveryId: string; worktreePath: string; detail: string; commit: () => void }): void
}

/** What the closing success card is built from (see `IntentConversation.postDeliveredSummary`). */
export interface IntentDeliveredSummaryInput {
  conversationId: string
  flowId: string
  deliveryId: string | null
  ticketId: number
  settlement: IntentSettlementSummary
  session: IntentSession
  /** Provider-billed cost of the Intent's turns (null when usage is unknown). */
  cost: { costUsd: number; turns: number; unpricedTurns: number } | null
  /** Files changed between the Intent's base and its frozen head (null when not measurable). */
  diff: { files: number; additions: number; deletions: number } | null
  /** Wall-clock time from the Intent's start to this post. */
  durationMs: number
}

/** Real (provider-reported) usage of an Intent session's turns. Never estimates. */
export interface IntentUsage {
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
export interface IntentNotifier {
  changed(session: IntentSession): void
}

/** Settlement publication (arch section 4.6): what the settlement reads from
 * the delivery and writes to specs and Jira. Bound per project. */
export interface IntentPublication {
  /** Whether the rail delivery reached review (on_review or later with a
   * succeeded implementation). Null when the delivery row is unknown. */
  deliveryState(deliveryId: string): {
    delivered: boolean
    /** An Intent session → Spec run that failed outright — a technical failure, not
     * requested changes — and whose delivery is idle: the worktree goes back
     * to its Intent automatically. */
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
    /** A spec already linked to an issue (an Intent session from an existing spec): push
     * its rewritten summary and description to THAT issue through a durable
     * outbox `update` (never a second issue). Idempotent by key. Never throws. */
    enqueueUpdate(ticketId: number, idempotencyKey: string): 'enqueued' | 'not_linked' | 'inactive' | 'failed'
  }
}

export interface Clock {
  now(): string
}

/**
 * The mission conversation an Intent session belongs to: Back to Intent tells the person
 * what the reviewer asked for (or why the run failed) and lets the Intent agent
 * start on it. Both are
 * idempotent by delivery and never throw.
 */
export interface IntentConversation {
  /** Post the visible "What the reviewer asked for" card (once per delivery). */
  postReturnCard(input: { conversationId: string; flowId: string; deliveryId: string; findings: IntentReviewFindings | null; derivation: IntentDerivationCoverage | null; failure?: IntentRunFailure }): void
  /** Start ONE automatic Intent turn that works on the return briefing (once per
   * delivery); `failure` ⇒ the run failed outright (no review findings). */
  startReturnTurn(input: { conversationId: string; flowId: string; deliveryId: string; failure?: IntentRunFailure }): Promise<void>
  /** Start ONE automatic Intent turn right after the session opened with a
   * seed (an intent or an existing spec): the agent begins instead of waiting
   * for the person to speak first. Once per Intent; absent ⇒ the seed waits
   * for the person's next turn. */
  startOpeningTurn?(input: { conversationId: string; flowId: string }): Promise<void>
  /** The closing success card of a delivered Intent. Posted as soon as the
   * Intent is `delivered` (its settlement lines still pending) and posted again,
   * IN PLACE, every time the settlement advances (spec rewrite, Jira create):
   * the adapter upserts one row per Intent. `cost` is provider-reported only;
   * `diff` is the Intent's measured change (null when it cannot be measured any
   * more). Never throws. Absent ⇒ the run card alone tells the outcome. */
  postDeliveredSummary?(input: IntentDeliveredSummaryInput): void
  /** A boundary of the conversation's Intent mode, as one history line: the
   * conversation entered Intent (started, or the work came back from a rail) or
   * left it (handed off to a rail, discarded). The client marks the agent
   * turns in between as Intent turns. Never throws; absent ⇒ no boundary lines. */
  postBoundary?(input: IntentBoundary): void
}

export interface IntentBoundary {
  conversationId: string
  flowId: string
  event: 'entered' | 'left'
  reason: 'started' | 'returned' | 'handed_off' | 'discarded' | 'closed'
  branch: string | null
}

/** The project's repositories (target triage of a new Intent). */
export interface IntentRepositoryCatalog {
  list(): IntentRepositoryMember[]
}

export interface IntentPorts {
  repository: IntentRepository
  /** Absent ⇒ a single-repository project (every Intent runs in the primary). */
  repositories?: IntentRepositoryCatalog
  tickets: IntentTickets
  worktrees: WorktreeReservation
  agent: IntentAgentSession
  processes: IntentProcesses
  rails: IntentRailLauncher
  effects: IntentEffectsStore
  publication: IntentPublication
  usage: IntentUsage
  notifier: IntentNotifier
  clock: Clock
  ids: () => string
  /** Whether the selected Core can run Intent at all (capability gating). */
  availability: () => Promise<{ available: boolean; reason: string; missing: string[] }>
  /** Back to Intent card + automatic turn (absent: the briefing waits for the person's next turn). */
  conversation?: IntentConversation
}
