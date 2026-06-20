// Per-project Jira sync orchestrator. One instance lives on each ProjectContext
// beside QueueManager/ChatManager. It owns:
//   - the inbound poll loop (JQL high-water + overlap → materializer),
//   - the durable outbox drainer (FIFO-per-issue, idempotency-first, error
//     classification → retry / dead-letter / auth-pause),
//   - the two write-back hooks: onRailLaunch (todo→In Progress) and onJobOutcome
//     (Done / revert + completion comment),
// and stays completely inert until the project configures a Jira connection.

import type { DbInstance } from '../db'
import { mutateStore, readStore, resolveTicketStoragePath, type Ticket, type TicketStatus } from '../ticket-store'
import type { WsMessage } from '../types'
import { JiraClient, detectDeployment, type FetchImpl } from './jira-client'
import { writeJiraBacklogConfig, writeLocalBacklogConfig } from './jira-backlog-config'
import { commentMarker, discardCommentMarker, commentHasMarker, bodyForDeployment } from './jira-adf'
import { issueUrl, upsertIssuesIntoStore } from './jira-materializer'
import {
  formatIssueFields,
  normalizeBranches,
  normalizePullRequests,
  normalizeRepositoryCommits,
} from './jira-issue-fields'
import {
  buildTransitionFields,
  walkToCategory,
  type WalkOutcome,
} from './jira-status-resolver'
import {
  claimDrainable,
  countOutboxByState,
  deleteConnection,
  enqueueMany,
  getConnection,
  getDecryptedToken,
  getLinkByLocalId,
  insertLinkWithId,
  listLinks,
  listOutbox,
  markOutboxDead,
  markOutboxDone,
  markOutboxRetry,
  resetInflight,
  setConnectionEnabled,
  setDiscardStatus,
  setHighWater,
  setSprintFieldId,
  setStatusMap,
  tombstoneLink,
  upsertConnection,
  type EnqueueOutboxInput,
} from './jira-db'
import { resolveProjectExecution } from '../workspace-resolution'
import type { DevStatusDataType, JiraClient as JiraClientT } from './jira-client'
import type {
  JiraConnection,
  JiraIssue,
  JiraSpecDetails,
  JiraStatusCategory,
  JiraTransition,
  OutboxRow,
  SpecLogicalState,
} from './types'

const POLL_INTERVAL_MS = 60_000
const DRAIN_INTERVAL_MS = 10_000
const POLL_OVERLAP_MS = 2 * 60_000
const MAX_DRAIN_BATCH = 8
const SEARCH_FIELDS = ['summary', 'description', 'labels', 'status', 'priority', 'assignee', 'updated', 'issuetype', 'parent']

/** Local priority → Jira priority NAME (standard scheme; best-effort). A custom
 *  scheme that rejects the name is retried without priority in executeUpdate. */
