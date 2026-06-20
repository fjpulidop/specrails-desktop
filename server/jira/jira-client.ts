// Jira REST client. Single internal model rendered to the right dialect per
// deployment: Cloud (REST v3, Basic auth, ADF bodies) vs Data Center/Server
// (REST v2, Bearer PAT, plain wiki-string bodies). Every call returns a
// normalised `JiraResult<T>` whose error `code` drives the outbox's
// retry/dead-letter decisions. No throwing across the boundary.

import { bodyForDeployment, SPECRAILS_COMMENT_PROP_KEY } from './jira-adf'
import type {
  JiraDeployment,
  JiraErrorCode,
  JiraFieldMeta,
  JiraIssue,
  JiraRawIssue,
  JiraResult,
  JiraStatus,
  JiraTransition,
} from './types'

export type FetchImpl = (url: string, init?: any) => Promise<{
  status: number
  ok: boolean
  headers: { get(name: string): string | null }
  text(): Promise<string>
  json(): Promise<any>
}>

export interface JiraClientConfig {
  baseUrl: string
  deployment: JiraDeployment
  apiVersion: '2' | '3'
  authScheme: 'basic' | 'bearer'
  /** Cloud Basic: base64(email:token). DC Bearer: the raw PAT. */
  accountEmail?: string | null
  token: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
}

function classify(status: number): JiraErrorCode {
  if (status === 401) return 'auth'
  if (status === 403) return 'permission'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limit'
  if (status >= 400 && status < 500) return 'validation'
  return 'server'
}

export class JiraClient {
  private cfg: JiraClientConfig
  private fetchImpl: FetchImpl

  constructor(cfg: JiraClientConfig) {
    this.cfg = cfg
    // Node 18+ exposes a global fetch (undici); injectable for tests.
    this.fetchImpl = cfg.fetchImpl ?? ((globalThis as any).fetch as FetchImpl)
  }

  get deployment(): JiraDeployment {
    return this.cfg.deployment
  }

  private authHeader(): string {
    if (this.cfg.authScheme === 'bearer') return `Bearer ${this.cfg.token}`
    const raw = `${this.cfg.accountEmail ?? ''}:${this.cfg.token}`
    return `Basic ${Buffer.from(raw, 'utf-8').toString('base64')}`
  }

  private url(path: string): string {
    const base = this.cfg.baseUrl.replace(/\/+$/, '')
    return `${base}/rest/api/${this.cfg.apiVersion}${path}`
  }

  /** Build a URL for a NON `/rest/api` endpoint (e.g. `/rest/dev-status/1.0/...`). */
  private urlRaw(restPath: string): string {
    return `${this.cfg.baseUrl.replace(/\/+$/, '')}${restPath}`
  }

  /** REST v2/v3 request under `/rest/api/{version}`. */
  private request<T>(method: string, path: string, body?: unknown): Promise<JiraResult<T>> {
    return this.requestUrl<T>(method, this.url(path), body)
  }

  /** Request to an absolute REST path (for APIs outside `/rest/api`). */
  private requestRaw<T>(method: string, restPath: string, body?: unknown): Promise<JiraResult<T>> {
    return this.requestUrl<T>(method, this.urlRaw(restPath), body)
  }

