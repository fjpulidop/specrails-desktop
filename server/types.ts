export type PhaseName = string
export type PhaseState = 'idle' | 'running' | 'done' | 'error'

export interface PhaseDefinition {
  key: string
  label: string
  description: string
}

// ─── ProjectRow (app-level) — re-exported from desktop-db for WS message use ──

import type { ProjectRow } from './desktop-db'
export type { ProjectRow }

// ─── ProposalRow re-export ────────────────────────────────────────────────────

export type { ProposalRow } from './db'

export interface LogMessage {
  type: 'log'
  source: 'stdout' | 'stderr'
  line: string
  timestamp: string
  processId: string
  projectId?: string
}

export interface PhaseMessage {
  type: 'phase'
  phase: PhaseName
  state: PhaseState
  timestamp: string
  projectId?: string
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'zombie_terminated' | 'skipped'

export type JobPriority = 'low' | 'normal' | 'high' | 'critical'

/** Durable lifecycle authority for a row in `jobs`. Queue-owned jobs are
 * reconciled by QueueManager; loop-owned backing rows are reconciled by the
 * loop engine so one crash can never be accounted by both surfaces. */
export type JobOwner = 'queue' | 'loop'

export const PRIORITY_WEIGHT: Record<JobPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
}

export const VALID_PRIORITIES = new Set<string>(['low', 'normal', 'high', 'critical'])

export interface JobRow {
  id: string
  command: string
  started_at: string
  finished_at: string | null
  status: JobStatus
  exit_code: number | null
  queue_position: number | null
  priority: JobPriority
  tokens_in: number | null
  tokens_out: number | null
  tokens_cache_read: number | null
  tokens_cache_create: number | null
  total_cost_usd: number | null
  /** 1 when total_cost_usd is a pricing-table estimate (codex), 0 when
   *  authoritative from the provider (claude). Added in migration 27. */
  total_cost_usd_estimated?: number | null
  num_turns: number | null
  model: string | null
  duration_ms: number | null
  duration_api_ms: number | null
  session_id: string | null
  depends_on_job_id: string | null
  pipeline_id: string | null
  skip_reason: string | null
  /** Profile name the job was launched with (null = legacy mode, or job
   *  predates the profiles feature). Populated via LEFT JOIN job_profiles. */
  profile_name?: string | null
  /** 1 when this is an interactive persistent freestyle session (added in
   *  migration 32); 0/absent for standard autonomous jobs. */
  interactive?: number | null
  /** Provider selected for this concrete run (migration 42). */
  provider?: string | null
  /** Manager that exclusively owns terminal recovery (migration 44). */
  owner?: JobOwner
  /** 1 when launch-time causal ownership was durably claimed (migration 46). */
  causal_ownership?: number
}

export interface EventRow {
  id: number
  job_id: string
  seq: number
  event_type: string
  source: string | null
  payload: string
  timestamp: string
}

export interface StatsRow {
  totalJobs: number
  failedJobs: number
  jobsToday: number
  totalCostUsd: number
  costToday: number
  /** Portion of totalCostUsd / costToday that is a rate-card ESTIMATE
   *  (codex/gemini, total_cost_usd_estimated=1), not provider-billed. Lets the
   *  StatusBar mark an estimated cost with `~` instead of presenting it as a
   *  billed figure (BUG-ANALYTICS-27). 0 on claude-only surfaces. */
  estimatedCostUsd: number
  estimatedCostToday: number
  avgDurationMs: number | null
}

export type AnalyticsPeriod = '7d' | '30d' | '90d' | 'all' | 'custom'

export interface AnalyticsOpts {
  period: AnalyticsPeriod
  from?: string
  to?: string
}

export interface AnalyticsResponse {
  period: {
    label: string
    from: string | null
    to: string | null
  }
  kpi: {
    totalCostUsd: number
    totalJobs: number
    successRate: number
    avgDurationMs: number | null
    totalTokens: number
    costDelta: number | null
    jobsDelta: number | null
    successRateDelta: number | null
    avgDurationDelta: number | null
    totalTokensDelta: number | null
    costDeltaPct: number | null
    jobsDeltaPct: number | null
    successRateDeltaPct: number | null
    avgDurationDeltaPct: number | null
    totalTokensDeltaPct: number | null
    previousPeriod: {
      label: string
      from: string | null
      to: string | null
      totalCostUsd: number
      totalJobs: number
      successRate: number
      avgDurationMs: number | null
      totalTokens: number
    } | null
  }
  costTimeline: Array<{ date: string; costUsd: number }>
  statusBreakdown: Array<{ status: string; count: number }>
  durationHistogram: Array<{ bucket: string; count: number }>
  durationPercentiles: { p50: number | null; p75: number | null; p95: number | null }
  tokenEfficiency: Array<{
    command: string
    tokensOut: number
    tokensCacheRead: number
    totalTokens: number
  }>
  commandPerformance: Array<{
    command: string
    totalRuns: number
    successRate: number
    avgCostUsd: number | null
    avgDurationMs: number | null
    totalCostUsd: number
  }>
  dailyThroughput: Array<{ date: string; completed: number; failed: number; canceled: number }>
  costPerCommand: Array<{ command: string; totalCostUsd: number; jobCount: number }>
  bonusMetrics: {
    costPerSuccess: number | null
    apiEfficiencyPct: number | null
    failureCostUsd: number
    modelBreakdown: Array<{ model: string; jobCount: number; totalCostUsd: number }>
  }
}

// ─── Trends ──────────────────────────────────────────────────────────────────

export type TrendsPeriod = '1d' | '7d' | '30d'

export interface TrendPoint {
  date: string
  jobCount: number
  avgDurationMs: number | null
  avgTokens: number | null
  avgCostUsd: number | null
  successRate: number
}

export interface TrendsResponse {
  period: TrendsPeriod
  points: TrendPoint[]
}

// ─── Job comparison ───────────────────────────────────────────────────────────

export interface JobCompareEntry {
  id: string
  command: string
  status: JobStatus
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  tokensIn: number | null
  tokensOut: number | null
  tokensCacheRead: number | null
  totalCostUsd: number | null
  model: string | null
  phasesCompleted: string[]
}

