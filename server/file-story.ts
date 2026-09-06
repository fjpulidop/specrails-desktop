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
import { createHash } from 'node:crypto'
import type { DbInstance } from './db'
import type { SummaryLanguage } from './file-summary-manager'
import type { WsMessage } from './types'
import { isCodeExplorerEnabled } from './feature-flags'
import { provenanceRepositoryFilter, type ProvenanceRepositoryScope } from './project-repository-provenance'
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

export const STORY_PROMPT_VERSION = 2
export const STORY_PATCH_MAX_CHARS = 12000
export interface StoryEvidence { kind: 'diff' | 'excerpt' | 'missing'; truncated: boolean }
export interface StorySummaryMetadata {
  language: SummaryLanguage
  promptVersion: number
  inputHash: string
  evidence: StoryEvidence
}

/** Additive migration: old paragraphs remain readable and become regenerable. */
export function migrateFileStoryMetadata(db: DbInstance): void {
  const columns = new Set((db.prepare('PRAGMA table_info(file_story_contributions)').all() as Array<{ name: string }>).map(row => row.name))
  for (const [name, type] of [['summary_language', 'TEXT'], ['summary_prompt_version', 'INTEGER'], ['summary_input_hash', 'TEXT'], ['summary_evidence', 'TEXT']]) {
    if (!columns.has(name!)) db.exec(`ALTER TABLE file_story_contributions ADD COLUMN ${name} ${type}`)
  }
}

function metadataColumns(db: DbInstance, alias = ''): string {
  const prefix = alias ? alias + '.' : ''
  const columns = new Set((db.prepare('PRAGMA table_info(file_story_contributions)').all() as Array<{ name: string }>).map(row => row.name))
  return ['summary_language', 'summary_prompt_version', 'summary_input_hash', 'summary_evidence']
    .map(name => columns.has(name) ? prefix + name : `NULL AS ${name}`).join(', ')
}

function parseStoryEvidence(raw: string | null | undefined): StoryEvidence | null {
  try {
    const value = JSON.parse(raw ?? '') as StoryEvidence
    return value && ['diff', 'excerpt', 'missing'].includes(value.kind) && typeof value.truncated === 'boolean' ? { kind: value.kind, truncated: value.truncated } : null
  } catch { return null }
}

export function getStoryEvidence(db: DbInstance, provenanceId: number): StoryEvidence & { patch: string | null } {
  try {
    const full = db.prepare('SELECT patch, truncated FROM file_provenance_diffs WHERE provenance_id = ?').get(provenanceId) as { patch: string; truncated: number } | undefined
    if (full?.patch?.trim()) return { kind: 'diff', patch: full.patch.slice(0, STORY_PATCH_MAX_CHARS), truncated: !!full.truncated || full.patch.length > STORY_PATCH_MAX_CHARS }
  } catch { /* historical rows may only retain an excerpt */ }
  const excerpt = getContribution(db, provenanceId)?.patch_excerpt
  return excerpt?.trim() ? { kind: 'excerpt', patch: excerpt.slice(0, STORY_PATCH_MAX_CHARS), truncated: true } : { kind: 'missing', patch: null, truncated: false }
}

export function storyPromptData(input: { path: string; repositoryId?: string; ticketId: number | null; ticketTitle: string | null; kind: string }, evidence: ReturnType<typeof getStoryEvidence>): string {
  return JSON.stringify({ path: input.path, repositoryId: input.repositoryId ?? null,
    ticket: { id: input.ticketId, currentTitle: input.ticketTitle }, changeKind: input.kind,
    evidence: { kind: evidence.kind, truncated: evidence.truncated }, patch: evidence.patch })
}
export function storyInputHash(data: string): string { return createHash('sha256').update(data).digest('hex') }

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
  summaryLanguage?: SummaryLanguage | null
  summaryPromptVersion?: number | null
  summaryStale?: boolean
  evidence?: StoryEvidence
  summaryEvidence?: StoryEvidence | null
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
  summary_language?: SummaryLanguage | null
  summary_prompt_version?: number | null
  summary_input_hash?: string | null
  summary_evidence?: string | null
}

