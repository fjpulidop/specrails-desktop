/**
 * Construction story — per-file "how it was built" data for the Code/Files
 * explorer (server side).
 *
 * Two responsibilities:
 *
 * 1. `recordLoopRunProvenance` — the SEAM that gives LOOP RUNS the same
 *    Code-Explorer provenance QueueManager jobs already record. Loop runs
 *    (both isolated worktree rails via rail-isolated-launch.ts and shared-cwd
 *    rails via rails-router.ts) settle outside QueueManager, so before this
 *    module they recorded NO file_provenance at all — the entire loop-based
 *    implement path was invisible to the Code explorer. Callers snapshot the
 *    working tree before the run (snapshotWorkingTree) and call this at
 *    settle; it diffs, collects patches, records rows (+ story stats via
 *    recordProvenanceForJob's transaction) and broadcasts, mirroring
 *    queue-manager's `_recordProvenance` byte-for-byte in behaviour.
 *
 * 2. Story assembly + AI contribution persistence — `getFileStory` joins
 *    file_provenance with file_story_contributions (migration 37) and
 *    enriches each intervention with the ticket's title/status;
 *    `setContributionSummary` persists the plain-language paragraph the
 *    file-story-manager generates on demand.
 */
import type { DbInstance } from './db'
import type { WsMessage } from './types'
import { isCodeExplorerEnabled } from './feature-flags'
import {
  diffAgainstSnapshot,
  collectDiffPatches,
  recordProvenanceForJob,
  broadcastProvenanceUpdated,
  type WorkingTreeSnapshot,
  type ProvenanceKind,
} from './file-provenance'

/** Warn threshold mirroring queue-manager's `provenance.large_job`. */
const LARGE_RUN_WARN_FILES = 50

export interface FileStoryEntry {
  provenanceId: number
  jobId: string | null
  ticketId: number | null
  kind: ProvenanceKind
  at: number
  addedLines: number | null
  removedLines: number | null
  hasPatch: boolean
  summary: string | null
  summaryModel: string | null
  summaryGeneratedAt: string | null
  ticket: { id: number; title: string | null; status: string | null } | null
}

export interface ContributionRow {
  provenance_id: number
  job_id: string | null
  file_path: string
  added_lines: number
  removed_lines: number
  patch_excerpt: string | null
  summary: string | null
  summary_model: string | null
  summary_generated_at: string | null
}

export interface LoopRunProvenanceInput {
  db: DbInstance
  projectId: string
  /** The loop run id — recorded as file_provenance.job_id so the existing
   *  `/code/diff?jobId=` endpoint and job-context filters key off it. */
  runId: string
  /** Primary ticket of the run (attribution target). */
  ticketId: number | null
  /** The repo/worktree the run wrote into (the diff target). */
  repoDir: string
  /** Pre-run snapshot taken by the caller (snapshotWorkingTree(repoDir)). */
  snapshot: WorkingTreeSnapshot | null
  broadcast: (msg: WsMessage) => void
}

/** Injectable IO so unit tests need no real git repo. */
export interface LoopRunProvenanceIO {
  diff?: typeof diffAgainstSnapshot
  patches?: typeof collectDiffPatches
}

/**
 * Record Code-Explorer provenance for a settled loop run. Single chokepoint:
 * gated by the code-explorer flag, never throws (a provenance failure must
 * never break a rail settle). Returns the number of provenance rows written.
 */
export function recordLoopRunProvenance(input: LoopRunProvenanceInput, io: LoopRunProvenanceIO = {}): number {
  if (!isCodeExplorerEnabled()) return 0
  if (!input.snapshot) return 0
  const diffFn = io.diff ?? diffAgainstSnapshot
  const patchesFn = io.patches ?? collectDiffPatches
  try {
    const ref = input.snapshot.ref
    const diff = diffFn(input.repoDir, ref, input.snapshot.untracked, input.snapshot.headSha)
    if (diff.length === 0) return 0
    const patches = patchesFn(input.repoDir, ref, diff, input.snapshot.headSha)
    if (diff.length > LARGE_RUN_WARN_FILES) {
      console.warn(`[provenance.large_job] job=${input.runId} files=${diff.length}`)
    }
    const rows = recordProvenanceForJob(
      input.db,
      input.projectId,
      input.runId,
      input.ticketId,
      diff,
      Date.now(),
      patches,
    )
    for (const row of rows) {
      try { broadcastProvenanceUpdated(input.broadcast, input.projectId, row) } catch { /* non-fatal */ }
    }
    return rows.length
  } catch (err) {
    console.warn(`[file-story] loop-run provenance recording failed: ${(err as Error).message}`)
    return 0
  }
}

/** Read one contribution row by provenance id (null when absent / pre-37 DB). */
export function getContribution(db: DbInstance, provenanceId: number): ContributionRow | null {
  try {
    const row = db.prepare(
      `SELECT provenance_id, job_id, file_path, added_lines, removed_lines,
              patch_excerpt, summary, summary_model, summary_generated_at
       FROM file_story_contributions WHERE provenance_id = ?`,
    ).get(provenanceId) as ContributionRow | undefined
    return row ?? null
  } catch {
    return null
  }
}