export interface JobCompareResponse {
  jobs: [JobCompareEntry, JobCompareEntry]
}

export interface ChatConversationRow {
  id: string
  title: string | null
  model: string
  session_id: string | null
  created_at: string
  updated_at: string
  kind: 'sidebar' | 'explore'
  context_scope: string | null
  /** Per-conversation AI engine for multi-provider projects. NULL = project primary. */
  provider: string | null
}

export interface ChatMessageRow {
  id: number
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface ActivityItem {
  id: string
  type: 'job_started' | 'job_completed' | 'job_failed' | 'job_canceled'
  jobId: string
  jobCommand: string
  timestamp: string
  summary: string
  costUsd: number | null
}

export interface JobSummary {
  id: string
  command: string
  started_at: string
  status: JobStatus
  total_cost_usd: number | null
}

export interface Job {
  id: string
  command: string
  status: JobStatus
  queuePosition: number | null
  priority: JobPriority
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  dependsOnJobId: string | null
  pipelineId: string | null
  skipReason: string | null
  resultText: string | null
  /** True for launches admitted through the durable causal-ownership protocol;
   * false/absent is legacy work that may use the compatibility fallback. */
  causalOwnership?: boolean
}

export interface QueueMessage {
  type: 'queue'
  jobs: Job[]
  activeJobId: string | null
  paused: boolean
  timestamp: string
  projectId?: string
}

export interface InitMessage {
  type: 'init'
  projectName: string
  phases: Record<PhaseName, PhaseState>
  phaseDefinitions: PhaseDefinition[]
  logBuffer: LogMessage[]
  recentJobs: JobSummary[]
  queue: {
    jobs: Job[]
    activeJobId: string | null
    paused: boolean
  }
  projectId?: string
}

export interface EventMessage {
  type: 'event'
  jobId: string
  event_type: string
  source: string
  payload: string
  timestamp: string
  seq: number
  projectId?: string
}

export interface ChatStreamMessage {
  type: 'chat_stream'
  conversationId: string
  delta: string
  timestamp: string
  projectId?: string
}

export interface ChatDoneMessage {
  type: 'chat_done'
  conversationId: string
  fullText: string
  timestamp: string
  projectId?: string
}

export interface ChatErrorMessage {
  type: 'chat_error'
  conversationId: string
  error: string
  timestamp: string
  projectId?: string
}

export interface ChatCommandProposalMessage {
  type: 'chat_command_proposal'
  conversationId: string
  command: string
  timestamp: string
  projectId?: string
}

export interface ChatTitleUpdateMessage {
  type: 'chat_title_update'
  conversationId: string
  title: string
  timestamp: string
  projectId?: string
}

/** Live structured-draft update broadcast during an Explore Spec conversation. */
export interface SpecDraftUpdateMessage {
  type: 'spec_draft.update'
  conversationId: string
  draft: {
    title?: string
    description?: string
    labels?: string[]
    priority?: 'low' | 'medium' | 'high' | 'critical'
    acceptanceCriteria?: string[]
  }
  ready: boolean
  chips: string[]
  changedFields: string[]
  timestamp: string
  projectId?: string
}

// ─── App-level message types ──────────────────────────────────────────────────

export interface DesktopProjectsMessage {
  type: 'desktop.projects'
  projects: ProjectRow[]
  timestamp: string
}

export interface DesktopProjectAddedMessage {
  type: 'desktop.project_added'
  project: ProjectRow
  timestamp: string
}

export interface DesktopProjectRemovedMessage {
  type: 'desktop.project_removed'
  projectId: string
  timestamp: string
}

// ─── Setup message types ──────────────────────────────────────────────────────

export interface SetupLogMessage {
  type: 'setup_log'
  projectId: string
  line: string
  stream: 'stdout' | 'stderr'
}

export interface SetupCheckpointMessage {
  type: 'setup_checkpoint'
  projectId: string
  checkpoint: string
  status: 'running' | 'done'
  detail?: string
  duration_ms?: number
}

export interface SetupChatMessage {
  type: 'setup_chat'
  projectId: string
  text: string
  role: 'assistant' | 'user'
}

export interface SetupSummaryPayload {
  agents: number
  specrailsCommands: number
  opsxCommands: number
  personas: number
  legacySrRemoved: number
  tier: 'quick' | 'full'
}

export interface SetupInstallDoneMessage {
  type: 'setup_install_done'
  projectId: string
  timestamp: string
  summary?: SetupSummaryPayload
}

export interface SetupCompleteMessage {
  type: 'setup_complete'
  projectId: string
  sessionId?: string
  summary: SetupSummaryPayload
}

export interface SetupErrorMessage {
  type: 'setup_error'
  projectId: string
  error: string
}

export interface SetupTurnDoneMessage {
  type: 'setup_turn_done'
  projectId: string
  sessionId?: string
}

// ─── Proposal message types ───────────────────────────────────────────────────

export interface ProposalStreamMessage {
  type: 'proposal_stream'
  projectId: string
  proposalId: string
  delta: string
  timestamp: string
}

export interface ProposalReadyMessage {
  type: 'proposal_ready'
  projectId: string
  proposalId: string
  markdown: string
  timestamp: string
}

export interface ProposalRefinedMessage {
  type: 'proposal_refined'
  projectId: string
  proposalId: string
  markdown: string
  timestamp: string
}

export interface ProposalIssueCreatedMessage {
  type: 'proposal_issue_created'
  projectId: string
  proposalId: string
  issueUrl: string
  timestamp: string
}

export interface ProposalErrorMessage {
  type: 'proposal_error'
  projectId: string
  proposalId: string
  error: string
  timestamp: string
}

// ─── Agent refine (AI Edit for custom agents) message types ─────────────────

export type AgentRefinePhase =
  | 'idle'
  | 'reading'
  | 'drafting'
  | 'validating'
  | 'testing'
  | 'done'

export interface AgentRefineStreamMessage {
  type: 'agent_refine_stream'
  projectId: string
  refineId: string
  delta: string
  timestamp: string
}

export interface AgentRefinePhaseMessage {
  type: 'agent_refine_phase'
  projectId: string
  refineId: string
  phase: AgentRefinePhase
  timestamp: string
}

export interface AgentRefineReadyMessage {
  type: 'agent_refine_ready'
  projectId: string
  refineId: string
  draftBody: string
  timestamp: string
}

export interface AgentRefineTestMessage {
  type: 'agent_refine_test'
  projectId: string
  refineId: string
  result: { output: string; tokens: number; durationMs: number }
  timestamp: string
}

export interface AgentRefineErrorMessage {
  type: 'agent_refine_error'
  projectId: string
  refineId: string
  error: string
  timestamp: string
}

export interface AgentRefineCancelledMessage {
  type: 'agent_refine_cancelled'
  projectId: string
  refineId: string
  timestamp: string
}

export interface AgentRefineAppliedMessage {
  type: 'agent_refine_applied'
  projectId: string
  refineId: string
  agentId: string
  version: number
  timestamp: string
}

// ─── Job Templates ────────────────────────────────────────────────────────────

export interface JobTemplate {
  id: string
  name: string
  description: string | null
  commands: string[]
  created_at: string
  updated_at: string
}

// ─── Spec Launcher message types ─────────────────────────────────────────────

export interface SpecLauncherStreamMessage {
  type: 'spec_launcher_stream'
  projectId: string
  launchId: string
  delta: string
  timestamp: string
}

export interface SpecLauncherDoneMessage {
  type: 'spec_launcher_done'
  projectId: string
  launchId: string
  changeId: string | null
  timestamp: string
}

export interface SpecLauncherErrorMessage {
  type: 'spec_launcher_error'
  projectId: string
  launchId: string
  error: string
  timestamp: string
}

// ─── Ticket message types ────────────────────────────────────────────────────

export interface LocalTicket {
  id: number
  title: string
  description: string
  status: 'draft' | 'todo' | 'in_progress' | 'on_review' | 'done' | 'cancelled'
  priority: 'critical' | 'high' | 'medium' | 'low'
  labels: string[]
  assignee: string | null
  prerequisites: number[]
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  created_by: string
  source: string
  /** App-managed: a job that had already marked this spec `done` then failed —
   *  the spec stays in Done but the board flags it for review. See ticket-store. */
  needs_review?: boolean
}

export interface TicketCreatedMessage {
  type: 'ticket_created'
  projectId: string
  ticket: LocalTicket
  timestamp: string
}

export interface TicketUpdatedMessage {
  type: 'ticket_updated'
  projectId: string
  ticket: LocalTicket
  timestamp: string
}

export interface TicketDeletedMessage {
  type: 'ticket_deleted'
  projectId: string
  ticketId: number
  timestamp: string
}

export interface TicketAiEditStreamMessage {
  type: 'ticket_ai_edit_stream'
  projectId: string
  ticketId: number
  requestId: string
  delta: string
  timestamp: string
}

export interface TicketAiEditDoneMessage {
  type: 'ticket_ai_edit_done'
  projectId: string
  ticketId: number
  requestId: string
  fullText: string
  timestamp: string
}

export interface TicketAiEditErrorMessage {
  type: 'ticket_ai_edit_error'
  projectId: string
  ticketId: number
  requestId: string
  error: string
  timestamp: string
}

export interface SpecGenStreamMessage {
  type: 'spec_gen_stream'
  projectId: string
  requestId: string
  delta: string
  timestamp: string
}

export interface SpecGenDoneMessage {
  type: 'spec_gen_done'
  projectId: string
  requestId: string
  ticket: LocalTicket
  timestamp: string
}

export interface SpecGenErrorMessage {
  type: 'spec_gen_error'
  projectId: string
  requestId: string
  error: string
  timestamp: string
}

// ─── Cost alert message types ─────────────────────────────────────────────────

export interface CostAlertMessage {
  type: 'cost_alert'
  projectId: string
  jobId: string
  cost: number
  threshold: number
}

export interface DailyBudgetExceededMessage {
  type: 'daily_budget_exceeded'
  projectId: string
  dailySpend: number
  budget: number
  queuePaused: boolean
}

export interface DesktopDailyBudgetExceededMessage {
  type: 'desktop_daily_budget_exceeded'
  projectId: string
  desktopDailySpend: number
  desktopBudget: number
  queuePaused: boolean
}

export interface PipelineStatusMessage {
  type: 'pipeline_status'
  pipelineId: string
  status: 'running' | 'completed' | 'failed'
  projectId?: string
}

export interface RailJobStartedMessage {
  type: 'rail.job_started'
  projectId: string
  railIndex: number
  jobId: string
  mode: string
}

export interface RailJobStoppedMessage {
  type: 'rail.job_stopped'
  projectId: string
  railIndex: number
  jobId: string
}

export interface RailJobCompletedMessage {
  type: 'rail.job_completed'
  projectId: string
  railIndex: number
  jobId: string
  status: string
  ticketIds: number[]
}

/**
 * The per-run worktree OVERLAY (worktree-overlay.ts) degraded while
 * materializing the framework surface into an isolated rail worktree — the run
 * proceeds, but native `/specrails:*` commands / sr-* agents may be missing.
 * Stderr-style: surfaced so the user can see WHY commands were unavailable.
 */
export interface RailOverlayDegradedMessage {
  type: 'rail.overlay_degraded'
  projectId: string
  railIndex: number
  ticketId: number
  /** Human-readable entry-level failures from the overlay pass. */
  warnings: string[]
}

/**
 * The pre-worktree `git fetch origin` degraded (fetch failed, no remote, or
 * the resolved integration branch has no remote-tracking counterpart) — the
 * launch proceeds using today's bare local branch name as `baseRef` instead
 * of the freshly-fetched `origin/<branch>`. Non-fatal, stderr-style: surfaced
 * so the user can see the worktree may be rooted at a stale local commit.
 * Fired ONCE per launch (the shared integration-branch resolution), not per
 * ticket/unit.
 */
export interface RailFetchDegradedMessage {
  type: 'rail.fetch_degraded'
  projectId: string
  railIndex: number
  /** Human-readable reason the remote-tracking ref wasn't used. */
  warning: string
}

/** Per-ticket progress of an isolated rail's worktree fan-out / merge-back. */
export interface RailWorktreeProgressMessage {
  type: 'rail.worktree_progress'
  projectId: string
  railIndex: number
  ticketId: number
  /** Fan-out / merge-back state for this ticket's isolated run. */
  state: 'building' | 'built' | 'merging' | 'merged' | 'needs-review' | 'failed'
}

/**
 * Durable snapshot of an isolated rail launch's ask-first PR decision
 * (safe-pr-review-flow, backed by the `rail_pr_deliveries` row). Broadcast on
 * every mutation of the row — INSERT at launch (`building`), build-settle
 * (`on_review` / auto-`discarded`) and each decision-endpoint transition —
 * carrying the whole snapshot so receivers need no follow-up fetch (the
 * RailUpdatedMessage convention). Replaces the retired one-shot
 * `rail.pr_delivered` event.
 */
export interface RailPrStateMessage {
  type: 'rail.pr_state'
  projectId: string
  railIndex: number
  prDeliveryId: string
  railKey: string
  ticketIds: number[]
  baseBranch: string
  /** The assembled/delivered head branch (null until a Create-PR ran). */
  branch: string | null
  prUrl: string | null
  prNumber: number | null
  /** How far a Create-PR attempt got (the pr-publisher degradation ladder). */
  prState: 'none' | 'local-only' | 'pushed' | 'pr-created'
  decision: 'building' | 'on_review' | 'no_changes' | 'pr_draft' | 'pr_ready' | 'pr_closed' | 'completed' | 'merged' | 'discarded' | 'superseded' | 'implementation_failed' | 'pr_failed'
  implementationOutcome: 'running' | 'succeeded' | 'partially_succeeded' | 'failed' | 'unknown'
  deliveryOutcome: 'pending' | 'ready' | 'delivered' | 'partial' | 'no_changes' | 'retryable_failure' | 'blocked' | 'not_started' | 'unknown'
  statusCode: string | null
  statusDetail: string | null
  deliverySha: string | null
  isContinuation: boolean
  supersedesDeliveryId: string | null
  /** Explicit allocation rollback: this active generation was restored after
   * the referenced replacement generation failed. */
  restoredFromDeliveryId: string | null
  operation: 'create-pr' | 'publish' | 'discard' | 'dismiss' | 'poll-merge' | 'reopen' | 'merge-local' | 'acknowledge-no-changes' | null
  cleanupWarnings: string[]
  safetyArchives: string[]
  units: Array<{
    ticketId: number
    branch: string
    succeeded: boolean
    runId?: string
    implementationOutcome?: 'succeeded' | 'failed'
    deliveryOutcome?: 'ready' | 'no_changes' | 'blocked' | 'not_started'
    initialSha?: string | null
    finalSha?: string | null
    changed?: boolean
    failureCode?: string | null
    branchOwnership?: 'created' | 'preexisting' | 'borrowed-pr'
  }>
  /** The launch's loop-run ids, in ticket order ([] until allocation lands) —
   *  each links a per-run log (JobDetailModal) + live vitals on the decision
   *  surfaces. */
  runIds: string[]
  /** Generation ordering evidence used to reject late snapshots from an older
   * delivery on the same rail. */
  createdAt?: string
  updatedAt?: string
  /** The launching agent-chat conversation, null for dashboard launches. */
  originConversationId: string | null
}

/**
 * A rail's configuration changed (ticket assignments, name, mode, profile or
 * engine) via a non-launch mutation. Broadcast so every connected client
 * (desktop dashboard + mobile companion) reflects the change live. Carries the
 * full post-mutation rail snapshot so receivers need no follow-up fetch.
 */
/**
 * A dynamic rail was deleted (DELETE /rails/:railIndex). Broadcast so every
 * connected client drops the slot from its board. Only ever emitted for a rail
 * that passed the delete guards (empty, idle, no pending PR decision).
 */
export interface RailRemovedMessage {
  type: 'rail.removed'
  projectId: string
  railIndex: number
}

export interface RailUpdatedMessage {
  type: 'rail.updated'
  projectId: string
  railIndex: number
  /** Which field this mutation changed. Receivers that keep local un-synced
   *  state (the desktop dashboard) adopt `ticketIds` ONLY when changed==='tickets',
   *  so a rename never clobbers a rail's locally-dragged assignments. */
  changed: 'tickets' | 'name' | 'profile' | 'engine'
  ticketIds: number[]
  name: string | null
  mode: string
  profileName: string | null
  aiEngine: string | null
}

// ── Loop run lifecycle (the Loops feature) ───────────────────────────────────
// A loop run is driven by the app-side LoopRunManager (NOT the job queue), so it
// has its own lifecycle events, mirroring rail.job_* but keyed by loopRunId.

export interface LoopRunStartedMessage {
  type: 'loop.run_started'
  projectId: string
  loopRunId: string
  loopId: string
  railIndex: number | null
}

export interface LoopRunProgressMessage {
  type: 'loop.run_progress'
  projectId: string
  loopRunId: string
  iteration: number
  /** Id of the node currently executing. */
  activeNode: string
  /** The Loop Decider's latest reasoning, present on decision steps. */
  reasoning?: string
}

export interface LoopRunPausedMessage {
  type: 'loop.run_paused'
  projectId: string
  loopRunId: string
  railIndex: number | null
  reason: string
  ticketIds: number[]
}

export interface LoopRunResumedMessage {
  type: 'loop.run_resumed'
  projectId: string
  loopRunId: string
  railIndex: number | null
  ticketIds: number[]
}

export interface LoopRunStoppedMessage {
  type: 'loop.run_stopped'
  projectId: string
  loopRunId: string
  railIndex: number | null
}

export interface LoopRunCompletedMessage {
  type: 'loop.run_completed'
  projectId: string
  loopRunId: string
  railIndex: number | null
  /** Final outcome: 'success' | 'max-iterations' | 'max-cost' | 'stopped' | 'failed'. */
  status: string
  ticketIds: number[]
}

// ─── Plugin system ──────────────────────────────────────────────────────────

export interface PluginRequirement {
  /** Tool name as the prerequisites detector recognizes it (e.g., "uv"). */
  name: string
  /** Optional minimum semver. */
  minVersion?: string
}

export interface PluginOwnership {
  /** Keys claimed under `mcpServers` in `<project>/.mcp.json`. */
  mcpServers?: string[]
  /** Project-relative paths the plugin is exclusively allowed to write. */
  agentFragments?: string[]
  /** Reserved for future per-plugin config keys (not used in v1). */
  configKeys?: string[]
}

export interface PluginManifest {
  /** kebab-case unique id. */
  name: string
  version: string
  description: string
  /** Bullets shown on the marketplace card. */
  whatItDoes: string[]
  /** Optional category tag for grouping in the UI. */
  category?: string
  /** Executable prerequisites (e.g., uv >= 0.1). */
  requirements?: PluginRequirement[]
  /** Files / keys the plugin is allowed to mutate. Used for conflict detection. */
  owns: PluginOwnership
  /** Optional override for the verify-timeout (ms). Default 2000ms. */
  verifyTimeoutMs?: number
  /** Optional per-platform notes shown in the install dialog. Keys are
   *  `<platform>-<arch>` (e.g., `darwin-arm64`, `win32-x64`, `linux-x64`). */
  platformNotes?: Partial<Record<string, string>>
  /** Optional Markdown block appended (under marker comments) to the
   *  project's top-level instructions file when the plugin is active.
   *  Targets `CLAUDE.md` on claude projects and `AGENTS.md` on codex projects
   *  (resolved via the adapter's `instructionsFilename`). The block is
   *  removed on uninstall and on deactivate; any user content outside the
   *  markers is preserved byte-identical. The field name retains the
   *  historical `claudeMd` prefix for backwards compatibility; new plugins
   *  SHOULD treat it as provider-neutral. */
  claudeMdInstructions?: string
  /** Per-provider support descriptor. When present, controls how the plugin
   *  is installed for each provider (declarative MCP entry for the
   *  `project-json` registration mode, imperative command for `cli-add`).
   *  Plugins that omit this map are treated as claude-only and surface as
   *  `not-applicable` on codex projects. */
  providerSupport?: PluginProviderSupportMap
}

/** Provider-specific install descriptors, keyed by provider id. */
export type PluginProviderSupportMap = {
  [providerId: string]: PluginProviderSupportEntry
}

/** Per-provider install descriptor. At least one of `mcpEntry` or `install`
 *  SHOULD be present so the manager knows how to register the plugin for
 *  that provider. */
export interface PluginProviderSupportEntry {
  /** Declarative MCP entry. Used by `project-json` providers (claude) for the
   *  surgical `.mcp.json` merge; codex (`cli-add` mode) maps it to the
   *  `codex mcp add <name> -- <command> <args...>` invocation. */
  mcpEntry?: {
    command: string
    args: string[]
    env?: Record<string, string>
  }
}

/**
 * Provided to a plugin's lifecycle methods. The plugin is expected to record
 * every file it creates or modifies via `recordInstalledFile` so uninstall can
 * clean up surgically and so install rollback is deterministic.
 */
export interface PluginLifecycleContext {
  projectPath: string
  projectId: string
  /** Canonical ProjectRegistry slug — the SAME slug every other per-project
   *  `~/.specrails/projects/<slug>/` path uses (codex-home etc.). Plugins MUST
   *  prefer this over deriving a slug from the path basename, which collides
   *  between same-basename projects and points CODEX_HOME at the wrong dir. */
  slug?: string
  /** Provider id of the project the install is targeting. Plugins use this
   *  to decide between the project-json MCP merge path (claude) and the
   *  `<binary> mcp add` cli-add path (codex). Optional for backwards compat;
   *  pre-multi-provider plugins treat it as `'claude'`. */
  providerId?: string
  /** Append a project-relative path that this install created/modified. */
  recordInstalledFile(relativePath: string): void
  /** Append a log line — surfaced to the install dialog over the WS. */
  log(line: string): void
}

export interface PluginVerifyResult {
  ok: boolean
  reason?: string
  /** ISO-8601 timestamp when this verify ran. */
  checkedAt: string
}

export interface PluginPreviewFileEntry {
  path: string
  op: 'create' | 'modify'
  /** Optional human-readable summary of the change (e.g., "+ mcpServers.serena"). */
  summary?: string
}

export interface PluginPreviewResult {
  pluginName: string
  files: PluginPreviewFileEntry[]
  /** Prerequisites status at preview time, mirroring setup-prerequisites shape. */
  requirements: Array<{
    name: string
    installed: boolean
    executable: boolean
    version?: string
    meetsMinimum: boolean
  }>
  /** Platform-specific note for the user's host (resolved server-side). */
  platformNote?: string
}

/** Plugin module value: manifest + lifecycle implementations. */
export interface Plugin {
  manifest: PluginManifest
  install(ctx: PluginLifecycleContext): Promise<void>
  uninstall(ctx: PluginLifecycleContext): Promise<void>
  verify(ctx: Pick<PluginLifecycleContext, 'projectPath' | 'projectId'>): Promise<PluginVerifyResult>
  /** Optional. Drives the diff preview UI; falls back to a derived preview. */
  previewInstall?(ctx: Pick<PluginLifecycleContext, 'projectPath' | 'projectId'>): Promise<PluginPreviewFileEntry[]>
  /** Optional. Returns the canonical mcpServers entry value the plugin would
   *  write today. Used for drift detection (manifest vs. on-disk). When the
   *  plugin owns multiple mcpServers, callers may use the same entry for all
   *  or supply a richer keyed structure in a future revision. */
  expectedMcpEntry?(): Record<string, unknown>
}

export interface PluginStateEntry {
  version: string
  installedAt: string
  installedFiles: string[]
  /** Last verify result captured by the manager (cache). */
  health?: 'ok' | 'degraded' | 'unknown'
  healthReason?: string
}

export interface PluginState {
  schemaVersion: 1
  plugins: Record<string, PluginStateEntry>
}

export type PluginCardStatus =
  | 'installed'           // installed + activated (app-managed Claude approval)
  | 'deactivated'         // installed but user toggled off → Claude no longer loads
  | 'not-installed'
  | 'orphan'              // state.json entry but no plugin in registry
  | 'degraded'            // installed but verify failed
  | 'not-applicable'      // plugin lacks providerSupport for the project's provider

export interface PluginCatalogEntry {
  name: string
  version: string
  description: string
  whatItDoes: string[]
  category?: string
  requirements: PluginRequirement[]
  owns: PluginOwnership
  status: PluginCardStatus
  installedAt?: string
  health?: 'ok' | 'degraded' | 'unknown'
  healthReason?: string
  /** Claude marketplace plugin keys (e.g., `serena@claude-plugins-official`)
   *  currently enabled that shadow this plugin's MCP server. When non-empty,
   *  the user has the plugin globally and the app's project-scoped install
   *  is redundant; UI surfaces a "Disable global" affordance. */
  marketplaceConflicts?: string[]
  /** Marketplace keys that are physically installed in Claude's plugin cache
   *  but NOT enabled. Claude may still resolve the server from the cached
   *  `.mcp.json`, masking the project-scoped install. UI surfaces a hint to
   *  uninstall the marketplace plugin via Claude's own command. */
  marketplaceCachedButDisabled?: string[]
  /** True when the project's `.mcp.json` entry for this plugin no longer
   *  matches the bundled manifest (e.g., upstream renamed the binary). UI
   *  surfaces an "Update" affordance. */
  updateAvailable?: boolean
}

// ─── Plugin WS messages ─────────────────────────────────────────────────────

export interface PluginInstalledMessage {
  type: 'plugin.installed'
  projectId: string
  name: string
  version: string
  timestamp: string
}

export interface PluginUninstalledMessage {
  type: 'plugin.uninstalled'
  projectId: string
  name: string
  timestamp: string
}

export interface PluginHealthChangedMessage {
  type: 'plugin.health_changed'
  projectId: string
  name: string
  status: 'ok' | 'degraded' | 'unknown'
  reason?: string
  timestamp: string
}

export interface PluginDegradedMessage {
  type: 'plugin.degraded'
  projectId: string
  name: string
  reason: string
  jobId?: string
  timestamp: string
}

export interface PluginInstallProgressMessage {
  type: 'plugin.install_progress'
  projectId: string
  name: string
  line: string
  timestamp: string
}

export interface PluginPrereqInstallProgressMessage {
  type: 'plugin.prereq_install_progress'
  projectId: string
  prereq: string
  line: string
  timestamp: string
}

export interface PluginPrereqInstalledMessage {
  type: 'plugin.prereq_installed'
  projectId: string
  prereq: string
  ok: boolean
  reason?: string
  timestamp: string
}

export type BackgroundProcessStatus = 'starting' | 'running' | 'exited' | 'killed' | 'failed'

export interface BackgroundProcess {
  pid: number
  command: string
  cwd: string
  startedAt: number
  status: BackgroundProcessStatus
  chatId: string
  projectId: string
  exitCode?: number | null
  signal?: string | null
}

export interface BackgroundProcessStartedMessage {
  type: 'background_process.started'
  process: BackgroundProcess
  timestamp: string
  projectId: string
}

export interface BackgroundProcessOutputMessage {
  type: 'background_process.output'
  pid: number
  chatId: string
  projectId: string
  source: 'stdout' | 'stderr'
  line: string
  timestamp: string
}

export interface BackgroundProcessExitedMessage {
  type: 'background_process.exited'
  process: BackgroundProcess
  timestamp: string
  projectId: string
}

export type WsMessage =
  | LogMessage | PhaseMessage | InitMessage | QueueMessage | EventMessage
  | ChatStreamMessage | ChatDoneMessage | ChatErrorMessage
  | ChatCommandProposalMessage | ChatTitleUpdateMessage
  | SpecDraftUpdateMessage
  | DesktopProjectsMessage | DesktopProjectAddedMessage | DesktopProjectRemovedMessage
  | SetupLogMessage | SetupCheckpointMessage | SetupChatMessage
  | SetupInstallDoneMessage | SetupCompleteMessage | SetupErrorMessage
  | SetupTurnDoneMessage
  | ProposalStreamMessage | ProposalReadyMessage | ProposalRefinedMessage
  | ProposalIssueCreatedMessage | ProposalErrorMessage
  | SpecLauncherStreamMessage | SpecLauncherDoneMessage | SpecLauncherErrorMessage
  | CostAlertMessage | DailyBudgetExceededMessage | DesktopDailyBudgetExceededMessage
  | PipelineStatusMessage
  | TicketCreatedMessage | TicketUpdatedMessage | TicketDeletedMessage
  | TicketAiEditStreamMessage | TicketAiEditDoneMessage | TicketAiEditErrorMessage
  | SpecGenStreamMessage | SpecGenDoneMessage | SpecGenErrorMessage
  | RailJobStartedMessage | RailJobStoppedMessage | RailJobCompletedMessage | RailUpdatedMessage | RailRemovedMessage | RailWorktreeProgressMessage | RailOverlayDegradedMessage | RailFetchDegradedMessage | RailPrStateMessage
 | LoopRunStartedMessage | LoopRunProgressMessage | LoopRunPausedMessage | LoopRunResumedMessage | LoopRunStoppedMessage | LoopRunCompletedMessage
  | AgentRefineStreamMessage | AgentRefinePhaseMessage | AgentRefineReadyMessage
  | AgentRefineTestMessage | AgentRefineErrorMessage | AgentRefineCancelledMessage
  | AgentRefineAppliedMessage
  | PluginInstalledMessage | PluginUninstalledMessage
  | PluginHealthChangedMessage | PluginDegradedMessage
  | PluginInstallProgressMessage
  | PluginPrereqInstallProgressMessage | PluginPrereqInstalledMessage
  | BackgroundProcessStartedMessage | BackgroundProcessOutputMessage | BackgroundProcessExitedMessage
  | SpendingInvalidatedMessage
  | JobTurnUserMessage | JobTurnDoneMessage | JobFinalizedMessage
  | JobInteractiveMessage
  | SmashStartedMessage | SmashProgressMessage | SmashCompletedMessage
  | SmashFailedMessage | SmashUndoneMessage
  | FileProvenanceUpdatedMessage
  | FileSummaryUpdatedMessage | FileSummaryFailedMessage | FileSummarySkippedMessage
  | FileStoryUpdatedMessage
  | MobilePairRequestedMessage | MobileDevicePairedMessage
  | MobileDeviceRevokedMessage | MobileGatewayStateMessage
  | JiraSyncedMessage | JiraSyncErrorMessage | JiraAuthExpiredMessage
  | JiraOutboxChangedMessage | JiraDegradedMessage
  | AgentStreamMessage | AgentDoneMessage | AgentErrorMessage | AgentToolMessage
  | AgentTitleMessage
  | AgentQueuedMessage | AgentDequeuedMessage | AgentQueueClearedMessage
  | AgentQueueEditedMessage
  | AgentPrDecisionMessage

// ─── App-global agent chat (no projectId — fans to all subscribers) ───────────

/** A text delta from the agent's current turn. */
export interface AgentStreamMessage {
  type: 'agent_stream'
  conversationId: string
  delta: string
  timestamp: string
}

/** Auto-generated conversation title (from the first two user prompts). */
export interface AgentTitleMessage {
  type: 'agent_title'
  conversationId: string
  title: string
  timestamp: string
}

/** The agent's turn finished; `fullText` is the persisted assistant message. */
export interface AgentDoneMessage {
  type: 'agent_done'
  conversationId: string
  fullText: string
  timestamp: string
}

/** The agent's turn failed (spawn error / non-zero exit / busy). */
export interface AgentErrorMessage {
  type: 'agent_error'
  conversationId: string
  error: string
  timestamp: string
}

/** The agent invoked a tool — drives the live tool-card in the panel. */
export interface AgentToolMessage {
  type: 'agent_tool'
  conversationId: string
  tool: string
  timestamp: string
}

export interface AgentContextRefMessage {
  kind: string
  id: string
  label: string
  token: string
  scope?: {
    projectId?: string | null
    projectName?: string | null
  }
  status?: string | null
  metadata?: Record<string, unknown>
}

/** A message sent mid-turn was queued; it runs after the current turn settles. */
export interface AgentQueuedMessage {
  type: 'agent_queued'
  conversationId: string
  /** Client-generated correlation id (null when the sender didn't provide one). */
  queueId: string | null
  text: string
  contextRefs?: AgentContextRefMessage[]
  position: number
  timestamp: string
}

/** A queued message left the queue and its turn is starting now. */
export interface AgentDequeuedMessage {
  type: 'agent_dequeued'
  conversationId: string
  queueId: string | null
  text: string
  contextRefs?: AgentContextRefMessage[]
  timestamp: string
}

/** The pending queue was discarded (abort or conversation deletion). */
export interface AgentQueueClearedMessage {
  type: 'agent_queue_cleared'
  conversationId: string
  timestamp: string
}

/** A queued (not yet dispatched) message was edited in place. */
export interface AgentQueueEditedMessage {
  type: 'agent_queue_edited'
  conversationId: string
  queueId: string
  text: string
  contextRefs?: AgentContextRefMessage[]
  timestamp: string
}

/**
 * The persisted content of an agent-chat PR-decision card (safe-pr-review-flow):
 * a `system`-role `agent_messages` row whose content is this JSON envelope, so
 * the inline card survives refresh and cold-load renders the current state.
 * `prDeliveryId` links the card to its authoritative `rail_pr_deliveries` row —
 * decision mutations update the SAME card in place.
 */
export interface PrDecisionCardEnvelope {
  kind: 'pr_decision'
  prDeliveryId: string
  railIndex: number
  projectId: string
  baseBranch: string
  ticketIds: number[]
  decision: 'building' | 'on_review' | 'no_changes' | 'pr_draft' | 'pr_ready' | 'pr_closed' | 'completed' | 'merged' | 'discarded' | 'superseded' | 'implementation_failed' | 'pr_failed'
  implementationOutcome: 'running' | 'succeeded' | 'partially_succeeded' | 'failed' | 'unknown'
  deliveryOutcome: 'pending' | 'ready' | 'delivered' | 'partial' | 'no_changes' | 'retryable_failure' | 'blocked' | 'not_started' | 'unknown'
  statusCode: string | null
  statusDetail: string | null
  deliverySha: string | null
  isContinuation: boolean
  supersedesDeliveryId: string | null
  restoredFromDeliveryId: string | null
  operation: 'create-pr' | 'publish' | 'discard' | 'dismiss' | 'poll-merge' | 'reopen' | 'merge-local' | 'acknowledge-no-changes' | null
  cleanupWarnings: string[]
  safetyArchives: string[]
  units: Array<{
    ticketId: number
    branch: string
    succeeded: boolean
    runId?: string
    implementationOutcome?: 'succeeded' | 'failed'
    deliveryOutcome?: 'ready' | 'no_changes' | 'blocked' | 'not_started'
    initialSha?: string | null
    finalSha?: string | null
    changed?: boolean
    failureCode?: string | null
    branchOwnership?: 'created' | 'preexisting' | 'borrowed-pr'
  }>
  prUrl: string | null
  prNumber: number | null
  prState: 'none' | 'local-only' | 'pushed' | 'pr-created'
  branch: string | null
  /** The launch's loop-run ids, in ticket order ([] until allocation lands) —
   *  the card renders one "View log" chip (JobDetailModal + live vitals) per run. */
  runIds: string[]
  createdAt?: string
  updatedAt?: string
}

/**
 * A PR-decision card was posted or updated in an agent-chat conversation.
 * App-global like every `agent_*` event (no projectId filtering — the envelope's
 * `projectId` identifies the rail's project, it is card data, not WS routing).
 */
export interface AgentPrDecisionMessage extends PrDecisionCardEnvelope {
  type: 'agent_pr_decision'
  conversationId: string
  timestamp: string
}

/** Inbound poll completed: N issues materialized into the local cache. */
export interface JiraSyncedMessage {
  type: 'jira.synced'
  projectId: string
  upserted: number
  at: number
}

/** A poll or drain hit a non-fatal error (surfaced as a toast). */
export interface JiraSyncErrorMessage {
  type: 'jira.sync_error'
  projectId: string
  reason: string
}

/** The project's token returned 401 — outbox paused, re-auth required. */
export interface JiraAuthExpiredMessage {
  type: 'jira.auth_expired'
  projectId: string
  pending: number
}

/** Outbox state changed (drain/enqueue/dead-letter) — dashboards refetch. */
export interface JiraOutboxChangedMessage {
  type: 'jira.outbox_changed'
  projectId: string
  pending: number
  dead: number
}

/** An outbound op was dead-lettered (workflow gap / required field / 403). */
export interface JiraDegradedMessage {
  type: 'jira.degraded'
  projectId: string
  jiraKey: string | null
  reason: string
}

export interface FileProvenanceUpdatedMessage {
  type: 'file.provenance_updated'
  projectId: string
  path: string
  kind: 'created' | 'modified' | 'deleted'
  ticketId: number | null
  jobId: string | null
  at: number
}

export interface FileSummaryUpdatedMessage {
  type: 'file.summary_updated'
  projectId: string
  path: string
  summaryAvailable: boolean
  stale: boolean
  generatedAt: string | null
}

export interface FileSummaryFailedMessage {
  type: 'file.summary_failed'
  projectId: string
  path: string
  reason: string
}

/** Construction story: an intervention's AI contribution paragraph was
 *  generated (or failed). Clients viewing that file refetch the story. */
export interface FileStoryUpdatedMessage {
  type: 'file.story_updated'
  projectId: string
  path: string
  provenanceId: number
  ok: boolean
  reason?: string
}

export interface FileSummarySkippedMessage {
  type: 'file.summary_skipped'
  projectId: string
  path: string
  reason: 'budget' | 'per-job-cap' | 'ttl' | 'not-found'
}

export interface SpendingInvalidatedMessage {
  type: 'spending.invalidated'
  projectId: string
}

// ─── Interactive freestyle jobs ───────────────────────────────────────────────
// Desktop-only; the mobile gateway's topicFor() returns null for any uncased
// type, so these never reach a phone (frozen v1 wire contract preserved).

/** One user prompt was accepted for an interactive job (echo so the in-job chat
 *  can render the user bubble immediately, before the agent responds). When a
 *  turn is already streaming, `queued` is true (the prompt runs after it). */
export interface JobTurnUserMessage {
  type: 'job.turn_user'
  projectId: string
  jobId: string
  text: string
  queued: boolean
  timestamp: string
}

/** An interactive job's turn finished streaming. Carries the running SUM of all
 *  completed turns' REAL usage (never an estimate) for the live token/cost meter. */
export interface JobTurnDoneMessage {
  type: 'job.turn_done'
  projectId: string
  jobId: string
  totals: {
    tokens_in: number
    tokens_out: number
    tokens_cache_read: number
    tokens_cache_create: number
    total_cost_usd: number
    num_turns: number
  }
  timestamp: string
}

/** Interactive availability flip for a job whose resident session comes and
 *  goes MID-RUN — a loop run's ai-step sessions (between steps / decider /
 *  shell nodes there is no session, so POST /messages would 409). QueueManager
 *  jobs never emit this: their session lives for the whole run, so the client
 *  derives availability from status + `interactive`. Desktop-only, like every
 *  job.turn_* message above (mobile topicFor() drops uncased types). */
export interface JobInteractiveMessage {
  type: 'job.interactive'
  projectId: string
  jobId: string
  /** True when a resident step session is accepting turns right now. */
  acceptingTurns: boolean
  /** Settle mode of the session that just started/settled (loops are 'auto'). */
  settleMode: 'finalize' | 'auto'
  timestamp: string
}

/** An interactive job was finalized (or crashed). Final authoritative totals +
 *  terminal status; the client stops the chat and shows the completed summary. */
export interface JobFinalizedMessage {
  type: 'job.finalized'
  projectId: string
  jobId: string
  status: JobStatus
  totals: {
    tokens_in: number
    tokens_out: number
    tokens_cache_read: number
    tokens_cache_create: number
    total_cost_usd: number
    num_turns: number
  }
  timestamp: string
}

// ─── Mobile companion (app-level, no projectId — desktop UI only) ─────────────
// These never reach a phone (the gateway WS bridge drops unknown types); they
// drive the live desktop pairing UI over the existing /ws.

export interface MobilePairRequestedMessage {
  type: 'mobile.pair_requested'
  deviceName: string
  platform: 'ios' | 'android' | 'web'
  timestamp: string
}

export interface MobileDevicePairedMessage {
  type: 'mobile.device_paired'
  deviceId: string
  name: string
  timestamp: string
}

export interface MobileDeviceRevokedMessage {
  type: 'mobile.device_revoked'
  deviceId: string
  timestamp: string
}

export interface MobileGatewayStateMessage {
  type: 'mobile.gateway_state'
  running: boolean
  port: number
  timestamp: string
}

// ─── SPECs SMASH ─────────────────────────────────────────────────────────────

export interface SmashStartedMessage {
  type: 'smash.started'
  projectId: string
  ticketId: number
  runId: string
  ticketTitle?: string
  timestamp: string
}

export interface SmashProgressMessage {
  type: 'smash.progress'
  projectId: string
  ticketId: number
  runId: string
  stage: 'analyzing' | 'identifying' | 'ordering'
  timestamp: string
}

export interface SmashCompletedMessage {
  type: 'smash.completed'
  projectId: string
  ticketId: number
  runId: string
  smashedAt: string
  childrenIds: number[]
  timestamp: string
}

export interface SmashFailedMessage {
  type: 'smash.failed'
  projectId: string
  ticketId: number
  runId: string
  reason: 'timeout' | 'model_error' | 'crashed' | 'invalid-output' | 'mutation-failed'
  detail?: string
  timestamp: string
}

export interface SmashUndoneMessage {
  type: 'smash.undone'
  projectId: string
  ticketId: number
  childrenIds: number[]
  timestamp: string
}