export interface LoopRunProvenanceInput {
  db: DbInstance
  projectId: string
  repositoryId?: string
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
      input.repositoryId,
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
              patch_excerpt, summary, summary_model, summary_generated_at, ${metadataColumns(db)}
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
  metadata?: StorySummaryMetadata,
): boolean {
  try {
    return db.transaction(() => {
      const updated = db.prepare(
        `UPDATE file_story_contributions
         SET summary = ?, summary_model = ?, summary_generated_at = ?
         WHERE provenance_id = ?`,
      ).run(summary, model, generatedAtIso, provenanceId)
      if (updated.changes > 0) {
        if (metadata) persistStoryMetadata(db, provenanceId, metadata)
        return true
      }
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
      if (metadata) persistStoryMetadata(db, provenanceId, metadata)
      return true
    })()
  } catch {
    return false
  }
}

function persistStoryMetadata(db: DbInstance, id: number, metadata: StorySummaryMetadata): void {
  db.prepare(`UPDATE file_story_contributions SET summary_language = ?, summary_prompt_version = ?, summary_input_hash = ?, summary_evidence = ? WHERE provenance_id = ?`)
    .run(metadata.language, metadata.promptVersion, metadata.inputHash, JSON.stringify(metadata.evidence), id)
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
  repository?: ProvenanceRepositoryScope,
  language: SummaryLanguage = 'en',
): FileStoryEntry[] {
  const scope = provenanceRepositoryFilter(db, repository, 'p')
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
    summary_language: SummaryLanguage | null
    summary_prompt_version: number | null
    summary_input_hash: string | null
    summary_evidence: string | null
  }>
  try {
    rows = db.prepare(
      `SELECT p.id, p.file_path, p.ticket_id, p.job_id, p.kind, p.at,
              c.added_lines, c.removed_lines, c.patch_excerpt,
              c.summary, c.summary_model, c.summary_generated_at, ${metadataColumns(db, 'c')},
              (SELECT COUNT(*) FROM file_provenance_diffs d WHERE d.provenance_id = p.id) AS patch_count
       FROM file_provenance p
       LEFT JOIN file_story_contributions c ON c.provenance_id = p.id
       WHERE p.file_path = ? AND ${scope.sql}
       ORDER BY p.at ASC, p.id ASC`,
    ).all(filePath, ...scope.params) as typeof rows
  } catch {
    // Pre-migration-37 DB — degrade to the bare provenance rows (honest
    // fallback story: kind + date + spec only).
    rows = (db.prepare(
      `SELECT id, ticket_id, job_id, kind, at FROM file_provenance p WHERE file_path = ? AND ${scope.sql} ORDER BY at ASC, id ASC`,
    ).all(filePath, ...scope.params) as Array<{ id: number; ticket_id: number | null; job_id: string | null; kind: ProvenanceKind; at: number }>).map((r) => ({
      ...r,
      added_lines: null,
      removed_lines: null,
      patch_excerpt: null,
      summary: null,
      summary_model: null,
      summary_generated_at: null,
      patch_count: 0,
      summary_language: null, summary_prompt_version: null, summary_input_hash: null, summary_evidence: null,
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

  return rows.map((r) => {
    const ticket = resolveTicket(r.ticket_id)
    const evidence = getStoryEvidence(db, r.id)
    const currentInput = storyPromptData({ path: filePath, repositoryId: repository?.repositoryId, ticketId: r.ticket_id, ticketTitle: ticket?.title ?? null, kind: r.kind }, evidence)
    return {
      provenanceId: r.id, jobId: r.job_id, ticketId: r.ticket_id, kind: r.kind, at: r.at,
      addedLines: r.added_lines, removedLines: r.removed_lines, hasPatch: r.patch_count > 0,
      summary: r.summary, summaryModel: r.summary_model, summaryGeneratedAt: r.summary_generated_at,
      summaryLanguage: r.summary_language, summaryPromptVersion: r.summary_prompt_version,
      summaryStale: !!r.summary && (r.summary_language !== language || r.summary_prompt_version !== STORY_PROMPT_VERSION || r.summary_input_hash !== storyInputHash(currentInput)),
      evidence: { kind: evidence.kind, truncated: evidence.truncated }, summaryEvidence: parseStoryEvidence(r.summary_evidence), ticket,
    }
  })
}
