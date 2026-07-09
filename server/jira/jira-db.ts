// Data-access layer for the per-project Jira tables (migration 29).
//
// All three tables live in the per-project `jobs.sqlite`. The outbox is the
// durable source of truth for "what must reach Jira": an outbox row is inserted
// in the SAME SQLite transaction as the record of a status change, so a crash
// between the local cache mutation and the network flush can never lose a write.

import type { DbInstance } from '../db'
import { getSecretStore } from './jira-credential-store'
import type {
  JiraConnection,
  JiraConnectionPublic,
  JiraDeployment,
  JiraLink,
  JiraStatusCategory,
  OutboxOpType,
  OutboxRow,
  OutboxState,
  SpecLogicalState,
} from './types'

// ─── jira_connection ───────────────────────────────────────────────────────────

interface ConnectionRowRaw {
  project_id: string
  base_url: string
  deployment: string
  api_version: string
  auth_scheme: string
  account_email: string | null
  jira_project_key: string
  jira_project_id: string
  encrypted_token: string | null
  enabled: number
  status_map: string | null
  high_water_ms: number | null
  sprint_field_id: string | null
  discard_status: string | null
  created_at: string
  updated_at: string
}

function mapConnection(r: ConnectionRowRaw): JiraConnection {
  let statusMap: Partial<Record<SpecLogicalState, string>> | null = null
  if (r.status_map) {
    try {
      statusMap = JSON.parse(r.status_map)
    } catch {
      statusMap = null
    }
  }
  return {
    projectId: r.project_id,
    baseUrl: r.base_url,
    deployment: r.deployment as JiraDeployment,
    apiVersion: r.api_version === '2' ? '2' : '3',
    authScheme: r.auth_scheme === 'bearer' ? 'bearer' : 'basic',
    accountEmail: r.account_email,
    jiraProjectKey: r.jira_project_key,
    jiraProjectId: r.jira_project_id,
    enabled: r.enabled === 1,
    statusMap,
    highWaterMs: r.high_water_ms,
    sprintFieldId: r.sprint_field_id ?? null,
    discardStatus: r.discard_status ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function getConnection(db: DbInstance, projectId: string): JiraConnection | null {
  const row = db.prepare('SELECT * FROM jira_connection WHERE project_id = ?').get(projectId) as
    | ConnectionRowRaw
    | undefined
  return row ? mapConnection(row) : null
}

/** Read the raw encrypted token blob (server-internal only — never returned to client). */
export function getDecryptedToken(db: DbInstance, projectId: string): string | null {
  const row = db.prepare('SELECT encrypted_token FROM jira_connection WHERE project_id = ?').get(projectId) as
    | { encrypted_token: string | null }
    | undefined
  if (!row?.encrypted_token) return null
  try {
    return getSecretStore().decrypt(row.encrypted_token)
  } catch {
    return null
  }
}

export function hasToken(db: DbInstance, projectId: string): boolean {
  const row = db.prepare('SELECT encrypted_token FROM jira_connection WHERE project_id = ?').get(projectId) as
    | { encrypted_token: string | null }
    | undefined
  return !!row?.encrypted_token
}

/** Client-safe connection (token redacted to a boolean). */
export function getConnectionPublic(db: DbInstance, projectId: string): JiraConnectionPublic | null {
  const conn = getConnection(db, projectId)
  if (!conn) return null
  return { ...conn, hasToken: hasToken(db, projectId) }
}

export interface UpsertConnectionInput {
  projectId: string
  baseUrl: string
  deployment: JiraDeployment
  apiVersion: '2' | '3'
  authScheme: 'basic' | 'bearer'
  accountEmail: string | null
  jiraProjectKey: string
  jiraProjectId: string
  /** Plaintext token; encrypted here. `undefined` keeps the existing token. */
  token?: string
  enabled?: boolean
  statusMap?: Partial<Record<SpecLogicalState, string>> | null
}

export function upsertConnection(db: DbInstance, input: UpsertConnectionInput): JiraConnection {
  const existing = getConnection(db, input.projectId)
  const now = new Date().toISOString()
  const prevToken = existing
    ? (db.prepare('SELECT encrypted_token FROM jira_connection WHERE project_id = ?').get(input.projectId) as
        | { encrypted_token: string | null }
        | undefined)?.encrypted_token ?? null
    : null
  const encryptedToken = input.token !== undefined ? getSecretStore().encrypt(input.token) : prevToken
  const statusMapJson =
    input.statusMap !== undefined
      ? input.statusMap === null
        ? null
        : JSON.stringify(input.statusMap)
      : existing?.statusMap
        ? JSON.stringify(existing.statusMap)
        : null
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing ? (existing.enabled ? 1 : 0) : 1

  db.prepare(
    `INSERT INTO jira_connection
       (project_id, base_url, deployment, api_version, auth_scheme, account_email,
        jira_project_key, jira_project_id, encrypted_token, enabled, status_map,
        high_water_ms, created_at, updated_at)
     VALUES (@project_id, @base_url, @deployment, @api_version, @auth_scheme, @account_email,
        @jira_project_key, @jira_project_id, @encrypted_token, @enabled, @status_map,
        @high_water_ms, @created_at, @updated_at)
     ON CONFLICT(project_id) DO UPDATE SET
        base_url=@base_url, deployment=@deployment, api_version=@api_version,
        auth_scheme=@auth_scheme, account_email=@account_email,
        jira_project_key=@jira_project_key, jira_project_id=@jira_project_id,
        encrypted_token=@encrypted_token, enabled=@enabled, status_map=@status_map,
        updated_at=@updated_at`
  ).run({
    project_id: input.projectId,
    base_url: input.baseUrl,
    deployment: input.deployment,
    api_version: input.apiVersion,
    auth_scheme: input.authScheme,
    account_email: input.accountEmail,
    jira_project_key: input.jiraProjectKey,
    jira_project_id: input.jiraProjectId,
    encrypted_token: encryptedToken,
    enabled,
    status_map: statusMapJson,
    high_water_ms: existing?.highWaterMs ?? null,
    created_at: existing?.createdAt ?? now,
    updated_at: now,
  })
  return getConnection(db, input.projectId)!
}

export function setConnectionEnabled(db: DbInstance, projectId: string, enabled: boolean): void {
  db.prepare('UPDATE jira_connection SET enabled = ?, updated_at = ? WHERE project_id = ?').run(
    enabled ? 1 : 0,
    new Date().toISOString(),
    projectId
  )
}

export function setHighWater(db: DbInstance, projectId: string, highWaterMs: number): void {
  db.prepare('UPDATE jira_connection SET high_water_ms = ?, updated_at = ? WHERE project_id = ?').run(
    highWaterMs,
    new Date().toISOString(),
    projectId
  )
}

/** Cache the discovered sprint custom-field id ('none' when none exists). */
export function setSprintFieldId(db: DbInstance, projectId: string, fieldId: string): void {
  db.prepare('UPDATE jira_connection SET sprint_field_id = ?, updated_at = ? WHERE project_id = ?').run(
    fieldId,
    new Date().toISOString(),
    projectId
  )
}

/** Set (or clear with null) the discard target status name. */
export function setDiscardStatus(db: DbInstance, projectId: string, status: string | null): void {
  db.prepare('UPDATE jira_connection SET discard_status = ?, updated_at = ? WHERE project_id = ?').run(
    status && status.trim() ? status.trim() : null,
    new Date().toISOString(),
    projectId
  )
}

/** Replace (or clear with null/empty) the per-logical-state status map. */
export function setStatusMap(
  db: DbInstance,
  projectId: string,
  statusMap: Partial<Record<SpecLogicalState, string>> | null
): void {
  const json = statusMap && Object.keys(statusMap).length ? JSON.stringify(statusMap) : null
  db.prepare('UPDATE jira_connection SET status_map = ?, updated_at = ? WHERE project_id = ?').run(
    json,
    new Date().toISOString(),
    projectId
  )
}

export function deleteConnection(db: DbInstance, projectId: string): void {
  db.prepare('DELETE FROM jira_connection WHERE project_id = ?').run(projectId)
}

// ─── jira_links ────────────────────────────────────────────────────────────────

interface LinkRowRaw {
  local_id: number
  jira_issue_id: string
  jira_key: string | null
  jira_project_id: string
  deployment: string
  status_category: string | null
  state: string
  tombstoned: number
  created_at: string
  updated_at: string
}

function mapLink(r: LinkRowRaw): JiraLink {
  return {
    localId: r.local_id,
    jiraIssueId: r.jira_issue_id,
    jiraKey: r.jira_key,
    jiraProjectId: r.jira_project_id,
    deployment: r.deployment as JiraDeployment,
    statusCategory: (r.status_category as JiraStatusCategory) ?? null,
    state: (r.state as JiraLink['state']) ?? 'linked',
    tombstoned: r.tombstoned === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function getLinkByIssueId(db: DbInstance, jiraIssueId: string): JiraLink | null {
  const row = db.prepare('SELECT * FROM jira_links WHERE jira_issue_id = ?').get(jiraIssueId) as
    | LinkRowRaw
    | undefined
  return row ? mapLink(row) : null
}

export function getLinkByLocalId(db: DbInstance, localId: number): JiraLink | null {
  const row = db.prepare('SELECT * FROM jira_links WHERE local_id = ?').get(localId) as LinkRowRaw | undefined
  return row ? mapLink(row) : null
}

export function listLinks(db: DbInstance): JiraLink[] {
  return (db.prepare('SELECT * FROM jira_links ORDER BY local_id').all() as LinkRowRaw[]).map(mapLink)
}

/**
 * Resolve (or mint) the stable local `#id` for a Jira issue. The local id is
 * monotonic and never reused — tombstoned rows keep their id so a previously
 * issued `/specrails:implement #N` never rebinds to a different issue.
 */
export function ensureLink(
  db: DbInstance,
  args: { jiraIssueId: string; jiraKey: string | null; jiraProjectId: string; deployment: JiraDeployment }
): JiraLink {
  const existing = getLinkByIssueId(db, args.jiraIssueId)
  const now = new Date().toISOString()
  if (existing) {
    // Refresh the display key (issues can be moved/renamed; id is immutable).
    if (args.jiraKey && args.jiraKey !== existing.jiraKey) {
      db.prepare('UPDATE jira_links SET jira_key = ?, updated_at = ? WHERE jira_issue_id = ?').run(
        args.jiraKey,
        now,
        args.jiraIssueId
      )
      return getLinkByIssueId(db, args.jiraIssueId)!
    }
    return existing
  }
  const localId = nextLocalId(db)
  db.prepare(
    `INSERT INTO jira_links (local_id, jira_issue_id, jira_key, jira_project_id, deployment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(localId, args.jiraIssueId, args.jiraKey, args.jiraProjectId, args.deployment, now, now)
  return getLinkByLocalId(db, localId)!
}

/** Next monotonic local id: max(existing local_ids) + 1, never reusing. */
export function nextLocalId(db: DbInstance): number {
  const row = db.prepare('SELECT MAX(local_id) AS maxId FROM jira_links').get() as { maxId: number | null }
  return (row.maxId ?? 0) + 1
}

/**
 * Insert a link with a caller-chosen local id. Used by the materializer, which
 * allocates ids from the UNION of the ticket store's `next_id` and the jira_links
 * max so Jira-sourced `#id`s never collide with locally-created specs.
 */
export function insertLinkWithId(
  db: DbInstance,
  args: { localId: number; jiraIssueId: string; jiraKey: string | null; jiraProjectId: string; deployment: JiraDeployment }
): JiraLink {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO jira_links (local_id, jira_issue_id, jira_key, jira_project_id, deployment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(args.localId, args.jiraIssueId, args.jiraKey, args.jiraProjectId, args.deployment, now, now)
  return getLinkByLocalId(db, args.localId)!
}

export function updateLinkStatusCategory(db: DbInstance, jiraIssueId: string, category: JiraStatusCategory): void {
  db.prepare('UPDATE jira_links SET status_category = ?, updated_at = ? WHERE jira_issue_id = ?').run(
    category,
    new Date().toISOString(),
    jiraIssueId
  )
}

export function setLinkState(db: DbInstance, jiraIssueId: string, state: JiraLink['state']): void {
  db.prepare('UPDATE jira_links SET state = ?, updated_at = ? WHERE jira_issue_id = ?').run(
    state,
    new Date().toISOString(),
    jiraIssueId
  )
}

/** Tombstone a deleted/orphaned issue's link (keeps the local id reserved). */
export function tombstoneLink(db: DbInstance, jiraIssueId: string): void {
  db.prepare("UPDATE jira_links SET tombstoned = 1, state = 'orphaned', updated_at = ? WHERE jira_issue_id = ?").run(
    new Date().toISOString(),
    jiraIssueId
  )
}

// ─── jira_outbox ─────────────────────────────────────────────────────────────

interface OutboxRowRaw {
  id: number
  jira_issue_id: string
  op_type: string
  idempotency_key: string
  payload: string
  state: string
  attempts: number
  next_attempt_at: string | null
  last_error: string | null
  dead_reason: string | null
  created_at: string
  updated_at: string
}

function mapOutbox(r: OutboxRowRaw): OutboxRow {
  return {
    id: r.id,
    jiraIssueId: r.jira_issue_id,
    opType: r.op_type as OutboxOpType,
    idempotencyKey: r.idempotency_key,
    payload: r.payload,
    state: r.state as OutboxState,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    deadReason: r.dead_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface EnqueueOutboxInput {
  jiraIssueId: string
  opType: OutboxOpType
  idempotencyKey: string
  payload: unknown
}

/**
 * Insert an outbox op. Idempotent on `idempotencyKey` (INSERT OR IGNORE) so a
 * crash-replay of the same logical op never double-enqueues. Returns the row id
 * (existing or new). Intended to be called inside a transaction together with
 * the status-change record (see `enqueueMany`).
 */
export function enqueueOutbox(db: DbInstance, input: EnqueueOutboxInput): number {
  const now = new Date().toISOString()
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO jira_outbox
        (jira_issue_id, op_type, idempotency_key, payload, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`
    )
    .run(input.jiraIssueId, input.opType, input.idempotencyKey, JSON.stringify(input.payload), now, now)
  if (info.changes > 0) return Number(info.lastInsertRowid)
  const existing = db.prepare('SELECT id FROM jira_outbox WHERE idempotency_key = ?').get(input.idempotencyKey) as
    | { id: number }
    | undefined
  return existing?.id ?? 0
}

/** Enqueue several ops atomically (one SQLite transaction). */
export function enqueueMany(db: DbInstance, ops: EnqueueOutboxInput[]): void {
  const tx = db.transaction((items: EnqueueOutboxInput[]) => {
    for (const op of items) enqueueOutbox(db, op)
  })
  tx(ops)
}

/**
 * Claim the next batch of drainable ops (state=pending and due), one per issue
 * (FIFO-per-issue: never two concurrent ops on the same issue), up to `limit`
 * distinct issues. Marks them `inflight`.
 */
export function claimDrainable(db: DbInstance, limit: number, nowIso: string = new Date().toISOString()): OutboxRow[] {
  const tx = db.transaction((max: number): OutboxRow[] => {
    const rows = db
      .prepare(
        `SELECT candidate.* FROM jira_outbox AS candidate
          WHERE candidate.state = 'pending'
            AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?)
            AND NOT EXISTS (
              SELECT 1 FROM jira_outbox AS prior
               WHERE prior.jira_issue_id = candidate.jira_issue_id
                 AND prior.id < candidate.id
                 AND prior.state IN ('pending', 'inflight')
            )
            AND NOT EXISTS (
              SELECT 1 FROM jira_outbox AS active
               WHERE active.jira_issue_id = candidate.jira_issue_id
                 AND active.state = 'inflight'
            )
          ORDER BY candidate.id ASC`
      )
      .all(nowIso) as OutboxRowRaw[]
    const claimed: OutboxRow[] = []
    const seenIssues = new Set<string>()
    for (const r of rows) {
      if (seenIssues.has(r.jira_issue_id)) continue // one op per issue per drain pass
      seenIssues.add(r.jira_issue_id)
      db.prepare("UPDATE jira_outbox SET state = 'inflight', updated_at = ? WHERE id = ?").run(nowIso, r.id)
      claimed.push(mapOutbox({ ...r, state: 'inflight' }))
      if (claimed.length >= max) break
    }
    return claimed
  })
  return tx(limit)
}

export function markOutboxDone(db: DbInstance, id: number): void {
  db.prepare("UPDATE jira_outbox SET state = 'done', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id)
}

export function markOutboxRetry(db: DbInstance, id: number, nextAttemptAt: string, error: string): void {
  db.prepare(
    "UPDATE jira_outbox SET state = 'pending', attempts = attempts + 1, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?"
  ).run(nextAttemptAt, error.slice(0, 500), new Date().toISOString(), id)
}

export function markOutboxDead(db: DbInstance, id: number, reason: string): void {
  db.prepare(
    "UPDATE jira_outbox SET state = 'dead', dead_reason = ?, updated_at = ? WHERE id = ?"
  ).run(reason.slice(0, 500), new Date().toISOString(), id)
}

/** Reset all `inflight` rows back to `pending` (startup recovery after a crash). */
export function resetInflight(db: DbInstance): number {
  const info = db
    .prepare("UPDATE jira_outbox SET state = 'pending', updated_at = ? WHERE state = 'inflight'")
    .run(new Date().toISOString())
  return info.changes
}

/** Re-queue a dead-lettered op for a manual retry. */
export function retryDeadOutbox(db: DbInstance, id: number): boolean {
  const info = db
    .prepare(
      "UPDATE jira_outbox SET state = 'pending', next_attempt_at = NULL, dead_reason = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND state = 'dead'"
    )
    .run(new Date().toISOString(), id)
  return info.changes > 0
}

export function listOutbox(db: DbInstance, opts: { state?: OutboxState; limit?: number } = {}): OutboxRow[] {
  const limit = Math.min(opts.limit ?? 200, 1000)
  if (opts.state) {
    return (
      db.prepare('SELECT * FROM jira_outbox WHERE state = ? ORDER BY id DESC LIMIT ?').all(opts.state, limit) as OutboxRowRaw[]
    ).map(mapOutbox)
  }
  return (db.prepare('SELECT * FROM jira_outbox ORDER BY id DESC LIMIT ?').all(limit) as OutboxRowRaw[]).map(mapOutbox)
}

export function countOutboxByState(db: DbInstance): Record<OutboxState, number> {
  const rows = db.prepare('SELECT state, COUNT(*) AS n FROM jira_outbox GROUP BY state').all() as Array<{
    state: string
    n: number
  }>
  const out: Record<OutboxState, number> = { pending: 0, inflight: 0, done: 0, dead: 0 }
  for (const r of rows) {
    if (r.state in out) out[r.state as OutboxState] = r.n
  }
  return out
}
