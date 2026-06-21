import fs from 'fs'
import path from 'path'

// âââ Types âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

export type TicketStatus = 'draft' | 'todo' | 'in_progress' | 'done' | 'cancelled'
export type TicketPriority = 'critical' | 'high' | 'medium' | 'low'

export interface Attachment {
  id: string
  filename: string
  storedName: string
  mimeType: string
  size: number
  addedAt: string
}

export interface Ticket {
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
  }
  comments?: Array<{
    id: number
    body: string
    created_at: string
    created_by: string
  }>
  attachments?: Attachment[]
  origin_conversation_id: string | null
  is_epic: boolean
  parent_epic_id: number | null
  execution_order: number | null
  short_summary: string | null
  created_at: string
  updated_at: string
  created_by: string
  // 'hub' is a persisted on-disk value (tickets.json) shared with specrails-core —
  // legacy wire value kept for compat, do not rename.
  // 'jira' marks a spec materialized from a Jira issue (see server/jira/). The
  // jira_key / jira_url fields below are additive — specrails-core ignores them.
  source: 'manual' | 'product-backlog' | 'propose-spec' | 'get-backlog-specs' | 'hub' | 'explore-draft' | 'specs-smash' | 'free-prompt' | 'jira'
  /** Display key of the linked Jira issue (e.g. "PROJ-123"), null for local specs. */
  jira_key?: string | null
  /** Browser URL of the linked Jira issue, null for local specs. */
  jira_url?: string | null
  /** Key of the Jira parent epic (e.g. "PROJ-5"), when the issue has one. */
  jira_epic_key?: string | null
  /** Summary/name of the Jira parent epic, when the issue has one. */
  jira_epic_name?: string | null
  /** Id of the issue's (active) Jira sprint, when it has one. */
  jira_sprint_id?: string | null
  /** Name of the issue's (active) Jira sprint, when it has one. */
  jira_sprint_name?: string | null
  /** State of that sprint: 'active' (the current sprint) | 'future' | 'closed'. */
  jira_sprint_state?: string | null
  /**
   * App-managed review flag. Set when a job had already marked this spec `done`
   * (the agent reached its Ship phase) but the job then failed / was canceled /
   * was zombie-killed â so the spec stays in the Done column but the board warns
   * it may be incomplete. Cleared on the next clean completion. specrails-core
   * never reads or writes this field.
   */
  needs_review?: boolean
}

export interface TicketStore {
  schema_version: string
  revision: number
  last_updated: string
  next_id: number
  tickets: Record<string, Ticket>
}

const VALID_STATUSES = new Set<TicketStatus>(['draft', 'todo', 'in_progress', 'done', 'cancelled'])
const VALID_PRIORITIES = new Set<TicketPriority>(['critical', 'high', 'medium', 'low'])

export const CURRENT_SCHEMA_VERSION = '1.3'

export const SHORT_SUMMARY_MAX_LEN = 240

/**
 * Sanitize a `shortSummary` value coming from an AI response or external input.
 * - Returns `null` for nullish, non-string, or empty-after-trim values.
 * - Strips control characters, collapses whitespace, trims.
 * - Hard-caps to `SHORT_SUMMARY_MAX_LEN` characters (server-side safety net).
 */
export function clampShortSummary(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return null
  // Strip ASCII control chars (except common whitespace) and collapse runs.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0) return null
  if (cleaned.length > SHORT_SUMMARY_MAX_LEN) {
    return cleaned.slice(0, SHORT_SUMMARY_MAX_LEN)
  }
  return cleaned
}

const DEFAULT_STORAGE_PATH = '.specrails/local-tickets.json'
const LOCK_SUFFIX = '.lock'
const LOCK_STALE_MS = 10_000 // 10 seconds

// âââ Path resolution âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

/** True when `candidate` resolves to a path inside (or equal to) `root`. */
function isContainedIn(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root)
  const rel = path.relative(normalizedRoot, candidate)
  // Inside the root: relative path is non-empty, does not climb out with '..',
  // and is not absolute (which path.relative returns when on a different drive).
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function resolveTicketStoragePath(projectPath: string): string {
  const fallback = path.resolve(projectPath, DEFAULT_STORAGE_PATH)
  // Try to read ticketProvider.storagePath from integration-contract.json
  const contractPath = path.join(projectPath, '.claude', 'integration-contract.json')
  if (fs.existsSync(contractPath)) {
    try {
      const contract = JSON.parse(fs.readFileSync(contractPath, 'utf-8'))
      if (contract.ticketProvider?.storagePath) {
        const resolved = path.resolve(projectPath, contract.ticketProvider.storagePath)
        // A2: integration-contract.json is read FROM THE PROJECT REPO and is
        // therefore untrusted (a hostile repo added as a project). path.resolve
        // lets an absolute or '../../..'-escaping storagePath redirect the ticket
        // store to ANY file on disk â and every ticket mutation then overwrites
        // that file via writeStore(). Reject anything outside the project root
        // and fall back to the default location.
        if (isContainedIn(projectPath, resolved)) {
          return resolved
        }
        console.warn(`[ticket-store] ignoring out-of-project storagePath from integration-contract.json: ${contract.ticketProvider.storagePath}`)
      }
    } catch {
      // Fall through to default
    }
  }
  return fallback
}

