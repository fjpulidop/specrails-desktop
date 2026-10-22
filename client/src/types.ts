import type { PrFollowUp, FollowUpReportLine } from './features/delivery/lib/pr-follow-up-scope'
import type { SpecAddendum, SpecAddendaSnapshotEntry, SpecAddendaReportLine } from './features/specs/lib/spec-addenda-core'
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'zombie_terminated' | 'skipped'

export type BackgroundProcessStatus = 'starting' | 'running' | 'stopping' | 'exited' | 'killed' | 'failed' | 'interrupted'

export interface BackgroundProcess {
  /** Stable execution identity; optional only for older server payloads. */
  processId?: string
  pid: number
  command: string
  cwd: string
  startedAt: number
  endedAt?: number
  stopRequestedAt?: number
  error?: string
  repositoryId?: string
  repositoryName?: string
  /** The Flow whose worktree this process runs in (Specrails stops it with the Flow). */
  flowId?: string
  recoveredAt?: number
  persistenceError?: string
  status: BackgroundProcessStatus
  chatId: string
  projectId: string
  exitCode?: number | null
  signal?: string | null
  /** Addresses a running app announced: `local` for this computer, `network`
   *  for a phone on the same Wi-Fi/VPN. Absent once it stops. */
  appUrls?: { local: string[]; network: string[] }
}

export type JobPriority = 'low' | 'normal' | 'high' | 'critical'

export interface PhaseDefinition {
  key: string
  label: string
  description: string
}

export interface JobSummary {
  id: string
  command: string
  /** Real provider execution start; null while the job is only admitted. */
  started_at: string | null
  /** Durable queue admission time, present for queued jobs. */
  enqueued_at?: string | null
  finished_at?: string | null
  status: JobStatus
  priority?: JobPriority
  total_cost_usd?: number | null
  /** 1 when total_cost_usd is a pricing-table estimate (codex), 0/absent when
   *  authoritative from the provider (claude). Drives the `~` cost badge. */
  total_cost_usd_estimated?: number | null
  duration_ms?: number | null
  /** Provider that executed this concrete job (null/absent on legacy rows). */
  provider?: string | null
  model?: string | null
  tokens_in?: number | null
  tokens_out?: number | null
  tokens_cache_read?: number | null
  tokens_cache_create?: number | null
  num_turns?: number | null
  depends_on_job_id?: string | null
  pipeline_id?: string | null
  skip_reason?: string | null
  /** True if a telemetry blob (active or compacted) exists for this job */
  hasTelemetry?: boolean
  /** Profile the job ran under (null/undefined = legacy mode) */
  profile_name?: string | null
  /** 1 when this is an interactive persistent session (the user can send more
   *  prompts while it runs); 0/absent for standard jobs. */
  interactive?: number | null
  /** Settle mode of the resident interactive session (GET /jobs/:id only):
   *  'finalize' = idles until the human Finalizes (freestyle); 'auto' = the job
   *  settles itself on quiescence (implement / loops — steering is optional).
   *  null/absent = no live session (finished, kill-switch off, legacy payload). */
  interactiveSettleMode?: 'finalize' | 'auto' | null
  /** True when a resident session is accepting turns RIGHT NOW. Loop runs flip
   *  this between ai-steps (no session ⇒ POST /messages would 409); live flips
   *  ride the `job.interactive` WS event. GET /jobs/:id only. */
  interactiveAcceptingTurns?: boolean
  /** True when a loop run is paused awaiting a human decision. GET /jobs/:id only. */
  loopPaused?: boolean
  /** Human-decision pause reason from the loop engine. GET /jobs/:id only. */
  loopPauseReason?: string | null
  pendingInterrupts?: Array<{id: string;nodePath: string;kind: 'question' | 'approval' | 'gate'; value?: unknown}>
  /**
   * Tickets referenced by the job's command, resolved against the project's
   * local ticket store at request time. Only populated by GET /jobs/:id;
   * undefined elsewhere. `title === null` means the ticket no longer exists.
   */
  tickets?: Array<{ id: number; title: string | null }>
}

