import type Database from 'better-sqlite3'
import type { JobStatus, JobPriority, JobOwner } from '../types'

// ─── Proposal types ───────────────────────────────────────────────────────────

export interface ProposalRow {
  id: string
  idea: string
  session_id: string | null
  status: string
  result_markdown: string | null
  issue_url: string | null
  created_at: string
  updated_at: string
}

export type DbInstance = InstanceType<typeof Database>

// ─── Internal types ──────────────────────────────────────────────────────────

export interface NewJob {
  id: string
  command: string
  started_at: string
  /** Provider resolved for this concrete run (including any per-job override).
   *  Persisted so crash recovery does not fall back to the project's default. */
  provider?: string | null
  /** Manager that exclusively owns crash recovery for this row. */
  owner?: JobOwner
  /** True when launch-time ticket/rail ownership was durably claimed. False
   *  is reserved for pre-provenance/legacy work. */
  causal_ownership?: boolean
  priority?: JobPriority
  depends_on_job_id?: string | null
  pipeline_id?: string | null
  /** 1 when this is an interactive persistent session (freestyle + the rail's
   *  Interactive toggle); 0/undefined for standard autonomous jobs. */
  interactive?: boolean
}

/** Durable pre-start state. Queued work deliberately lives outside `jobs`:
 * `jobs.started_at` is the execution start timestamp and is NOT NULL for
 * historical rows, so inserting there before spawn would manufacture a start. */
export interface QueuedJobRecord {
  id: string
  command: string
  queue_position: number | null
  priority: JobPriority
  depends_on_job_id?: string | null
  pipeline_id?: string | null
  /** Per-job overrides. Null means use the project/provider default. */
  provider?: string | null
  model?: string | null
  /** `profile_selection_set=false` is default resolution; true + null forces
   * legacy mode; true + string selects that explicit profile. */
  profile_name?: string | null
  profile_selection_set?: boolean
  /** Null is the spawn-time default; 0/1 are explicit false/true overrides. */
  interactive?: boolean | null
  causal_ownership?: boolean
}

/** Per-turn usage delta accumulated into an interactive job's row as each turn
 *  settles. Every field is the REAL provider-reported usage for that one turn. */
export interface InteractiveTurnUsage {
  tokens_in: number
  tokens_out: number
  tokens_cache_read: number
  tokens_cache_create: number
  total_cost_usd: number
  num_turns: number
  model?: string | null
  session_id?: string | null
  /** 1/true when this turn's cost is a pricing-table estimate rather than the
   *  provider's native `total_cost_usd` (e.g. an in-flight turn folded at
   *  finalize — CRIT-4). Sticky: once any folded turn is estimated the jobs
   *  row stays flagged so Job Detail / StatusBar can badge it with `~`. */
  estimated?: boolean
}

export interface JobResult {
  exit_code: number
  status: JobStatus
  tokens_in?: number
  tokens_out?: number
  tokens_cache_read?: number
  tokens_cache_create?: number
  total_cost_usd?: number
  /** 1/true when total_cost_usd is a pricing-table estimate (codex) rather
   *  than a provider-billed figure (claude). Persisted to
   *  jobs.total_cost_usd_estimated so app surfaces can badge it. */
  total_cost_usd_estimated?: boolean
  num_turns?: number
  model?: string
  duration_ms?: number
  duration_api_ms?: number
  session_id?: string
}

export interface AppEvent {
  event_type: string
  source?: string | null
  payload: string
}

export interface ListJobsOpts {
  limit?: number
  offset?: number
  status?: string
  from?: string
  to?: string
}