  private async requestUrl<T>(method: string, fullUrl: string, body?: unknown): Promise<JiraResult<T>> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timeout = controller
      ? setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 20000)
      : null
    try {
      const res = await this.fetchImpl(fullUrl, {
        method,
        headers: {
          Authorization: this.authHeader(),
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      })
      if (res.ok) {
        const text = await res.text()
        const data = text ? (JSON.parse(text) as T) : (undefined as unknown as T)
        return { ok: true, data, status: res.status }
      }
      const errText = await res.text().catch(() => '')
      const code = classify(res.status)
      const retryAfter = res.headers.get('Retry-After')
      const retryAfterMs = retryAfter ? parseRetryAfter(retryAfter) : undefined
      return { ok: false, status: res.status, code, error: truncate(errText), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, status: 0, code: 'network', error: msg }
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  // ─── Connectivity / metadata ───────────────────────────────────────────────

  /** GET /myself — validates the credential and identifies the account. */
  myself(): Promise<JiraResult<{ accountId?: string; displayName?: string; emailAddress?: string }>> {
    return this.request('GET', '/myself')
  }

  /** GET /project/{key} — validates the project and returns name/id for confirmation. */
  getProject(keyOrId: string): Promise<JiraResult<{ id: string; key: string; name: string; lead?: { displayName?: string } }>> {
    return this.request('GET', `/project/${encodeURIComponent(keyOrId)}`)
  }

  /** GET /mypermissions — probe write capability so config-time warns the user. */
  myPermissions(permissions: string[], projectKey?: string): Promise<JiraResult<{ permissions: Record<string, { havePermission: boolean }> }>> {
    const qp = new URLSearchParams({ permissions: permissions.join(',') })
    if (projectKey) qp.set('projectKey', projectKey)
    return this.request('GET', `/mypermissions?${qp.toString()}`)
  }

  /** GET /project/{key}/statuses — the project's real status list per issue type. */
  getProjectStatuses(keyOrId: string): Promise<JiraResult<Array<{ name: string; statuses: JiraStatus[] }>>> {
    return this.request('GET', `/project/${encodeURIComponent(keyOrId)}/statuses`)
  }

  /** GET /field — all fields; used to discover the sprint custom field id. */
  getFields(): Promise<JiraResult<Array<{ id: string; name?: string; schema?: { custom?: string } }>>> {
    return this.request('GET', '/field')
  }

  /**
   * List projects the credential can see (for the setup wizard's project picker).
   * Cloud: paginated GET /project/search. DC/Server: GET /project (full list).
   */
  async searchProjects(query?: string): Promise<JiraResult<Array<{ id: string; key: string; name: string }>>> {
    if (this.cfg.apiVersion === '2') {
      const res = await this.request<Array<{ id: string; key: string; name: string }>>('GET', '/project')
      if (!res.ok) return res
      const filtered = query
        ? res.data.filter((p) => `${p.key} ${p.name}`.toLowerCase().includes(query.toLowerCase()))
        : res.data
      return { ok: true, data: filtered.slice(0, 50), status: res.status }
    }
    const qp = new URLSearchParams({ maxResults: '50' })
    if (query) qp.set('query', query)
    const res = await this.request<{ values: Array<{ id: string; key: string; name: string }> }>(
      'GET',
      `/project/search?${qp.toString()}`
    )
    if (!res.ok) return res
    return { ok: true, data: res.data.values ?? [], status: res.status }
  }

  // ─── Search (inbound poll) ─────────────────────────────────────────────────

  /**
   * POST /search/jql — the current paginated search (legacy GET /search was
   * removed Oct 2025). Always pass an explicit `fields` array; page via
   * `nextPageToken`. On DC v2 this falls back to the classic /search.
   */
  async searchJql(args: {
    jql: string
    fields: string[]
    nextPageToken?: string
    maxResults?: number
    reconcileIssues?: string[]
  }): Promise<JiraResult<{ issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>> {
    if (this.cfg.apiVersion === '2') {
      // DC/Server: classic search with startAt/maxResults. The classic response
      // carries {issues,total,startAt,maxResults} — NOT nextPageToken — so
      // SYNTHESIZE a nextPageToken (= next startAt) while more pages remain.
      // Without this the poll loop only ever read the first 100 issues.
      const startAt = args.nextPageToken ? parseInt(args.nextPageToken, 10) || 0 : 0
      const maxResults = args.maxResults ?? 100
      const res = await this.request<{ issues?: JiraIssue[]; total?: number }>('POST', '/search', {
        jql: args.jql,
        fields: args.fields,
        maxResults,
        startAt,
      })
      if (!res.ok) return res
      const issues = res.data.issues ?? []
      const total = res.data.total ?? issues.length
      const nextStart = startAt + issues.length
      const nextPageToken = issues.length > 0 && nextStart < total ? String(nextStart) : undefined
      return { ok: true, status: res.status, data: { issues, nextPageToken, isLast: nextPageToken === undefined } }
    }
    return this.request('POST', '/search/jql', {
      jql: args.jql,
      fields: args.fields,
      maxResults: args.maxResults ?? 100,
      ...(args.nextPageToken ? { nextPageToken: args.nextPageToken } : {}),
      ...(args.reconcileIssues ? { reconcileIssues: args.reconcileIssues } : {}),
    })
  }

  /** GET /issue/{idOrKey} — re-resolve by immutable id (key may have changed). */
  getIssue(idOrKey: string, fields?: string[]): Promise<JiraResult<JiraIssue>> {
    const qp = fields ? `?fields=${encodeURIComponent(fields.join(','))}` : ''
    return this.request('GET', `/issue/${encodeURIComponent(idOrKey)}${qp}`)
  }

  // ─── Lifecycle (outbound) ──────────────────────────────────────────────────

  /** GET /issue/{id}/transitions?expand=transitions.fields — discover edges + screens. */
  getTransitions(issueIdOrKey: string): Promise<JiraResult<{ transitions: JiraTransition[] }>> {
    return this.request('GET', `/issue/${encodeURIComponent(issueIdOrKey)}/transitions?expand=transitions.fields`)
  }

  /** POST /issue/{id}/transitions — apply a transition, optionally with fields. */
  transitionIssue(
    issueIdOrKey: string,
    transitionId: string,
    fields?: Record<string, unknown>
  ): Promise<JiraResult<void>> {
    return this.request('POST', `/issue/${encodeURIComponent(issueIdOrKey)}/transitions`, {
      transition: { id: transitionId },
      ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
    })
  }

  /** POST /issue — create an issue. Description rendered per deployment. */
  createIssue(args: {
    projectKey: string
    issueType: string
    summary: string
    description?: string
    labels?: string[]
    priority?: string
  }): Promise<JiraResult<{ id: string; key: string }>> {
    const fields: Record<string, unknown> = {
      project: { key: args.projectKey },
      issuetype: { name: args.issueType },
      summary: args.summary.slice(0, 250),
    }
    if (args.description) fields.description = bodyForDeployment(args.description, this.cfg.deployment)
    if (args.labels && args.labels.length > 0) fields.labels = args.labels
    if (args.priority) fields.priority = { name: args.priority }
    return this.request('POST', '/issue', { fields })
  }

  /**
   * PUT /issue/{id} — update editable fields (summary/description/labels/
   * priority) when a Jira-backed spec is edited locally. The `fields` object is
   * already rendered for the deployment by the caller. 204 on success.
   */
  updateIssue(idOrKey: string, fields: Record<string, unknown>): Promise<JiraResult<void>> {
    return this.request('PUT', `/issue/${encodeURIComponent(idOrKey)}`, { fields })
  }

  /**
   * POST /issue/{id}/comment — add a comment (ADF on Cloud, wiki on DC). The
   * optional idempotency `marker` is stored as an INVISIBLE comment property
   * (never in the body), so users never see it. Cloud + DC both accept the
   * `properties` array on comment creation.
   */
  addComment(issueIdOrKey: string, text: string, marker?: string): Promise<JiraResult<{ id: string }>> {
    const payload: Record<string, unknown> = { body: bodyForDeployment(text, this.cfg.deployment) }
    if (marker) payload.properties = [{ key: SPECRAILS_COMMENT_PROP_KEY, value: { marker } }]
    return this.request('POST', `/issue/${encodeURIComponent(issueIdOrKey)}/comment`, payload)
  }

  /**
   * GET /issue/{id}/comment?expand=properties — used to dedup comments via the
   * self-marker (invisible comment property, with a legacy body fallback).
   */
  async getComments(
    issueIdOrKey: string
  ): Promise<JiraResult<{ comments: Array<{ id: string; body: unknown; properties?: Array<{ key: string; value?: unknown }> }> }>> {
    // PAGE through ALL comments: the dedup self-marker may sit on an older page,
    // and a single (default ~50) page would miss it on a heavily-commented issue,
    // re-posting a duplicate completion/discard comment. Cap pages defensively.
    type Comment = { id: string; body: unknown; properties?: Array<{ key: string; value?: unknown }> }
    const all: Comment[] = []
    let startAt = 0
    const maxResults = 100
    for (let page = 0; page < 50; page++) {
      const enc = encodeURIComponent(issueIdOrKey)
      const res = await this.request<{ comments?: Comment[]; total?: number; startAt?: number }>(
        'GET',
        `/issue/${enc}/comment?expand=properties&startAt=${startAt}&maxResults=${maxResults}`,
      )
      if (!res.ok) return res
      const batch = res.data.comments ?? []
      all.push(...batch)
      const total = res.data.total ?? all.length
      startAt += batch.length
      if (batch.length === 0 || startAt >= total) break
    }
    return { ok: true, status: 200, data: { comments: all } }
  }

  // ─── Read-only details panel (issue fields + Development) ────────────────────

  /** GET /issue/{id}?fields=*all — the full system + custom field map (untyped). */
  getIssueRaw(idOrKey: string): Promise<JiraResult<JiraRawIssue>> {
    return this.request('GET', `/issue/${encodeURIComponent(idOrKey)}?fields=*all`)
  }

  /** GET /field — full field metadata (name + schema) for the generic renderer. */
  getFieldsFull(): Promise<JiraResult<JiraFieldMeta[]>> {
    return this.request('GET', '/field')
  }

  /**
   * GET /rest/dev-status/1.0/issue/summary?issueId=<numericId> — dev-panel counts
   * + the connected applicationType(s). `issueId` MUST be the immutable numeric
   * id (JiraLink.jiraIssueId), not the PROJ-123 key. No data => 200 zero counts.
   */
  getDevStatusSummary(issueId: string): Promise<JiraResult<JiraDevSummaryRaw>> {
    return this.requestRaw('GET', `/rest/dev-status/1.0/issue/summary?issueId=${encodeURIComponent(issueId)}`)
  }

  /**
   * GET /rest/dev-status/1.0/issue/detail — the actual PR/branch/repository
   * records for one (applicationType, dataType). A wrong applicationType returns
   * 200 with empty detail[]; derive it from getDevStatusSummary byInstanceType.
   */
  getDevStatusDetail(issueId: string, applicationType: string, dataType: DevStatusDataType): Promise<JiraResult<JiraDevDetailRaw>> {
    const qp = new URLSearchParams({ issueId, applicationType, dataType })
    return this.requestRaw('GET', `/rest/dev-status/1.0/issue/detail?${qp.toString()}`)
  }
}

export type DevStatusDataType = 'pullrequest' | 'branch' | 'repository'

export interface JiraDevSummaryRaw {
  errors?: unknown[]
  configErrors?: unknown[]
  summary?: Record<string, { overall?: { count?: number }; byInstanceType?: Record<string, { count?: number; name?: string }> }>
}

export interface JiraDevDetailRaw {
  errors?: unknown[]
  detail?: Array<{ pullRequests?: unknown[]; branches?: unknown[]; repositories?: unknown[]; _instance?: { name?: string; type?: string } }>
}

function parseRetryAfter(value: string): number | undefined {
  const seconds = Number(value)
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * Detect Cloud vs Data Center from the base URL host. `*.atlassian.net` ⇒ Cloud
 * (v3, Basic, ADF); otherwise DC/Server (v2, Bearer, wiki). A `probe` caller can
 * still override after hitting /myself, but the host heuristic is the default.
 */
export function detectDeployment(baseUrl: string): {
  deployment: JiraDeployment
  apiVersion: '2' | '3'
  authScheme: 'basic' | 'bearer'
} {
  let host = ''
  try {
    host = new URL(baseUrl).host.toLowerCase()
  } catch {
    host = baseUrl.toLowerCase()
  }
  const isCloud = host.endsWith('.atlassian.net') || host.endsWith('.jira.com')
  return isCloud
    ? { deployment: 'cloud', apiVersion: '3', authScheme: 'basic' }
    : { deployment: 'dc', apiVersion: '2', authScheme: 'bearer' }
}