export interface EventRow {
  id: number
  job_id: string
  seq: number
  event_type: string
  source?: string | null
  payload: string
  timestamp: string
}

export interface CommandInfo {
  id: string
  name: string
  description: string
  slug: string
  totalRuns?: number
  lastRunAt?: string | null
}

export interface ProjectConfig {
  project: {
    name: string
    repo: string | null
  }
  issueTracker: {
    github: { available: boolean; authenticated: boolean }
    jira: { available: boolean; authenticated: boolean }
    active: 'github' | 'jira' | null
    labelFilter: string
  }
  commands: CommandInfo[]
  dailyBudgetUsd: number | null
}

export interface IssueItem {
  number: number
  title: string
  labels: string[]
  body: string
  url?: string
}

export type AnalyticsPeriod = '7d' | '30d' | '90d' | 'all' | 'custom'

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

export interface DesktopProjectStats {
  projectId: string
  projectName: string
  totalCostUsd: number
  estimatedCostUsd?: number
  pricedRuns?: number
  unpricedRuns?: number
  totalJobs: number
  successRate: number
  avgDurationMs: number | null
}

export interface DesktopAnalyticsResponse {
  period: {
    label: string
    from: string | null
    to: string | null
  }
  kpi: {
    totalCostUsd: number
    estimatedCostUsd?: number
    includesEstimated?: boolean
    pricedRuns?: number
    unpricedRuns?: number
    totalJobs: number
    successRate: number
    costToday: number
    estimatedCostToday?: number
    pricedTodayRuns?: number
    unpricedTodayRuns?: number
    jobsToday: number
  }
  projectBreakdown: DesktopProjectStats[]
  costTimeline: Array<{
    date: string
    costUsd: number
    estimatedCostUsd?: number
    unpricedCount?: number
  }>
}

export interface ChatConversationSummary {
  id: string
  title: string | null
  model: string
  /** AI provider for this conversation. NULL on single-provider projects
   *  (legacy = claude); set to the selected engine on multi-provider projects. */
  provider?: string | null
  created_at: string
  updated_at: string
}