/** Persist the AI-generated contribution paragraph for one intervention.
 *  Inserts the row when the intervention pre-dates migration 37 / had no patch. */
export function setContributionSummary(
  db: DbInstance,
  provenanceId: number,
  summary: string,
  model: string,
  generatedAtIso: string = new Date().toISOString(),
): boolean {
  try {
    const updated = db.prepare(
      `UPDATE file_story_contributions
       SET summary = ?, summary_model = ?, summary_generated_at = ?
       WHERE provenance_id = ?`,
    ).run(summary, model, generatedAtIso, provenanceId)
    if (updated.changes > 0) return true
    // No stats row yet (historical touch without a stored patch) — create one
    // carrying only the summary, keyed off the provenance row's identity.
    const prov = db.prepare(
      `SELECT id, file_path, job_id FROM file_provenance WHERE id = ?`,
    ).get(provenanceId) as { id: number; file_path: string; job_id: string | null } | undefined
    if (!prov) return false
    db.prepare(
      `INSERT OR REPLACE INTO file_story_contributions
         (provenance_id, job_id, file_path, added_lines, removed_lines, patch_excerpt, summary, summary_model, summary_generated_at)
       VALUES (?, ?, ?, 0, 0, NULL, ?, ?, ?)`,
    ).run(provenanceId, prov.job_id, prov.file_path, summary, model, generatedAtIso)
    return true
  } catch {
    return false
  }
}

export type TicketSpecLookup = (ticketId: number) => { id?: number; title?: string; status?: string } | undefined

/**
 * Assemble the chronological construction story for one file: every
 * intervention (oldest first — a construction story reads forward in time),
 * each carrying diff stats + the AI contribution when available, enriched
 * with the spec's live title/status. Ticket lookups are failure-tolerant.
 */
export function getFileStory(
  db: DbInstance,
  filePath: string,
  getTicketSpec?: TicketSpecLookup,
): FileStoryEntry[] {
  let rows: Array<{
    id: number
    ticket_id: number | null
    job_id: string | null
    kind: ProvenanceKind
    at: number
    added_lines: number | null
    removed_lines: number | null
    patch_excerpt: string | null
    summary: string | null
    summary_model: string | null
    summary_generated_at: string | null
    patch_count: number
  }>
  try {
    rows = db.prepare(
      `SELECT p.id, p.file_path, p.ticket_id, p.job_id, p.kind, p.at,
              c.added_lines, c.removed_lines, c.patch_excerpt,
              c.summary, c.summary_model, c.summary_generated_at,
              (SELECT COUNT(*) FROM file_provenance_diffs d WHERE d.provenance_id = p.id) AS patch_count
       FROM file_provenance p
       LEFT JOIN file_story_contributions c ON c.provenance_id = p.id
       WHERE p.file_path = ?
       ORDER BY p.at ASC, p.id ASC`,
    ).all(filePath) as typeof rows
  } catch {
    // Pre-migration-37 DB — degrade to the bare provenance rows (honest
    // fallback story: kind + date + spec only).
    rows = (db.prepare(
      `SELECT id, ticket_id, job_id, kind, at FROM file_provenance WHERE file_path = ? ORDER BY at ASC, id ASC`,
    ).all(filePath) as Array<{ id: number; ticket_id: number | null; job_id: string | null; kind: ProvenanceKind; at: number }>).map((r) => ({
      ...r,
      added_lines: null,
      removed_lines: null,
      patch_excerpt: null,
      summary: null,
      summary_model: null,
      summary_generated_at: null,
      patch_count: 0,
    }))
  }
  const ticketCache = new Map<number, FileStoryEntry['ticket']>()
  const resolveTicket = (ticketId: number | null): FileStoryEntry['ticket'] => {
    if (ticketId == null) return null
    if (ticketCache.has(ticketId)) return ticketCache.get(ticketId)!
    let resolved: FileStoryEntry['ticket'] = null
    try {
      const spec = getTicketSpec?.(ticketId)
      if (spec) {
        resolved = {
          id: ticketId,
          title: typeof spec.title === 'string' ? spec.title : null,
          status: typeof spec.status === 'string' ? spec.status : null,
        }
      }
    } catch { /* deleted ticket / unreadable store — degrade to null */ }
    ticketCache.set(ticketId, resolved)
    return resolved
  }

  return rows.map((r) => ({
    provenanceId: r.id,
    jobId: r.job_id,
    ticketId: r.ticket_id,
    kind: r.kind,
    at: r.at,
    addedLines: r.added_lines,
    removedLines: r.removed_lines,
    hasPatch: r.patch_count > 0,
    summary: r.summary,
    summaryModel: r.summary_model,
    summaryGeneratedAt: r.summary_generated_at,
    ticket: resolveTicket(r.ticket_id),
  }))
}