const PRIORITY_TO_JIRA: Record<string, string> = {
  critical: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export interface JiraSyncManagerOpts {
  db: DbInstance
  projectId: string
  projectPath: string
  broadcast: (msg: WsMessage) => void
  /** Injectable fetch for tests. */
  fetchImpl?: FetchImpl
  /** When false, timers are not started (tests drive pollOnce/drainOnce directly). */
  startTimers?: boolean
  /**
   * Called after every local-tickets.json write the manager makes, with the new
   * store revision. Wired to TicketWatcher.notifyDesktopWrite so a poll/sync
   * write does NOT trigger the watcher's full-board refresh (the 60s flicker).
   */
  notifyLocalWrite?: (revision: number) => void
}

export type JobOutcomeStatus = 'completed' | 'failed' | 'canceled' | 'zombie_terminated'

export class JiraSyncManager {
  private db: DbInstance
  private projectId: string
  private projectPath: string
  private broadcast: (msg: WsMessage) => void
  private fetchImpl?: FetchImpl
  private notifyLocalWriteCb?: (revision: number) => void
  private pollTimer: NodeJS.Timeout | null = null
  private drainTimer: NodeJS.Timeout | null = null
  /** When set, the outbox is paused pending re-auth (401). */
  private authPaused = false

  constructor(opts: JiraSyncManagerOpts) {
    this.db = opts.db
    this.projectId = opts.projectId
    this.projectPath = opts.projectPath
    this.broadcast = opts.broadcast
    this.fetchImpl = opts.fetchImpl
    this.notifyLocalWriteCb = opts.notifyLocalWrite
    if (opts.startTimers !== false) this.start()
  }

  /**
   * Relocate-artifacts gate: the directory whose `.specrails/{local-tickets,
   * backlog-config}.json` Jira sync reads/writes. Relocated ⇒ the workspace dir
   * (the path-deriving helpers join `.specrails/...` under it); legacy ⇒
   * project.path (byte-identical for existing projects). All Jira artifact I/O
   * funnels through here.
   */
  private _artifactRoot(): string {
    const exec = resolveProjectExecution({ path: this.projectPath })
    return exec.relocated && exec.workspaceDir ? exec.workspaceDir : this.projectPath
  }

  /** Suppress the file-watcher echo for a local write we just made. */
  private notifyLocalWrite(revision: number): void {
    try {
      this.notifyLocalWriteCb?.(revision)
    } catch {
      /* best-effort */
    }
  }

  /** Late-bind the watcher notifier (the TicketWatcher is constructed after us). */
  setLocalWriteNotifier(fn: (revision: number) => void): void {
    this.notifyLocalWriteCb = fn
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /** True when this project has an enabled connection with a token. */
  isActive(): boolean {
    const conn = getConnection(this.db, this.projectId)
    return !!conn && conn.enabled && getDecryptedToken(this.db, this.projectId) !== null
  }

  start(): void {
    // Only arm timers for projects that actually have a Jira connection — a
    // non-Jira project must not wake its event loop every 10s for a no-op.
    let conn: JiraConnection | null = null
    try {
      conn = getConnection(this.db, this.projectId)
    } catch {
      /* tables may not exist on a stale DB */
    }
    if (!conn) return
    // Recover any inflight ops left by a crash, then arm timers if active.
    try {
      resetInflight(this.db)
    } catch {
      /* table may not exist on a stale DB */
    }
    if (this.pollTimer || this.drainTimer) return
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch(() => undefined)
    }, POLL_INTERVAL_MS)
    this.drainTimer = setInterval(() => {
      void this.drainOnce().catch(() => undefined)
    }, DRAIN_INTERVAL_MS)
    // Unref so timers never keep the process alive on shutdown.
    this.pollTimer.unref?.()
    this.drainTimer.unref?.()
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.drainTimer) clearInterval(this.drainTimer)
    this.pollTimer = null
    this.drainTimer = null
  }

  private buildClient(): JiraClient | null {
    const conn = getConnection(this.db, this.projectId)
    if (!conn) return null
    const token = getDecryptedToken(this.db, this.projectId)
    if (!token) return null
    return new JiraClient({
      baseUrl: conn.baseUrl,
      deployment: conn.deployment,
      apiVersion: conn.apiVersion,
      authScheme: conn.authScheme,
      accountEmail: conn.accountEmail,
      token,
      fetchImpl: this.fetchImpl,
    })
  }

  /**
   * Discover the sprint custom-field id (schema gh-sprint). Returns the field
   * id, 'none' when no sprint field exists, or null when it couldn't be
   * determined (transient failure → caller leaves it unchecked to retry).
   */
  private async discoverSprintField(client: JiraClient): Promise<string | null> {
    const res = await client.getFields()
    if (!res.ok) return null
    const field = res.data.find((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')
    return field ? field.id : 'none'
  }

  // ─── Connect / disconnect ──────────────────────────────────────────────────

  /**
   * Validate a candidate connection (credential + project) and persist it on
   * success. Writes the backlog-config so core treats the cache as read-only.
   */
  async connect(input: {
    baseUrl: string
    accountEmail: string | null
    token: string
    jiraProjectKey: string
    statusMap?: Partial<Record<SpecLogicalState, string>> | null
    discardStatus?: string | null
  }): Promise<{ ok: true; connection: JiraConnection } | { ok: false; error: string; status?: number }> {
    const detected = detectDeployment(input.baseUrl)
    const probe = new JiraClient({
      baseUrl: input.baseUrl,
      deployment: detected.deployment,
      apiVersion: detected.apiVersion,
      authScheme: detected.authScheme,
      accountEmail: input.accountEmail,
      token: input.token,
      fetchImpl: this.fetchImpl,
    })

    const me = await probe.myself()
    if (!me.ok) {
      return { ok: false, error: me.code === 'auth' ? 'Invalid Jira credentials' : `Connection failed: ${me.error}`, status: me.status }
    }
    const proj = await probe.getProject(input.jiraProjectKey)
    if (!proj.ok) {
      return {
        ok: false,
        error: proj.code === 'not_found' ? `Jira project "${input.jiraProjectKey}" not found or no access` : `Project check failed: ${proj.error}`,
        status: proj.status,
      }
    }

    const connection = upsertConnection(this.db, {
      projectId: this.projectId,
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      deployment: detected.deployment,
      apiVersion: detected.apiVersion,
      authScheme: detected.authScheme,
      accountEmail: input.accountEmail,
      jiraProjectKey: proj.data.key,
      jiraProjectId: proj.data.id,
      token: input.token,
      enabled: true,
      statusMap: input.statusMap ?? null,
    })
    if (input.discardStatus !== undefined) {
      setDiscardStatus(this.db, this.projectId, input.discardStatus)
    }
    writeJiraBacklogConfig(this._artifactRoot())
    // Discover the sprint custom-field id (best-effort) so sprint capture works
    // from the first poll. Non-fatal — the poll re-discovers if this fails.
    try {
      const fieldId = await this.discoverSprintField(probe)
      if (fieldId !== null) setSprintFieldId(this.db, this.projectId, fieldId)
    } catch {
      /* non-fatal */
    }
    this.authPaused = false
    this.start()
    // Kick an immediate first sync (best-effort).
    void this.pollOnce().catch(() => undefined)
    return { ok: true, connection: getConnection(this.db, this.projectId) ?? connection }
  }

  private throwawayClient(input: { baseUrl: string; accountEmail: string | null; token: string }): JiraClient {
    const detected = detectDeployment(input.baseUrl)
    return new JiraClient({
      baseUrl: input.baseUrl,
      deployment: detected.deployment,
      apiVersion: detected.apiVersion,
      authScheme: detected.authScheme,
      accountEmail: input.accountEmail,
      token: input.token,
      fetchImpl: this.fetchImpl,
    })
  }

  /** Wizard step 1: validate credentials without persisting anything. */
  async probeCredentials(input: { baseUrl: string; accountEmail: string | null; token: string }): Promise<
    { ok: true; deployment: JiraConnection['deployment']; displayName: string | null } | { ok: false; error: string; status?: number }
  > {
    const detected = detectDeployment(input.baseUrl)
    const me = await this.throwawayClient(input).myself()
    if (!me.ok) {
      return { ok: false, error: me.code === 'auth' ? 'Invalid email or token' : me.error, status: me.status }
    }
    return { ok: true, deployment: detected.deployment, displayName: me.data.displayName ?? me.data.emailAddress ?? null }
  }

  /** Wizard step 2: list the projects this credential can see. */
  async discoverProjects(input: { baseUrl: string; accountEmail: string | null; token: string; query?: string }): Promise<
    { ok: true; projects: Array<{ id: string; key: string; name: string }> } | { ok: false; error: string; status?: number }
  > {
    const res = await this.throwawayClient(input).searchProjects(input.query)
    if (!res.ok) return { ok: false, error: res.error, status: res.status }
    return { ok: true, projects: res.data }
  }

  /** Wizard step 3 (optional): the chosen project's real status list for mapping. */
  async discoverStatuses(input: {
    baseUrl: string
    accountEmail: string | null
    token: string
    projectKey: string
  }): Promise<{ ok: true; statuses: Array<{ id: string; name: string; category: string }> } | { ok: false; error: string }> {
    const res = await this.throwawayClient(input).getProjectStatuses(input.projectKey)
    if (!res.ok) return { ok: false, error: res.error }
    const seen = new Map<string, { id: string; name: string; category: string }>()
    for (const group of res.data) {
      for (const s of group.statuses) {
        if (!seen.has(s.id)) seen.set(s.id, { id: s.id, name: s.name, category: s.statusCategory?.key ?? 'indeterminate' })
      }
    }
    return { ok: true, statuses: Array.from(seen.values()) }
  }

  /** Pause/resume sync without losing config (hot-swap back to local specs). */
  setEnabled(enabled: boolean): void {
    setConnectionEnabled(this.db, this.projectId, enabled)
    if (enabled) {
      writeJiraBacklogConfig(this._artifactRoot())
      this.start()
    } else {
      writeLocalBacklogConfig(this._artifactRoot())
    }
  }

  /** Configure (or clear) the status a discarded spec is moved to. */
  setDiscardStatus(status: string | null): void {
    setDiscardStatus(this.db, this.projectId, status)
  }

  /** Replace (or clear) the per-logical-state status map (post-connect edit). */
  setStatusMap(statusMap: Partial<Record<SpecLogicalState, string>> | null): void {
    setStatusMap(this.db, this.projectId, statusMap)
  }

  /**
   * List the connected project's real statuses (for the post-connect "move on
   * discard" picker). Uses the stored credentials — no creds needed from caller.
   */
  async listStatusesForConnection(): Promise<
    { ok: true; statuses: Array<{ id: string; name: string; category: string }> } | { ok: false; error: string }
  > {
    const conn = getConnection(this.db, this.projectId)
    if (!conn) return { ok: false, error: 'No Jira connection configured' }
    const client = this.buildClient()
    if (!client) return { ok: false, error: 'No Jira credentials' }
    const res = await client.getProjectStatuses(conn.jiraProjectKey)
    if (!res.ok) return { ok: false, error: res.error }
    const seen = new Map<string, { id: string; name: string; category: string }>()
    for (const group of res.data) {
      for (const s of group.statuses) {
        if (!seen.has(s.id)) seen.set(s.id, { id: s.id, name: s.name, category: s.statusCategory?.key ?? 'indeterminate' })
      }
    }
    return { ok: true, statuses: Array.from(seen.values()) }
  }

  /** Remove the connection entirely and restore local backlog config. */
  disconnect(): void {
    deleteConnection(this.db, this.projectId)
    writeLocalBacklogConfig(this._artifactRoot())
    this.stop()
  }

  // ─── Create a spec in Jira (Add Spec when source = Jira) ───────────────────

  /**
   * Create a Jira issue for a new spec, materialize it into the local cache, and
   * return the minted local `#id`. The issue type defaults to "Task" (the most
   * universally present type); customers with no Task type can override later.
   */
  async createSpec(input: {
    title: string
    description?: string
    labels?: string[]
    priority?: string
    issueType?: string
  }): Promise<{ ok: true; localId: number; jiraKey: string } | { ok: false; error: string; status?: number }> {
    const conn = getConnection(this.db, this.projectId)
    if (!conn) return { ok: false, error: 'No Jira connection configured' }
    const client = this.buildClient()
    if (!client) return { ok: false, error: 'No Jira credentials' }

    const created = await client.createIssue({
      projectKey: conn.jiraProjectKey,
      issueType: input.issueType ?? 'Task',
      summary: input.title,
      description: input.description,
      labels: input.labels,
      priority: input.priority,
    })
    if (!created.ok) {
      if (created.code === 'auth') this.onAuth401()
      return { ok: false, error: created.error || 'Jira issue create failed', status: created.status }
    }
    // Fetch the full issue so the cache reflects the real status/fields.
    const full = await client.getIssue(created.data.id, SEARCH_FIELDS)
    const issue: JiraIssue = full.ok
      ? full.data
      : ({ id: created.data.id, key: created.data.key, fields: { summary: input.title, labels: input.labels ?? [] } } as JiraIssue)
    const r = upsertIssuesIntoStore(this.db, this._artifactRoot(), conn, [issue], new Set())
    if (r.wrote) this.notifyLocalWrite(r.revision)
    const localId = r.changedLocalIds[0]
    const t = readTicket(this._artifactRoot(), localId)
    if (t) this.broadcast({ type: 'ticket_created', ticket: t, projectId: this.projectId, timestamp: t.updated_at } as WsMessage)
    return { ok: true, localId, jiraKey: created.data.key }
  }

  /**
   * Promote an existing LOCAL ticket to a Jira issue (Add Spec on a Jira-backed
   * project). Creates the issue, links it to the SAME local id (no new id minted,
   * no duplicate ticket), and flips the cached ticket to `source:'jira'` with its
   * key/url. Idempotent: a ticket already linked is a no-op. Best-effort — on
   * failure the ticket simply stays local and the caller surfaces a warning.
   */
  async promoteTicketToJira(
    localId: number
  ): Promise<{ ok: true; jiraKey: string | null; alreadyLinked?: boolean } | { ok: false; error: string }> {
    if (!this.isActive()) return { ok: false, error: 'jira not active' }
    const existing = getLinkByLocalId(this.db, localId)
    if (existing && !existing.tombstoned) return { ok: true, jiraKey: existing.jiraKey, alreadyLinked: true }
    const conn = getConnection(this.db, this.projectId)
    if (!conn) return { ok: false, error: 'no jira connection' }
    const client = this.buildClient()
    if (!client) return { ok: false, error: 'no jira credentials' }

    const file = resolveTicketStoragePath(this._artifactRoot())
    const ticket = readStore(file).tickets[String(localId)]
    if (!ticket) return { ok: false, error: 'ticket not found' }

    const created = await client.createIssue({
      projectKey: conn.jiraProjectKey,
      issueType: 'Task',
      summary: ticket.title,
      description: ticket.description || undefined,
      labels: ticket.labels,
    })
    if (!created.ok) {
      if (created.code === 'auth') this.onAuth401()
      return { ok: false, error: created.error || 'jira issue create failed' }
    }

    insertLinkWithId(this.db, {
      localId,
      jiraIssueId: created.data.id,
      jiraKey: created.data.key,
      jiraProjectId: conn.jiraProjectId,
      deployment: conn.deployment,
    })

    let updated: Ticket | undefined
    const promoteStore = mutateStore(file, (s) => {
      const t = s.tickets[String(localId)]
      if (t) {
        t.source = 'jira'
        t.jira_key = created.data.key
        t.jira_url = issueUrl(conn.baseUrl, created.data.key)
        t.updated_at = new Date().toISOString()
        updated = t
      }
    })
    this.notifyLocalWrite(promoteStore.revision)
    if (updated) {
      this.broadcast({ type: 'ticket_updated', ticket: updated as unknown as never, projectId: this.projectId, timestamp: updated.updated_at } as WsMessage)
    }
    return { ok: true, jiraKey: created.data.key }
  }

  // ─── Inbound poll ──────────────────────────────────────────────────────────

  /** The set of local ids with a pending/inflight outbox op (status is frozen). */
  private frozenLocalIds(): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT l.local_id AS localId
           FROM jira_outbox o JOIN jira_links l ON l.jira_issue_id = o.jira_issue_id
          WHERE o.state IN ('pending','inflight') AND o.op_type IN ('transition','update')`
      )
      .all() as Array<{ localId: number }>
    return new Set(rows.map((r) => r.localId))
  }

  /**
   * Inbound poll. `full=true` ignores the high-water mark and re-fetches the
   * whole backlog — used by the manual "Sync now" so it back-fills any fields
   * the cache is missing (e.g. sprint/epic data added after the last sync).
   */
  async pollOnce(full = false): Promise<{ upserted: number } | null> {
    let conn = getConnection(this.db, this.projectId)
    if (!conn || !conn.enabled) return null
    const client = this.buildClient()
    if (!client) return null

    // Lazily discover the sprint custom-field id for connections made before the
    // feature existed (null = not yet checked). Persist 'none' when there's none.
    if (conn.sprintFieldId === null) {
      const fieldId = await this.discoverSprintField(client)
      if (fieldId !== null) {
        setSprintFieldId(this.db, this.projectId, fieldId)
        // First time we find a real sprint field on an ALREADY-synced connection:
        // reset the high-water so this poll re-fetches every issue and back-fills
        // the sprint (and epic) data the cache is missing. One-time full re-sync.
        if (fieldId !== 'none' && conn.highWaterMs && conn.highWaterMs > 0) {
          setHighWater(this.db, this.projectId, 0)
        }
        conn = getConnection(this.db, this.projectId) ?? conn
      }
    }
    const searchFields =
      conn.sprintFieldId && conn.sprintFieldId !== 'none' ? [...SEARCH_FIELDS, conn.sprintFieldId] : SEARCH_FIELDS

    const frozen = this.frozenLocalIds()
    let jql = `project = "${conn.jiraProjectKey}" ORDER BY updated ASC`
    if (!full && conn.highWaterMs && conn.highWaterMs > 0) {
      // RELATIVE JQL date (`-Nm`) instead of an absolute wall-clock string: an
      // absolute `formatJqlDate(...)` is emitted in UTC but Jira interprets a
      // bare JQL datetime in the ACCOUNT timezone, so on a behind-UTC instance
      // the floor rose above the high-water and silently skipped hours of
      // updates. Relative dates evaluate against Jira's own clock with no TZ
      // wall-clock interpretation, eliminating the gap. The high-water is derived
      // from Jira's own `updated` values, so minutes-ago from the server clock
      // (within the 2-min overlap for skew) maps to the right Jira floor.
      const sinceFloorMs = conn.highWaterMs - POLL_OVERLAP_MS
      const minutesAgo = Math.max(1, Math.ceil((Date.now() - sinceFloorMs) / 60_000))
      jql = `project = "${conn.jiraProjectKey}" AND updated >= "-${minutesAgo}m" ORDER BY updated ASC`
    }

    let nextPageToken: string | undefined
    let totalUpserted = 0
    let maxUpdated = conn.highWaterMs ?? 0
    for (let page = 0; page < 50; page++) {
      const res = await client.searchJql({ jql, fields: searchFields, nextPageToken, maxResults: 100 })
      if (!res.ok) {
        if (res.code === 'auth') this.onAuth401()
        else this.broadcast({ type: 'jira.sync_error', projectId: this.projectId, reason: res.error })
        return null
      }
      const issues: JiraIssue[] = res.data.issues ?? []
      if (issues.length > 0) {
        const r = upsertIssuesIntoStore(this.db, this._artifactRoot(), conn, issues, frozen)
        // Suppress the watcher echo for our own write (avoids the full-board
        // refresh flicker). When nothing changed, `wrote` is false and we also
        // skip the granular broadcasts below — the board stays perfectly still.
        if (r.wrote) this.notifyLocalWrite(r.revision)
        totalUpserted += r.upserted
        if (r.maxUpdatedMs > maxUpdated) maxUpdated = r.maxUpdatedMs
        for (const localId of r.changedLocalIds) {
          const t = readTicket(this._artifactRoot(), localId)
          if (t) this.broadcast({ type: 'ticket_updated', ticket: t, projectId: this.projectId, timestamp: t.updated_at } as WsMessage)
        }
      }
      nextPageToken = res.data.nextPageToken
      if (!nextPageToken || issues.length === 0) break
    }

    if (maxUpdated > (conn.highWaterMs ?? 0)) setHighWater(this.db, this.projectId, maxUpdated)
    if (totalUpserted > 0) this.broadcast({ type: 'jira.synced', projectId: this.projectId, upserted: totalUpserted, at: Date.now() })
    return { upserted: totalUpserted }
  }

  // ─── Outbound write-back hooks ─────────────────────────────────────────────

  /**
   * Called from the rail-launch handler. For each Jira-linked ticket, enqueue an
   * In Progress transition AND write in_progress into the local cache (because
   * backlog-config write_access:false stops core from writing it). No-op for
   * non-Jira projects / unlinked tickets.
   */
  onRailLaunch(ticketIds: number[], jobId: string): void {
    if (!this.isActive()) return
    const ops: EnqueueOutboxInput[] = []
    const linkedIds: number[] = []
    for (const localId of ticketIds) {
      const link = getLinkByLocalId(this.db, localId)
      if (!link || link.tombstoned) continue
      linkedIds.push(localId)
      ops.push({
        jiraIssueId: link.jiraIssueId,
        opType: 'transition',
        idempotencyKey: `${jobId}:${localId}:transition:in_progress`,
        payload: { localId, jiraIssueId: link.jiraIssueId, logicalState: 'in_progress' as SpecLogicalState },
      })
    }
    if (ops.length === 0) return
    enqueueMany(this.db, ops)
    this.writeLocalStatus(linkedIds, 'in_progress')
    this.broadcastOutboxState()
  }

  /**
   * Called after a Jira-backed spec is edited + saved locally. Pushes the changed
   * editable fields (summary/description/labels/priority) to the Jira issue via a
   * durable 'update' op. No-op for non-Jira / unlinked specs. While the op is
   * pending the id is frozen, so the inbound poll won't revert the local edit.
   * Status is intentionally NOT written here (Jira status needs a transition).
   */
  onSpecEdited(
    localId: number,
    changes: { title?: string; description?: string; priority?: string | null; labels?: string[] },
  ): void {
    if (!this.isActive()) return
    const link = getLinkByLocalId(this.db, localId)
    if (!link || link.tombstoned) return
    const conn = getConnection(this.db, this.projectId)
    if (!conn) return

    const fields: Record<string, unknown> = {}
    if (typeof changes.title === 'string' && changes.title.trim()) fields.summary = changes.title.trim().slice(0, 250)
    if (typeof changes.description === 'string') fields.description = bodyForDeployment(changes.description, conn.deployment)
    if (changes.labels !== undefined) fields.labels = (changes.labels ?? []).filter((l) => typeof l === 'string')
    if (changes.priority) {
      const name = PRIORITY_TO_JIRA[changes.priority]
      if (name) fields.priority = { name }
    }
    if (Object.keys(fields).length === 0) return

    const nonce = Date.now().toString(36)
    enqueueMany(this.db, [
      {
        jiraIssueId: link.jiraIssueId,
        opType: 'update',
        idempotencyKey: `update:${localId}:${nonce}`,
        payload: { jiraIssueId: link.jiraIssueId, fields },
      },
    ])
    this.broadcastOutboxState()
    void this.drainOnce().catch(() => undefined)
  }

  /**
   * Called from project-registry's onJobFinished AFTER the local cache mutation.
   * Enqueues the Jira status transition + completion comment per linked ticket.
   */
  onJobOutcome(args: {
    ticketIds: number[]
    status: JobOutcomeStatus
    jobId: string
    costUsd: number | null
    durationMs: number | null
    needsReviewIds?: number[]
  }): void {
    if (!this.isActive()) return
    const needsReview = new Set(args.needsReviewIds ?? [])
    const ops: EnqueueOutboxInput[] = []
    for (const localId of args.ticketIds) {
      const link = getLinkByLocalId(this.db, localId)
      if (!link || link.tombstoned) continue

      const reviewing = needsReview.has(localId)
      // Completion comment (always safe/additive). Marker makes it idempotent.
      const commentText = buildCompletionComment(args, link.jiraKey, reviewing)
      ops.push({
        jiraIssueId: link.jiraIssueId,
        opType: 'comment',
        idempotencyKey: `${args.jobId}:${localId}:comment`,
        payload: { jiraIssueId: link.jiraIssueId, text: commentText, marker: commentMarker(args.jobId, localId) },
      })

      // Status transition: success → done (unless needs_review); else revert → todo.
      // needs_review keeps status unchanged in Jira (no equivalent) — comment only.
      if (reviewing) continue
      const logicalState: SpecLogicalState = args.status === 'completed' ? 'done' : 'todo'
      ops.push({
        jiraIssueId: link.jiraIssueId,
        opType: 'transition',
        idempotencyKey: `${args.jobId}:${localId}:transition:${logicalState}`,
        payload: { localId, jiraIssueId: link.jiraIssueId, logicalState },
      })
    }
    if (ops.length === 0) return
    enqueueMany(this.db, ops)
    this.broadcastOutboxState()
    // Drain promptly (best-effort) so PMs see the update without waiting a tick.
    void this.drainOnce().catch(() => undefined)
  }

  /**
   * "Discard" a Jira-backed spec: instead of a destructive local delete, move the
   * linked issue to the user-configured discard status and (optionally) post a
   * reason comment. The local cache is optimistically flipped to `cancelled` so
   * the spec leaves the active board immediately; the inbound poll later
   * reconciles it to the issue's real status (protected meanwhile by the
   * pending-transition frozen guard).
   */
  discardSpec(
    localId: number,
    comment: string | null
  ): { ok: true } | { ok: false; reason: 'not-active' | 'no-link' | 'not-configured' } {
    if (!this.isActive()) return { ok: false, reason: 'not-active' }
    const link = getLinkByLocalId(this.db, localId)
    if (!link || link.tombstoned) return { ok: false, reason: 'no-link' }
    const conn = getConnection(this.db, this.projectId)
    const target = conn?.discardStatus ?? null
    if (!target) return { ok: false, reason: 'not-configured' }

    // Distinct per-action nonce so a re-discard isn't deduped by idempotency key.
    const nonce = Date.now().toString(36)
    const ops: EnqueueOutboxInput[] = []
    const trimmed = (comment ?? '').trim()
    if (trimmed) {
      ops.push({
        jiraIssueId: link.jiraIssueId,
        opType: 'comment',
        idempotencyKey: `discard:${localId}:${nonce}:comment`,
        payload: { jiraIssueId: link.jiraIssueId, text: trimmed, marker: discardCommentMarker(localId, nonce) },
      })
    }
    ops.push({
      jiraIssueId: link.jiraIssueId,
      opType: 'transition',
      idempotencyKey: `discard:${localId}:${nonce}:transition`,
      payload: { localId, jiraIssueId: link.jiraIssueId, logicalState: 'cancelled' as SpecLogicalState, targetStatus: target },
    })
    enqueueMany(this.db, ops)
    this.writeLocalStatus([localId], 'cancelled')
    this.broadcastOutboxState()
    void this.drainOnce().catch(() => undefined)
    return { ok: true }
  }

  // ─── Outbox drain ──────────────────────────────────────────────────────────

  async drainOnce(): Promise<void> {
    if (this.authPaused) return
    const conn = getConnection(this.db, this.projectId)
    if (!conn || !conn.enabled) return
    const client = this.buildClient()
    if (!client) return

    const batch = claimDrainable(this.db, MAX_DRAIN_BATCH)
    if (batch.length === 0) return

    await Promise.all(batch.map((op) => this.executeOp(client, conn, op)))
    this.broadcastOutboxState()
  }

  private async executeOp(client: JiraClient, conn: JiraConnection, op: OutboxRow): Promise<void> {
    try {
      const payload = JSON.parse(op.payload)
      if (op.opType === 'comment') {
        await this.executeComment(client, op, payload)
      } else if (op.opType === 'transition') {
        await this.executeTransition(client, conn, op, payload)
      } else if (op.opType === 'update') {
        await this.executeUpdate(client, op, payload)
      } else {
        markOutboxDead(this.db, op.id, `unsupported op type ${op.opType}`)
      }
    } catch (err) {
      this.retryOrDead(op, err instanceof Error ? err.message : String(err))
    }
  }

  private async executeUpdate(client: JiraClient, op: OutboxRow, payload: { jiraIssueId: string; fields: Record<string, unknown> }): Promise<void> {
    let res = await client.updateIssue(payload.jiraIssueId, payload.fields)
    // The priority NAME may not match the instance's scheme. Don't let that lose
    // the title/description/labels edit — retry once without priority.
    if (!res.ok && res.code === 'validation' && 'priority' in payload.fields) {
      const { priority: _drop, ...rest } = payload.fields
      void _drop
      if (Object.keys(rest).length > 0) res = await client.updateIssue(payload.jiraIssueId, rest)
    }
    if (res.ok) {
      markOutboxDone(this.db, op.id)
      return
    }
    if (res.code === 'not_found') {
      tombstoneLink(this.db, payload.jiraIssueId)
      markOutboxDead(this.db, op.id, 'issue deleted or inaccessible')
      this.broadcastDegraded(null, 'linked Jira issue no longer reachable')
      return
    }
    this.handleHardError(op, res.code, res.status, res.retryAfterMs, res.error)
  }

  private async executeComment(client: JiraClient, op: OutboxRow, payload: { jiraIssueId: string; text: string; marker: string }): Promise<void> {
    // Idempotency: skip if a comment already carries this op's marker (stored as
    // an invisible comment property, with a legacy body-scan fallback).
    const existing = await client.getComments(payload.jiraIssueId)
    if (existing.ok) {
      const dup = existing.data.comments.some((c) => commentHasMarker(c, payload.marker))
      if (dup) {
        markOutboxDone(this.db, op.id)
        return
      }
    } else if (this.handleHardError(op, existing.code, existing.status, existing.retryAfterMs, existing.error)) {
      return
    }
    // Post the user-facing text only; the marker rides along as a hidden
    // comment property so it never appears in the rendered comment.
    const res = await client.addComment(payload.jiraIssueId, payload.text, payload.marker)
    if (res.ok) {
      markOutboxDone(this.db, op.id)
      return
    }
    this.handleHardError(op, res.code, res.status, res.retryAfterMs, res.error)
  }

  private async executeTransition(
    client: JiraClient,
    conn: JiraConnection,
    op: OutboxRow,
    payload: { jiraIssueId: string; logicalState: SpecLogicalState; targetStatus?: string }
  ): Promise<void> {
    // Re-GET the live issue for idempotency-first: skip if already in target category.
    const issue = await client.getIssue(payload.jiraIssueId, ['status'])
    if (!issue.ok) {
      if (issue.code === 'not_found') {
        tombstoneLink(this.db, payload.jiraIssueId)
        markOutboxDead(this.db, op.id, 'issue deleted or inaccessible')
        this.broadcastDegraded(null, 'linked Jira issue no longer reachable')
        return
      }
      if (this.handleHardError(op, issue.code, issue.status, issue.retryAfterMs, issue.error)) return
      this.retryOrDead(op, issue.error)
      return
    }

    const currentCategory: JiraStatusCategory =
      (issue.data.fields.status?.statusCategory?.key as JiraStatusCategory) ?? 'indeterminate'
    // A per-op explicit target (e.g. the discard "move-to" status) wins over the
    // connection's per-logical-state status map.
    const explicitTarget = payload.targetStatus ?? conn.statusMap?.[payload.logicalState]

    const outcome: WalkOutcome = await walkToCategory({
      state: payload.logicalState,
      currentCategory,
      explicitTarget,
      getTransitions: async () => {
        const res = await client.getTransitions(payload.jiraIssueId)
        if (!res.ok) throw new JiraOpError(res.code, res.status, res.retryAfterMs, res.error)
        return res.data.transitions
      },
      applyTransition: async (transition: JiraTransition) => {
        const plan = buildTransitionFields(transition, payload.logicalState)
        const res = await client.transitionIssue(payload.jiraIssueId, transition.id, plan.fields)
        if (!res.ok) throw new JiraOpError(res.code, res.status, res.retryAfterMs, res.error)
      },
    })

    switch (outcome.status) {
      case 'noop':
      case 'applied':
        markOutboxDone(this.db, op.id)
        return
      case 'no_path':
      case 'blocked':
        markOutboxDead(this.db, op.id, outcome.reason)
        this.broadcastDegraded(null, `status not synced — ${outcome.reason}; manual move may be needed`)
        return
      case 'error':
        this.retryOrDead(op, outcome.reason)
        return
    }
  }

  /**
   * Centralised hard-error handling. Returns true when the error was terminal
   * (op finished/parked/dead) and the caller must stop.
   */
  private handleHardError(op: OutboxRow, code: string, status: number, retryAfterMs: number | undefined, error: string): boolean {
    if (code === 'auth') {
      this.onAuth401()
      // Park the op back to pending so it replays after re-auth.
      markOutboxRetry(this.db, op.id, new Date(Date.now() + 60_000).toISOString(), 'auth: token expired/revoked')
      return true
    }
    if (code === 'permission') {
      markOutboxDead(this.db, op.id, `permission denied (403): ${error}`)
      this.broadcastDegraded(null, 'your Jira account cannot perform this operation')
      return true
    }
    if (code === 'not_found') {
      tombstoneLink(this.db, op.jiraIssueId)
      markOutboxDead(this.db, op.id, 'issue deleted or inaccessible')
      return true
    }
    if (code === 'validation' || code === 'no_transition') {
      markOutboxDead(this.db, op.id, `validation error: ${error}`)
      return true
    }
    if (code === 'rate_limit') {
      const delay = retryAfterMs ?? backoffMs(op.attempts)
      markOutboxRetry(this.db, op.id, new Date(Date.now() + delay).toISOString(), `rate limited (429)`)
      return true
    }
    // server / network → retry with backoff
    this.retryOrDead(op, error)
    return true
  }

  private retryOrDead(op: OutboxRow, error: string): void {
    if (error.startsWith('JiraOpError:')) {
      // Unwrap a thrown JiraOpError to classify it.
      const parsed = JiraOpError.parse(error)
      if (parsed) {
        this.handleHardError(op, parsed.code, parsed.status, parsed.retryAfterMs, parsed.message)
        return
      }
    }
    const MAX_ATTEMPTS = 6
    if (op.attempts + 1 >= MAX_ATTEMPTS) {
      markOutboxDead(this.db, op.id, `exhausted retries: ${error}`)
      return
    }
    markOutboxRetry(this.db, op.id, new Date(Date.now() + backoffMs(op.attempts)).toISOString(), error)
  }

  private onAuth401(): void {
    this.authPaused = true
    const pending = listOutbox(this.db, { state: 'pending' }).length + listOutbox(this.db, { state: 'inflight' }).length
    this.broadcast({ type: 'jira.auth_expired', projectId: this.projectId, pending })
  }

  /** Re-paste of a fresh token clears the auth-pause and drains the parked outbox. */
  resumeAfterReauth(): void {
    this.authPaused = false
    void this.drainOnce().catch(() => undefined)
  }

  // ─── Local cache helpers ───────────────────────────────────────────────────

  private writeLocalStatus(localIds: number[], status: TicketStatus): void {
    if (localIds.length === 0) return
    try {
      const file = resolveTicketStoragePath(this._artifactRoot())
      const ids = new Set(localIds.map(String))
      const now = new Date().toISOString()
      const store = mutateStore(file, (s) => {
        for (const id of ids) {
          const t = s.tickets[id]
          if (t && t.status !== status) {
            t.status = status
            t.updated_at = now
          }
        }
      })
      this.notifyLocalWrite(store.revision)
      for (const id of ids) {
        const t = store.tickets[id]
        if (t) this.broadcast({ type: 'ticket_updated', ticket: t as unknown as never, projectId: this.projectId, timestamp: t.updated_at } as WsMessage)
      }
    } catch (err) {
      console.error('[jira-sync] writeLocalStatus failed:', err)
    }
  }

  private broadcastOutboxState(): void {
    const counts = countOutboxByState(this.db)
    this.broadcast({ type: 'jira.outbox_changed', projectId: this.projectId, pending: counts.pending + counts.inflight, dead: counts.dead })
  }

  private broadcastDegraded(jiraKey: string | null, reason: string): void {
    this.broadcast({ type: 'jira.degraded', projectId: this.projectId, jiraKey, reason })
  }

  // ─── Read-only details panel (issue fields + Development) ───────────────────

  /**
   * Build the read-only "Jira details" + "Development" payload for a Jira-backed
   * spec. Resilient: the issue fetch is load-bearing, but a /field or dev-status
   * failure still returns the fields (with humanized labels / empty development).
   */
  async getSpecDetails(
    localId: number
  ): Promise<{ ok: true; details: JiraSpecDetails } | { ok: false; reason: 'not-active' | 'no-link' | 'issue-error'; status?: number }> {
    if (!this.isActive()) return { ok: false, reason: 'not-active' }
    const link = getLinkByLocalId(this.db, localId)
    if (!link || link.tombstoned) return { ok: false, reason: 'no-link' }
    const conn = getConnection(this.db, this.projectId)
    const client = this.buildClient()
    if (!conn || !client) return { ok: false, reason: 'not-active' }

    // 1) Fields — load-bearing.
    const issueRes = await client.getIssueRaw(link.jiraIssueId)
    if (!issueRes.ok) {
      if (issueRes.code === 'auth') this.onAuth401()
      if (issueRes.code === 'not_found') tombstoneLink(this.db, link.jiraIssueId)
      return { ok: false, reason: 'issue-error', status: issueRes.status }
    }
    // 2) /field metadata — best effort.
    const metaRes = await client.getFieldsFull()
    const fieldMeta = metaRes.ok ? metaRes.data : []
    // 3) Materialized ticket flags suppress already-shown info (no extra HTTP).
    const ticket = readStore(resolveTicketStoragePath(this._artifactRoot())).tickets[String(localId)]
    const fields = formatIssueFields({
      fields: issueRes.data.fields,
      fieldMeta,
      baseUrl: conn.baseUrl,
      alreadyShown: { hasEpicKey: !!ticket?.jira_epic_key, hasSprintName: !!ticket?.jira_sprint_name },
    })
    // 4) Development — best effort, fully isolated.
    const development = await this.fetchDevelopment(client, link.jiraIssueId).catch(() => ({
      pullRequests: [],
      branches: [],
      commits: [],
    }))
    return { ok: true, details: { fields, development } }
  }

  /** Two-call dev-status fetch (summary → detail per applicationType). Never throws. */
  private async fetchDevelopment(client: JiraClientT, issueId: string): Promise<JiraSpecDetails['development']> {
    const empty = { pullRequests: [], branches: [], commits: [] }
    const summary = await client.getDevStatusSummary(issueId)
    if (!summary.ok) {
      if (summary.code === 'auth') this.onAuth401()
      return empty
    }
    const appTypesFor = (key: string): string[] => Object.keys(summary.data.summary?.[key]?.byInstanceType ?? {})
    const development = { pullRequests: [] as JiraSpecDetails['development']['pullRequests'], branches: [] as JiraSpecDetails['development']['branches'], commits: [] as JiraSpecDetails['development']['commits'] }
    const collect = async (key: string, dataType: DevStatusDataType, sink: (d: import('./jira-client').JiraDevDetailRaw) => void) => {
      for (const app of appTypesFor(key)) {
        const res = await client.getDevStatusDetail(issueId, app, dataType)
        if (res.ok) sink(res.data)
      }
    }
    await collect('pullrequest', 'pullrequest', (d) => development.pullRequests.push(...normalizePullRequests(d)))
    await collect('branch', 'branch', (d) => development.branches.push(...normalizeBranches(d)))
    await collect('repository', 'repository', (d) => development.commits.push(...normalizeRepositoryCommits(d)))
    return development
  }

  // ─── Read helpers for the router ───────────────────────────────────────────

  listLinks() {
    return listLinks(this.db)
  }

  listOutbox(state?: OutboxRow['state']) {
    return listOutbox(this.db, state ? { state } : {})
  }

  outboxCounts() {
    return countOutboxByState(this.db)
  }
}

// ─── Error envelope for thrown client failures inside the walk ─────────────────

class JiraOpError extends Error {
  code: string
  status: number
  retryAfterMs?: number
  constructor(code: string, status: number, retryAfterMs: number | undefined, message: string) {
    super(`JiraOpError:${code}:${status}:${retryAfterMs ?? ''}:${message}`)
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
  static parse(msg: string): { code: string; status: number; retryAfterMs?: number; message: string } | null {
    if (!msg.startsWith('JiraOpError:')) return null
    const rest = msg.slice('JiraOpError:'.length)
    const [code, statusStr, retryStr, ...msgParts] = rest.split(':')
    return {
      code,
      status: parseInt(statusStr, 10) || 0,
      retryAfterMs: retryStr ? parseInt(retryStr, 10) : undefined,
      message: msgParts.join(':'),
    }
  }
}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

export function backoffMs(attempts: number): number {
  const base = Math.min(30_000, 2000 * 2 ** attempts)
  const jitter = (attempts * 137) % 1000 // deterministic jitter (no Math.random)
  return base + jitter
}

/** Format an epoch-ms as Jira JQL date `"yyyy-MM-dd HH:mm"` (UTC). */
export function formatJqlDate(ms: number): string {
  const d = new Date(Math.max(0, ms))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

export function buildCompletionComment(
  args: { status: JobOutcomeStatus; jobId: string; costUsd: number | null; durationMs: number | null },
  jiraKey: string | null,
  needsReview: boolean
): string {
  if (needsReview) {
    return 'Specrails: the implementation rail terminated abnormally after its Ship phase — the result needs review.'
  }
  const parts: string[] = []
  if (args.status === 'completed') {
    parts.push('✅ Implementation completed by a Specrails rail.')
  } else if (args.status === 'canceled') {
    parts.push('⏹️ The Specrails implementation rail was cancelled — the spec was returned to the backlog.')
  } else {
    parts.push('❌ The Specrails implementation rail failed — the spec was returned to the backlog.')
  }
  const meta: string[] = [`job ${args.jobId}`]
  if (args.costUsd != null) meta.push(`cost $${args.costUsd.toFixed(2)}`)
  if (args.durationMs != null) meta.push(`duration ${formatDuration(args.durationMs)}`)
  parts.push(`(${meta.join(' · ')})`)
  return parts.join('\n')
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem ? `${m}m ${rem}s` : `${m}m`
}

// Read a single ticket back from the store for a ticket_updated broadcast.
function readTicket(projectPath: string, localId: number): import('../types').LocalTicket | null {
  try {
    const store = readStore(resolveTicketStoragePath(projectPath))
    const t = store.tickets[String(localId)]
    return (t as unknown as import('../types').LocalTicket) ?? null
  } catch {
    return null
  }
}