export interface ChatMessage {
  id: number
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

// ─── Trends ───────────────────────────────────────────────────────────────────

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
  status: string
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

// ─── Job Templates ────────────────────────────────────────────────────────────

export interface JobTemplate {
  id: string
  name: string
  description: string | null
  commands: string[]
  created_at: string
  updated_at: string
}

// ─── Rail PR decisions (safe-pr-review-flow) ─────────────────────────────────

/** Decision state of a rail's isolated-launch PR delivery (mirrors the server's
 *  rail_pr_deliveries.decision column). completed/merged/discarded/superseded
 *  are terminal. */
export type RailPrDecision =
  | 'building'
  | 'on_review'
  | 'pr_draft'
  | 'pr_ready'
  | 'no_changes'
  | 'completed'
  | 'pr_closed'
  | 'superseded'
  | 'merged'
  | 'discarded'
  | 'implementation_failed'
  | 'pr_failed'

/** How far a Create-PR attempt got (the pr-publisher degradation ladder). */
export type RailPrDeliveryState = 'none' | 'local-only' | 'pushed' | 'pr-created'

/** Actions accepted by POST /rails/pr-decision. */
export type RailPrDecisionAction = 'create-pr' | 'publish' | 'discard' | 'poll-merge' | 'merge-local' | 'dismiss' | 'reopen' | 'acknowledge-no-changes' | 'recover-and-retry'

/** Engine truth, deliberately independent from commit/push/PR delivery. */
export type RailImplementationOutcome = 'running' | 'succeeded' | 'partially_succeeded' | 'failed' | 'unknown'

/** Post-engine delivery truth. Additive/optional on legacy persisted rows. */
export type RailDeliveryOutcome =
  | 'pending'
  | 'ready'
  | 'delivered'
  | 'partial'
  | 'no_changes'
  | 'retryable_failure'
  | 'blocked'
  | 'not_started'
  | 'unknown'

/** Per-ticket/unit evidence retained by the delivery ledger. */
export interface RailPrUnitOutcome {
  ticketId: number
  branch: string
  /** Legacy compatibility bit; the orthogonal outcomes take precedence. */
  succeeded: boolean
  runId?: string | null
  implementationOutcome?: RailImplementationOutcome
  deliveryOutcome?: RailDeliveryOutcome
  initialSha?: string | null
  finalSha?: string | null
  changed?: boolean
  failureCode?: string | null
  branchOwnership?: 'created' | 'preexisting' | 'borrowed-pr'
  worktreePath?: string | null
}

/**
 * Durable snapshot of a rail launch's ask-first PR decision. The client keeps
 * one per railIndex (RailPrDecisionContext), hydrated from GET /rails
 * `prDeliveries` and updated by every `rail.pr_state` broadcast.
 */
export interface RailPrStateSnapshot {
  executionManifest?: import('./features/projects/types/multi-repo').RunExecutionManifest | null
  repositoryDeliveries?: import('./features/projects/types/multi-repo').RepositoryDeliverySnapshot[]
  prDeliveryId: string
  railIndex: number
  railKey: string
  ticketIds: number[]
  baseBranch: string
  /** The assembled/delivered head branch (null until a Create-PR ran). */
  branch: string | null
  prUrl: string | null
  prNumber: number | null
  prState: RailPrDeliveryState
  decision: RailPrDecision
  /** Orthogonal outcome axes; absent only on pre-migration snapshots. */
  implementationOutcome?: RailImplementationOutcome
  deliveryOutcome?: RailDeliveryOutcome
  /** Stable client-localized reason + bounded secondary diagnostic. */
  statusCode?: string | null
  statusDetail?: string | null
  /** Exact verified object used for an existing-PR push/retry. */
  deliverySha?: string | null
  /** Existing-PR generations borrow the PR/head and dismiss non-destructively. */
  isContinuation?: boolean
  supersedesDeliveryId?: string | null
  /** Explicit rollback lineage: this generation was restored because the
   * referenced replacement failed before allocation completed. */
  restoredFromDeliveryId?: string | null
  /** Leased in-flight decision-side effect owned by another surface/process. */
  operation?: RailPrDecisionAction | 'checkout' | null
  /** Bounded cleanup failures that remain after a terminal action. */
  cleanupWarnings?: string[]
  /** Persistent same-filesystem overlay archives retained outside the PR so
   * concurrent/open-descriptor writes always remain inspectable. */
  safetyArchives?: string[]
  /** Structured evidence; legacy snapshots may omit it. */
  units?: RailPrUnitOutcome[]
  /** The launch's loop-run ids, in ticket order ([] until allocation lands) —
   *  each links a per-run log + live vitals on the decision surfaces. */
  runIds: string[]
  /** The launching agent-chat conversation, null for dashboard launches. */
  originConversationId: string | null
  /** Reviewer risk brief summary (absent without a brief). */
  riskSummary?: PrDeliveryRiskSummary
  /** Flow → Spec stopped with requested changes (absent otherwise). */
  flowReview?: PrDeliveryFlowReview
  /** Durable generation ordering evidence for stale-snapshot arbitration. */
  createdAt?: string
  updatedAt?: string
}

/** Wire shape of the project-scoped `rail.pr_state` WS broadcast (mirrors
 *  server/types.ts RailPrStateMessage — replaces the retired rail.pr_delivered). */
export interface RailPrStateMessage extends RailPrStateSnapshot {
  type: 'rail.pr_state'
  projectId: string
}

// ─── Local Tickets ───────────────────────────────────────────────────────────

export type TicketStatus = 'draft' | 'todo' | 'in_progress' | 'on_review' | 'done' | 'cancelled'
export type TicketPriority = 'critical' | 'high' | 'medium' | 'low'

export interface Attachment {
  id: string
  filename: string
  storedName: string
  mimeType: string
  size: number
  addedAt: string
}

export interface LocalTicket {
  repositoryIds?: string[]
  id: number
  title: string
  description: string
  status: TicketStatus
  priority: TicketPriority | null
  labels: string[]
  assignee: string | null
  prerequisites: number[]
  metadata: {
    vpc_scores?: Record<string, unknown>
    effort_level?: string
    user_story?: string
    area?: string
    /** Escaped-defect link: id of the delivery that introduced this bug. */
    regressionOf?: string
    /** Flow mode: the placeholder spec of a Flow. `active`/`paused` show the
     *  board's "In Flow" label; `delivered` hides it. */
    flow?: {
      conversationId?: string
      flowId?: string
      state?: 'active' | 'paused' | 'delivered'
      startedAt?: string
      chosenMode?: 'flow' | 'implement'
    }
    /** Spec triage (launch-triage, schema 1.5): see features/specs/lib/spec-triage. */
    triage?: import('./features/specs/lib/spec-triage').SpecTriage
  }
  attachments?: Attachment[]
  origin_conversation_id?: string | null
  is_epic?: boolean
  parent_epic_id?: number | null
  execution_order?: number | null
  /** AI-generated short summary (≤240 chars). Shown in dashboard postit tier when non-null. */
  short_summary?: string | null
  created_at: string
  updated_at: string
  created_by: string
  source: 'manual' | 'product-backlog' | 'propose-spec' | 'get-backlog-specs' | 'explore-draft' | 'specs-smash' | 'free-prompt' | 'mcp' | 'jira' | 'project-builder' | 'flow' | 'rules'
  /** Display key of the linked Jira issue (e.g. "PROJ-123"), present only for Jira-sourced specs. */
  jira_key?: string | null
  /** Browser URL of the linked Jira issue. */
  jira_url?: string | null
  /** Key of the Jira parent epic (e.g. "PROJ-5"), when the issue has one. */
  jira_epic_key?: string | null
  /** Name of the Jira parent epic, when the issue has one. */
  jira_epic_name?: string | null
  /** Id of the issue's (active) Jira sprint, when it has one. */
  jira_sprint_id?: string | null
  /** Name of the issue's (active) Jira sprint, when it has one. */
  jira_sprint_name?: string | null
  /** State of that sprint: 'active' (current) | 'future' | 'closed'. */
  jira_sprint_state?: string | null
  /** RAW Jira workflow status name exactly as the board shows it (e.g. "Code
   *  Review"), refreshed on every inbound poll. Powers the board's Jira-status
   *  filter dimension. Distinct from `status` (the mapped logical state). */
  jira_status?: string | null
  /** Desktop-managed: set when a job that had already marked this spec `done` then
   *  failed/was canceled/zombie-killed. The board shows a "review" badge on the
   *  Done card. Cleared on the next clean completion. */
  needs_review?: boolean
  /** Spec addenda: structured iteration notes next to the description (see lib/spec-addenda-core). */
  addenda?: SpecAddendum[]
  /** Non-goals ("Out of scope", feedback-2026-10 task 3.2): shown under the
   *  description; absent on older tickets. */
  nonGoals?: string[]
}

// ─── Review packet (nontech-review-experience) ────────────────────────────────

/** Which story the packet tells; chosen server-side from durable outcomes. */
export type PacketVariant = 'success' | 'no-changes' | 'partial' | 'failed'

/**
 * Where a proof claim came from. The UI MUST label these differently: an
 * `ai-reported` item is the agent's own word, never a Specrails measurement.
 */
export type ProofTier = 'app-verified' | 'ai-reported' | 'reviewer-score'

export interface PacketProofItem {
  tier: ProofTier
  /** Stable machine key; all copy lives in the `packet` i18n namespace. */
  code: string
  values?: Record<string, string | number>
  /** Verbatim agent output — only ever rendered inside a labelled block. */
  rawExcerpt?: string
}

export interface PacketTicketSection {
  ticketId: number
  title: string | null
  problem: string | null
  solution: string | null
  /** Solution content beyond the visible digest (markdown). */
  solutionOverflow?: string | null
  labels: string[]
  implementationOutcome: string | null
  deliveryOutcome: string | null
  changed: boolean | null
  /** Null when a batch run's files cannot honestly be split per ticket. */
  churn: { filesTouched: number; addedLines: number; removedLines: number; testFilesTouched: string[] } | null
  runIds: string[]
}

export interface PacketConfidence {
  changeName: string | null
  overall: number | null
  aspects: Record<string, number>
  flags: string[]
}

/** One generation in the revision chain, oldest first. */
export interface PacketVersion {
  prDeliveryId: string
  version: number
  revisionNote: string | null
  decision: RailPrDecision
  costUsd: number | null
  costEstimated: boolean
  current: boolean
}

/** Advisory "this may have outgrown its spec" signal; never blocks a revision. */
export interface PacketDriftNudge {
  code: 'drift.costShare' | 'drift.outOfScopeChurn' | 'drift.revisionCount'
  values: Record<string, string | number>
}

export type ReviewRiskSeverity = 'high' | 'medium' | 'low'

/** Reviewer risk brief summary (Core `reviewBrief: 1`); mirrors server PrDeliveryRiskSummary. */
export interface PrDeliveryRiskSummary {
  highCount: number
  mediumCount: number
  lowCount: number
  top: { severity: ReviewRiskSeverity; area: string | null; whatToLookAt: string; ref: string | null } | null
  diagnostic: boolean
}

/** Flow → Spec stopped with requested changes; mirrors server PrDeliveryFlowReview.
 *  `review`: the latest review rejected the work; `check`: the host checks still fail. */
export interface PrDeliveryFlowReview {
  reason: 'review' | 'check'
  summary: string | null
  issues: string[]
  issuesOmitted: number
  score: number | null
  failingChecks: Array<{ command: string; exitCode: number | null }>
}

/** "What to look at": the reviewer's advisory brief merged across units (server PacketWhatToLookAt). */
export interface PacketWhatToLookAt {
  risks: Array<{ ticketId: number; severity: ReviewRiskSeverity; area: string | null; whatToLookAt: string; ref: string | null }>
  behaviourChanges: Array<{ ticketId: number; what: string; where: string | null; userVisible: boolean | null }>
  invariantsTouched: Array<{ ticketId: number; invariant: string; evidence: string | null; status: 'kept' | 'changed' | 'at-risk' | null }>
  untested: Array<{ ticketId: number; path: string; why: string | null }>
  humanChecks: Array<{ ticketId: number; text: string }>
  divergences: Array<{ ticketId: number; capability: string; requirement: string; observed: string }>
  diagnostics: Array<{ ticketId: number; message: string }>
  droppedEntries: number
}

export interface ReviewPacket {
  schemaVersion: 1
  prDeliveryId: string
  railIndex: number
  variant: PacketVariant
  decision: RailPrDecision
  statusCode: string | null
  headlineCode: string
  ticketIds: number[]
  baseBranch: string
  loopName: string
  prUrl: string | null
  prNumber: number | null
  succeededCount: number
  failedCount: number
  totalCount: number
  sections: PacketTicketSection[]
  proof: PacketProofItem[]
  watchOut: PacketProofItem[]
  confidence: PacketConfidence | null
  /** Reviewer risk brief; absent/null for runs without one (older Core). */
  whatToLookAt?: PacketWhatToLookAt | null
  /** Risk counts for this delivery; absent/null without a brief. */
  riskSummary?: PrDeliveryRiskSummary | null
  cost: { totalUsd: number | null; estimated: boolean }
  evidenceUnavailable: boolean
  runIds: string[]
  supersedesDeliveryId: string | null
  revisionNote: string | null
  /** The frozen PR review follow-up this generation ran with (pr-follow-up-fixes); null otherwise. */
  followUp: PrFollowUp | null
  /** The run's own per-comment report; null when it reported nothing (never a synthesised verdict). */
  followUpReport: FollowUpReportLine[] | null
  /** The frozen spec addenda this generation was launched with (spec-addenda); null when none. */
  specAddenda: SpecAddendaSnapshotEntry[] | null
  /** The run's own per-addendum report; null when it reported nothing. */
  specAddendaReport: SpecAddendaReportLine[] | null
  versions: PacketVersion[]
  chainCostUsd: number | null
  chainCostEstimated: boolean
  driftNudges: PacketDriftNudge[]
  /** "What the agent did" (agent actions audit); absent/null when nothing was recorded. */
  agentActions?: PacketAgentActions | null
  /** Flow -> Spec only: Core's derivation coverage; null for other loops (older servers omit it). */
  derivation?: PacketDerivation | null
  /** Flow deliveries only: settlement effects (spec rewrite, Jira). */
  flowSettlement?: PacketFlowSettlement | null
  /** "Requirements demonstrated X/Y" (Core specTrace); absent on older servers. */
  requirementsDemonstrated?: PacketRequirementsDemonstrated | null
  /** "Spec created where the work passed" (Core baselineOnTouch), one entry per unit. */
  baseline?: PacketBaseline[] | null
  /** "Needs human eyes": the project's human-only rules frozen at settle. */
  needsHumanEyes?: Array<{ text: string; source: string | null }> | null
}

export interface PacketTraceTestRef { file: string; line: number | null }

export interface PacketRequirementsDemonstrated {
  demonstrated: number
  total: number
  touched: number
  touchedDemonstrated: number
  demonstratedList: Array<{ ticketId: number; id: string; name: string; tests: PacketTraceTestRef[] }>
  undemonstratedList: Array<{ ticketId: number; id: string; name: string; reason: 'no-test' | 'not-executed' | 'failed'; touched: boolean }>
  untaggedList: Array<{ ticketId: number; tag: string; file: string; line: number | null }>
  withoutReceipt: boolean
}

export interface PacketBaseline {
  ticketId: number
  status: 'not-needed' | 'planned' | 'passed' | 'failed' | 'violated'
  change: string | null
  recordedAt: string | null
  uncovered: string[]
  covered: number
  tests: string[]
  receiptId: string | null
  reason: string | null
  capabilities: Array<{ capability: string; requirements: number; demonstrated: number }>
  cost: { invocations: number; costUsd: number | null; inputTokens: number | null; outputTokens: number | null } | null
}

export type AgentActionKind = 'read' | 'write' | 'exec' | 'mcp' | 'network'

export interface PacketAgentActions {
  counts: Record<AgentActionKind, number>
  total: number
  runIds: string[]
}

export type PacketDerivation =
  | {
    status: 'available'
    change: string | null
    files: number
    explained: number
    unexplainedFiles: string[]
    unexplainedOmitted: number
    confidence: 'high' | 'medium' | 'low' | null
    requirementsAdded: number
    requirementsModified: number
    tasks: number
    transcriptTurnsUsed: number
  }
  | { status: 'unavailable' }

export type FlowSettlementEffectState = 'pending' | 'done' | 'skipped' | 'failed'
export interface PacketFlowSettlement {
  specRewrite: FlowSettlementEffectState | null
  jiraCreate: FlowSettlementEffectState | null
  jiraReview: FlowSettlementEffectState | null
}

/** Pre-resolved meaning of Accept for this repo (server-probed, fail-closed). */
export interface AcceptCapability {
  target: 'create-pr' | 'merge-local'
  hasRemote: boolean
  ghAuthenticated: boolean
  irreversible: boolean
  reasonCode: 'pr-capable' | 'no-remote' | 'gh-unauthenticated' | 'probe-failed'
}

export interface ReviewPacketResponse {
  repositoryId?: string | null
  packet: ReviewPacket
  acceptCapability: AcceptCapability
  snapshot: unknown
}
