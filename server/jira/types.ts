// Shared types for the per-project Jira integration.
//
// Design: Desktop is the sync layer. The local `.specrails/local-tickets.json`
// store stays the canonical read cache (specrails-core reads it unchanged). Jira
// is the system of record. Every write to Jira goes through a durable
// transactional outbox in the per-project `jobs.sqlite`. See
// docs/jira-integration-plan.md.

/** Jira deployment flavour — drives base path, auth scheme and body format. */
export type JiraDeployment = 'cloud' | 'dc'

/** Atlassian status categories — the only globally-stable status anchors. */
export type JiraStatusCategory = 'new' | 'indeterminate' | 'done'

/** The five logical Specrails states that map onto a customer workflow. */
export type SpecLogicalState = 'todo' | 'in_progress' | 'on_review' | 'done' | 'cancelled'

/** Outbox operation kinds. */
export type OutboxOpType = 'transition' | 'comment' | 'create' | 'update'

export type OutboxState = 'pending' | 'inflight' | 'done' | 'dead'

/**
 * Per-project Jira connection config. The encrypted token is stored separately
 * (`encrypted_token`); it is NEVER returned to the client (redacted to a
 * `hasToken` boolean, mirroring the webhook-secret posture).
 */
export interface JiraConnection {
  projectId: string
  baseUrl: string
  deployment: JiraDeployment
  apiVersion: '2' | '3'
  authScheme: 'basic' | 'bearer'
  accountEmail: string | null
  jiraProjectKey: string
  jiraProjectId: string
  /** When false, sync is paused (hot-swap back to local without losing config). */
  enabled: boolean
  /**
   * Explicit per-logical-state status override (status name/id chosen by the
   * customer from their project's real status list). Wins over category fallback.
   */
  statusMap: Partial<Record<SpecLogicalState, string>> | null
  /** Poll high-water mark — epoch ms of the max observed Jira `updated`. */
  highWaterMs: number | null
  /**
   * Cached id of the sprint custom field (varies per instance). null = not yet
   * discovered, 'none' = no sprint field exists, '<id>' = the field id.
   */
  sprintFieldId: string | null
  /**
   * User-configured status NAME a discarded spec's issue is moved to (instead of
   * a destructive delete) in a Jira-synced project. null = not configured.
   */
  discardStatus: string | null
  createdAt: string
  updatedAt: string
}

/** Client-facing connection shape — token redacted to a boolean. */
export interface JiraConnectionPublic extends Omit<JiraConnection, never> {
  hasToken: boolean
}

/**
 * The immutable spec↔issue link. Keyed on the IMMUTABLE Jira numeric id, never
 * the mutable `PROJ-123` key (issues move/rename). `localId` is the `#id` core
 * addresses; it is monotonic and tombstoned on delete (never reused).
 */
export interface JiraLink {
  localId: number
  jiraIssueId: string
  jiraKey: string | null
  jiraProjectId: string
  deployment: JiraDeployment
  statusCategory: JiraStatusCategory | null
  state: 'linked' | 'orphaned' | 'conflict'
  tombstoned: boolean
  createdAt: string
  updatedAt: string
}

export interface OutboxRow {
  id: number
  jiraIssueId: string
  opType: OutboxOpType
  idempotencyKey: string
  /** JSON payload (target category / comment body / create fields). */
  payload: string
  state: OutboxState
  attempts: number
  nextAttemptAt: string | null
  lastError: string | null
  deadReason: string | null
  createdAt: string
  updatedAt: string
}

/** Normalised result envelope from every JiraClient call. */
export type JiraResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; code: JiraErrorCode; error: string; retryAfterMs?: number }

/**
 * Error classification driving outbox retry/dead-letter decisions:
 * - `auth` (401): credential failure → pause project outbox, prompt re-auth.
 * - `permission` (403): operation forbidden → dead-letter naming the operation.
 * - `not_found` (404): deleted/moved issue → terminal, mark link orphaned.
 * - `rate_limit` (429): honour Retry-After, retry.
 * - `validation` (400): bad transition/field → dead-letter (not retryable).
 * - `no_transition`: no workflow path to the target category → dead-letter.
 * - `server` (5xx) / `network`: retryable.
 */
export type JiraErrorCode =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'rate_limit'
  | 'validation'
  | 'no_transition'
  | 'server'
  | 'network'

/** A Jira issue as returned by search/get, narrowed to fields we use. */
export interface JiraIssue {
  id: string
  key: string
  fields: {
    summary: string
    description?: unknown
    labels?: string[]
    updated?: string
    status?: {
      name: string
      statusCategory?: { key: string }
    }
    priority?: { name: string } | null
    assignee?: { displayName?: string; emailAddress?: string } | null
    issuetype?: { name: string }
    parent?: {
      key: string
      fields?: { summary?: string; issuetype?: { name?: string } }
    }
  }
}

export interface JiraTransition {
  id: string
  name: string
  to: {
    id: string
    name: string
    statusCategory?: { key: string }
  }
  hasScreen?: boolean
  fields?: Record<string, JiraTransitionField>
}

export interface JiraTransitionField {
  required: boolean
  hasDefaultValue?: boolean
  name?: string
  allowedValues?: Array<{ id?: string; name?: string; value?: string }>
  schema?: { type?: string; system?: string }
}

export interface JiraStatus {
  id: string
  name: string
  statusCategory?: { key: string }
}

/** An issue fetched with `fields=*all` — the fields map is open (system + custom). */
export interface JiraRawIssue {
  id: string
  key: string
  fields: Record<string, unknown>
}

/** Full `/field` metadata that drives the generic read-only field renderer. */
export interface JiraFieldMeta {
  id: string
  name?: string
  schema?: { type?: string; items?: string; custom?: string; system?: string }
}

// ─── Read-only "Jira details" + "Development" panel (spec detail modal) ──────────

/** One rendered, populated issue field row. `value` is already a display string. */
export interface JiraDetailField {
  label: string
  value: string
  /** Browse link when the field references another issue (parent/subtask/link/epic). */
  href?: string
}

export interface JiraDevCommit {
  id: string
  displayId: string
  message: string
  url: string
  author: string | null
  timestamp: string | null
}

export interface JiraDevPullRequest {
  id: string
  title: string
  url: string
  status: string
  sourceBranch: string | null
  destBranch: string | null
  author: string | null
  lastUpdate: string | null
}

export interface JiraDevBranch {
  name: string
  url: string
  createPullRequestUrl: string | null
  repo: string | null
  repoUrl: string | null
  lastCommit: JiraDevCommit | null
}

export interface JiraSpecDetails {
  fields: JiraDetailField[]
  development: {
    pullRequests: JiraDevPullRequest[]
    branches: JiraDevBranch[]
    commits: JiraDevCommit[]
  }
}
