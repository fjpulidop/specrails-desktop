// Client API for the per-project Jira integration. All calls go through
// getApiBase() (the active project's /api/projects/<id> prefix).

import { getApiBase } from './api'

export type JiraDeployment = 'cloud' | 'dc'
export type SpecLogicalState = 'todo' | 'in_progress' | 'on_review' | 'done' | 'cancelled'
export type OutboxState = 'pending' | 'inflight' | 'done' | 'dead'

export interface JiraConnectionPublic {
  projectId: string
  baseUrl: string
  deployment: JiraDeployment
  apiVersion: '2' | '3'
  authScheme: 'basic' | 'bearer'
  accountEmail: string | null
  jiraProjectKey: string
  jiraProjectId: string
  enabled: boolean
  statusMap: Partial<Record<SpecLogicalState, string>> | null
  highWaterMs: number | null
  /** Status a discarded spec's issue is moved to (null = not configured). */
  discardStatus: string | null
  hasToken: boolean
}

export interface OutboxCounts {
  pending: number
  inflight: number
  done: number
  dead: number
}

export interface OutboxOp {
  id: number
  jiraIssueId: string
  opType: 'transition' | 'comment' | 'create'
  state: OutboxState
  attempts: number
  lastError: string | null
  deadReason: string | null
  createdAt: string
  updatedAt: string
}

export interface JiraStatusOption {
  id: string
  name: string
  category: string
}

export interface JiraDetailField {
  label: string
  value: string
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
  development: { pullRequests: JiraDevPullRequest[]; branches: JiraDevBranch[]; commits?: JiraDevCommit[] }
}

export interface JiraProjectOption {
  id: string
  key: string
  name: string
}

export interface ConnectionState {
  connected: boolean
  connection?: JiraConnectionPublic
  outbox?: OutboxCounts
}

async function asJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`)
  }
  return data as T
}

/**
 * Resolve the API base. Defaults to the active project (`getApiBase()`), but the
 * setup wizard passes an explicit `/api/projects/<id>` for the project being set
 * up (which may not be the active project yet).
 */
function base(apiBase?: string): string {
  return apiBase ?? getApiBase()
}

export interface JiraTestInput {
  baseUrl: string
  accountEmail: string | null
  token: string
}

const jsonPost = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const jiraApi = {
  getConnection(apiBase?: string): Promise<ConnectionState> {
    return fetch(`${base(apiBase)}/jira/connection`).then((r) => asJson<ConnectionState>(r))
  },

  test(input: JiraTestInput, apiBase?: string): Promise<{ ok: true; deployment: JiraDeployment; displayName: string | null }> {
    return fetch(`${base(apiBase)}/jira/test`, jsonPost(input)).then((r) => asJson(r))
  },

  discoverProjects(input: JiraTestInput & { query?: string }, apiBase?: string): Promise<{ projects: JiraProjectOption[] }> {
    return fetch(`${base(apiBase)}/jira/discover-projects`, jsonPost(input)).then((r) => asJson(r))
  },

  discoverStatuses(input: JiraTestInput & { projectKey: string }, apiBase?: string): Promise<{ statuses: JiraStatusOption[] }> {
    return fetch(`${base(apiBase)}/jira/discover-statuses`, jsonPost(input)).then((r) => asJson(r))
  },

  connect(
    input: JiraTestInput & {
      jiraProjectKey: string
      statusMap?: Partial<Record<SpecLogicalState, string>> | null
      discardStatus?: string | null
    },
    apiBase?: string
  ): Promise<{ connection: JiraConnectionPublic }> {
    return fetch(`${base(apiBase)}/jira/connect`, jsonPost(input)).then((r) => asJson(r))
  },

  setEnabled(enabled: boolean, apiBase?: string): Promise<{ connection: JiraConnectionPublic }> {
    return fetch(`${base(apiBase)}/jira/connection`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then((r) => asJson(r))
  },

  /** Patch the connection (enabled, status map, and/or the discard status). */
  patchConnection(
    patch: {
      enabled?: boolean
      discardStatus?: string | null
      statusMap?: Partial<Record<SpecLogicalState, string>> | null
    },
    apiBase?: string
  ): Promise<{ connection: JiraConnectionPublic }> {
    return fetch(`${base(apiBase)}/jira/connection`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => asJson(r))
  },

  /** The connected project's real statuses (post-connect discard-status picker). */
  listStatuses(apiBase?: string): Promise<{ statuses: JiraStatusOption[] }> {
    return fetch(`${base(apiBase)}/jira/statuses`).then((r) => asJson(r))
  },

  /** Manual transition of a Jira-backed spec to a NAMED raw workflow status. */
  moveSpecToStatus(localId: number, status: string, apiBase?: string): Promise<{ ok: true }> {
    return fetch(`${base(apiBase)}/jira/specs/${localId}/move-to-status`, jsonPost({ status })).then((r) => asJson(r))
  },

  /** Move a Jira-backed spec to the configured discard status (+ optional reason). */
  discardSpec(localId: number, comment: string | null, apiBase?: string): Promise<{ ok: true }> {
    return fetch(`${base(apiBase)}/jira/specs/${localId}/discard`, jsonPost({ comment })).then((r) => asJson(r))
  },

  /** Read-only "Jira details" + "Development" payload for the spec detail modal. */
  getSpecDetails(localId: number, apiBase?: string): Promise<JiraSpecDetails> {
    return fetch(`${base(apiBase)}/jira/specs/${localId}/details`).then((r) => asJson<JiraSpecDetails>(r))
  },

  disconnect(apiBase?: string): Promise<{ connected: false }> {
    return fetch(`${base(apiBase)}/jira/connection`, { method: 'DELETE' }).then((r) => asJson(r))
  },

  syncNow(apiBase?: string): Promise<{ ok: true; upserted: number }> {
    return fetch(`${base(apiBase)}/jira/sync`, { method: 'POST' }).then((r) => asJson(r))
  },

  resume(apiBase?: string): Promise<{ ok: true }> {
    return fetch(`${base(apiBase)}/jira/resume`, { method: 'POST' }).then((r) => asJson(r))
  },

  listOutbox(state?: OutboxState, apiBase?: string): Promise<{ ops: OutboxOp[]; counts: OutboxCounts }> {
    const qs = state ? `?state=${state}` : ''
    return fetch(`${base(apiBase)}/jira/outbox${qs}`).then((r) => asJson(r))
  },

  retryOutbox(id: number, apiBase?: string): Promise<{ ok: true }> {
    return fetch(`${base(apiBase)}/jira/outbox/${id}/retry`, { method: 'POST' }).then((r) => asJson(r))
  },
}