// âââ Advisory file locking âââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * BUG-SQLITE-02: read the pid recorded inside a lock file and report whether
 * that owning process is provably dead on THIS host. Returns:
 *  - `true`  only when the pid is a valid integer AND `process.kill(pid, 0)`
 *    throws ESRCH (the process does not exist) -> the lock is reclaimable now.
 *  - `false` when the pid is unreadable/malformed, is our own live pid, or the
 *    process is alive (or owned by another user -> EPERM). The mtime TTL is the
 *    cross-host fallback for these cases.
 */
function lockOwnerIsDead(lockPath: string): boolean {
  let pid: number
  try {
    const contents = fs.readFileSync(lockPath, 'utf-8').trim()
    pid = Number.parseInt(contents, 10)
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    // Foreign / partial-write lock content: cannot prove death, defer to TTL.
    return false
  }
  try {
    // Signal 0 performs error checking without delivering a signal.
    process.kill(pid, 0)
    return false // process exists -> owner alive
  } catch (err: any) {
    // ESRCH: no such process -> provably dead. EPERM: process exists but we may
    // not signal it -> alive. Anything else: be conservative and defer to TTL.
    return err && err.code === 'ESRCH'
  }
}

function acquireLock(filePath: string): void {
  const lockPath = filePath + LOCK_SUFFIX
  const maxAttempts = 50
  const retryDelay = 50 // ms

  // Ensure parent directory exists before attempting lock
  const dir = path.dirname(lockPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  for (let i = 0; i < maxAttempts; i++) {
    try {
      // O_EXCL ensures atomic create-if-not-exists
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Check for stale lock
        try {
          const stat = fs.statSync(lockPath)
          // BUG-SQLITE-02: owner-PID liveness check. The lock records the
          // writer's pid; if that process is gone the lock is stale RIGHT NOW
          // (no need to wait out the mtime TTL). process.kill(pid, 0) probes
          // liveness without sending a signal: it throws ESRCH when the pid does
          // not exist (-> stale, reclaim). EPERM means the process exists but is
          // owned by another user (-> alive, keep the lock). A malformed pid
          // (foreign/partial write) is ignored and we fall back to mtime TTL.
          if (lockOwnerIsDead(lockPath)) {
            fs.unlinkSync(lockPath)
            continue
          }
          // Cross-host / unknown-owner fallback: reclaim on mtime TTL.
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lockPath)
            continue
          }
        } catch {
          // Lock file disappeared, retry
          continue
        }
        // Wait and retry
        const waitUntil = Date.now() + retryDelay
        while (Date.now() < waitUntil) { /* busy wait for short duration */ }
        continue
      }
      throw err
    }
  }
  throw new Error('Could not acquire lock on ticket store')
}

function releaseLock(filePath: string): void {
  const lockPath = filePath + LOCK_SUFFIX
  try {
    fs.unlinkSync(lockPath)
  } catch {
    // Lock already released or missing
  }
}

// âââ Store operations ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function emptyStore(): TicketStore {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    revision: 0,
    last_updated: new Date().toISOString(),
    next_id: 1,
    tickets: {},
  }
}

/**
 * Normalise a ticket loaded from disk so older stores (schema_version < 1.1)
 * surface the new fields with sensible defaults. Mutates the input for speed
 * and returns it.
 */
function normalizeTicket(t: Ticket): Ticket {
  if (!('origin_conversation_id' in t) || t.origin_conversation_id === undefined) {
    t.origin_conversation_id = null
  }
  if (t.priority === undefined) {
    // Older stores guaranteed a non-null priority; treat undefined defensively
    // as null only when status is 'draft', otherwise keep undefined â caller
    // sees it as TicketPriority|null which it must handle.
    t.priority = null
  }
  // Schema 1.2 fields (specs-smash).
  if (!('is_epic' in t) || t.is_epic === undefined) {
    t.is_epic = false
  }
  if (!('parent_epic_id' in t) || t.parent_epic_id === undefined) {
    t.parent_epic_id = null
  }
  if (!('execution_order' in t) || t.execution_order === undefined) {
    t.execution_order = null
  }
  // Schema 1.3 field: AI-generated short summary for postit dashboard view.
  if (!('short_summary' in t) || t.short_summary === undefined) {
    t.short_summary = null
  }
  return t
}

/**
 * Defensive integrity check used after Ã©pica/child mutations: every ticket
 * with parent_epic_id must reference an existing ticket whose is_epic === true.
 * Returns an array of violation messages (empty when the store is consistent).
 */
export function validateEpicChildIntegrity(store: TicketStore): string[] {
  const errors: string[] = []
  for (const id of Object.keys(store.tickets)) {
    const t = store.tickets[id]
    if (t.parent_epic_id === null || t.parent_epic_id === undefined) continue
    const parent = store.tickets[String(t.parent_epic_id)]
    if (!parent) {
      errors.push(`ticket ${t.id} references missing parent_epic_id=${t.parent_epic_id}`)
      continue
    }
    if (!parent.is_epic) {
      errors.push(`ticket ${t.id} parent ${t.parent_epic_id} is not an epic`)
    }
  }
  return errors
}

export function readStore(filePath: string): TicketStore {
  // BUG-SQLITE-03: distinguish a genuinely-absent file (-> emptyStore, the first
  // write creates it) from a PRESENT-but-unreadable/unparseable/foreign-shaped
  // file. The latter must THROW so mutateStore aborts and never overwrites the
  // on-disk data with an empty store (which would permanently wipe the backlog).
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (err: any) {
    // ENOENT (file does not exist) is the only condition that maps to an empty
    // store. Any other read error (EACCES, EISDIR, EIO, ...) is a present file
    // we must not blank, so re-throw.
    if (err && err.code === 'ENOENT') {
      return emptyStore()
    }
    throw err
  }

  let data: TicketStore
  try {
    data = JSON.parse(raw) as TicketStore
  } catch (err) {
    // Present-but-unparseable JSON (hand-edit, partial external write, disk
    // corruption). Throwing preserves the on-disk bytes - mutateStore aborts.
    throw new Error(`ticket store at ${filePath} is present but contains invalid JSON: ${(err as Error).message}`)
  }

  // Foreign / wrong top-level shape: a present file that is valid JSON but does
  // not look like a TicketStore. Throw rather than blank it.
  if (
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !data.tickets ||
    typeof data.tickets !== 'object' ||
    typeof data.revision !== 'number'
  ) {
    throw new Error(`ticket store at ${filePath} is present but has an unexpected top-level shape`)
  }
  {
    // Normalise per-ticket fields added in schema 1.1 without rewriting the
    // file â version bump only happens on next write via writeStore. Guard each
    // entry so a single corrupt/non-object value (hand-edit, partial-write
    // recovery, schema drift) drops only that ticket instead of discarding the
    // ENTIRE store (which the next mutation would then persist permanently).
    for (const id of Object.keys(data.tickets)) {
      const entry = data.tickets[id]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        delete data.tickets[id]
        continue
      }
      try {
        data.tickets[id] = normalizeTicket(entry)
      } catch {
        delete data.tickets[id]
      }
    }
    return data
  }
}

function writeStore(filePath: string, store: TicketStore): void {
  store.last_updated = new Date().toISOString()
  store.revision++
  // Bump schema_version on first write under the new code so consumers can
  // detect the new shape. Existing 1.0 stores read fine; we only upgrade once
  // we've actually persisted something (which means normalize ran).
  store.schema_version = CURRENT_SCHEMA_VERSION
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  // Atomic write: serialise to a sibling temp file then rename over the target.
  // A crash mid-write can only leave the (ignored) temp file truncated â the
  // real store is replaced in one atomic rename, never left half-written. Always
  // runs under the advisory lock (mutateStore/withLock), so the fixed temp name
  // cannot collide with a concurrent writer in this process.
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}

export type JobOutcome = 'completed' | 'failed' | 'canceled' | 'zombie_terminated'

/**
 * Apply a finished job's outcome to the referenced tickets, in place, and return
 * the ids that actually changed (so the caller can broadcast just those).
 *
 * - `completed`: promote `todo`/`in_progress` â `done` (never resurrect a `draft`
 *   or a `cancelled` spec into Done); clear any stale `needs_review` flag.
 * - `failed`/`canceled`/`zombie_terminated`: revert an `in_progress` spec â `todo`
 *   (back to the Specs column). If the agent had already marked it `done` (its
 *   Ship phase ran, then the process died), keep it `done` but set `needs_review`
 *   so the board flags it for review.
 */
export function applyJobOutcomeToTickets(
  store: TicketStore,
  ticketIds: readonly number[],
  outcome: JobOutcome,
  now: string,
): number[] {
  const changed: number[] = []
  for (const tid of ticketIds) {
    const ticket = store.tickets[String(tid)]
    if (!ticket) continue
    if (outcome === 'completed') {
      const promotable = ticket.status === 'todo' || ticket.status === 'in_progress'
      const clearWarning = ticket.needs_review === true
      if (!promotable && !clearWarning) continue
      if (promotable) ticket.status = 'done'
      if (clearWarning) delete ticket.needs_review
      ticket.updated_at = now
      changed.push(tid)
    } else if (ticket.status === 'in_progress') {
      ticket.status = 'todo'
      ticket.updated_at = now
      changed.push(tid)
    } else if (ticket.status === 'done' && ticket.needs_review !== true) {
      ticket.needs_review = true
      ticket.updated_at = now
      changed.push(tid)
    }
  }
  return changed
}

/** Execute a read-modify-write cycle with advisory locking */
export function withLock<T>(filePath: string, fn: (store: TicketStore) => T): T {
  acquireLock(filePath)
  try {
    return fn(readStore(filePath))
  } finally {
    releaseLock(filePath)
  }
}

/** Execute a read-modify-write cycle, writing changes back */
export function mutateStore(filePath: string, fn: (store: TicketStore) => void): TicketStore {
  acquireLock(filePath)
  try {
    const store = readStore(filePath)
    fn(store)
    writeStore(filePath, store)
    return store
  } finally {
    releaseLock(filePath)
  }
}

// âââ Query helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Extract unique ticket ids referenced via `#<digits>` tokens in a command
 * string, preserving first-occurrence order.
 */
export function extractTicketIdsFromCommand(command: string): number[] {
  const ids: number[] = []
  const seen = new Set<number>()
  for (const match of command.matchAll(/#(\d+)/g)) {
    const id = Number.parseInt(match[1], 10)
    if (Number.isNaN(id) || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Resolve `#<digits>` ticket references in a command to `{ id, title }` pairs
 * by reading the project's local ticket store. Tickets that no longer exist
 * resolve to `title: null`. Returns `[]` when the command has no ticket
 * references.
 */
export function resolveTicketsFromCommand(
  projectPath: string,
  command: string,
  /** Relocate-artifacts: when provided, read the store from this absolute path
   *  (the workspace ticket store) instead of `resolveTicketStoragePath(
   *  projectPath)`. Legacy callers omit it and behave byte-identically. */
  ticketsPathOverride?: string,
): Array<{ id: number; title: string | null }> {
  const ids = extractTicketIdsFromCommand(command)
  if (ids.length === 0) return []
  const store = readStore(ticketsPathOverride ?? resolveTicketStoragePath(projectPath))
  return ids.map((id) => ({
    id,
    title: store.tickets[String(id)]?.title ?? null,
  }))
}

export interface TicketFilters {
  status?: string
  label?: string
  q?: string
}

export function filterTickets(tickets: Ticket[], filters: TicketFilters): Ticket[] {
  let result = tickets

  if (filters.status) {
    const statuses = filters.status.split(',').map(s => s.trim())
    result = result.filter(t => statuses.includes(t.status))
  }

  if (filters.label) {
    const labels = filters.label.split(',').map(l => l.trim().toLowerCase())
    result = result.filter(t =>
      t.labels.some(tl => labels.includes(tl.toLowerCase()))
    )
  }

  if (filters.q) {
    const query = filters.q.toLowerCase()
    result = result.filter(t =>
      t.title.toLowerCase().includes(query) ||
      t.description.toLowerCase().includes(query)
    )
  }

  return result
}

// âââ Validation helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââ

export function isValidStatus(s: unknown): s is TicketStatus {
  return typeof s === 'string' && VALID_STATUSES.has(s as TicketStatus)
}

export function isValidPriority(p: unknown): p is TicketPriority {
  return typeof p === 'string' && VALID_PRIORITIES.has(p as TicketPriority)
}

/**
 * Single source of truth for the rule: priority MAY be null only while the
 * ticket has status='draft'. Returns an error string (suitable for HTTP 400
 * responses) when the combination is invalid, or `null` when valid.
 */
export function validatePriorityForStatus(
  status: TicketStatus,
  priority: TicketPriority | null,
): string | null {
  if (status === 'draft') {
    // null is allowed; non-null must still be a valid priority value.
    if (priority !== null && !isValidPriority(priority)) {
      return 'invalid priority value'
    }
    return null
  }
  if (priority === null) {
    return `priority is required when status='${status}'`
  }
  if (!isValidPriority(priority)) {
    return 'invalid priority value'
  }
  return null
}
