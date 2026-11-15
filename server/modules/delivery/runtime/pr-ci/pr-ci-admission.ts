import { randomUUID } from 'node:crypto'
import type { DbInstance } from '../../../../db'

/**
 * Host-frozen admission of a PR whose CI a mission asked to repair without any
 * Specrails delivery. The row is the authority for the repository, PR, head and
 * base the run works on: nothing in card or workflow text can change them.
 *
 *   offered → started { runId } → green | no-ci | needs-attention { reason }
 *   offered → dismissed
 */
export type PrCiAdmissionState = 'offered' | 'started' | 'dismissed' | 'green' | 'no-ci' | 'needs-attention'

export interface PrCiAdmissionRow {
  id: string
  project_id: string
  repository_id: string
  repository_path: string
  pr_number: number
  pr_url: string
  head_branch: string
  head_sha: string | null
  base_branch: string
  origin_conversation_id: string | null
  state: PrCiAdmissionState
  run_id: string | null
  reason: string | null
  pushes: number | null
  rounds: number | null
  worktree_path: string | null
  created_at: string
  updated_at: string
}

export interface PrCiAdmissionTarget {
  projectId: string
  repositoryId: string
  repositoryPath: string
  prNumber: number
  prUrl: string
  headBranch: string
  headSha: string | null
  baseBranch: string
  originConversationId: string | null
}

const TERMINAL: ReadonlySet<PrCiAdmissionState> = new Set(['green', 'no-ci', 'needs-attention'])
export const isTerminalAdmission = (state: PrCiAdmissionState): boolean => TERMINAL.has(state)

export function getPrCiAdmission(db: DbInstance, projectId: string, id: string): PrCiAdmissionRow | undefined {
  return db.prepare('SELECT * FROM pr_ci_admissions WHERE project_id = ? AND id = ?').get(projectId, id) as PrCiAdmissionRow | undefined
}

export function getPrCiAdmissionByRun(db: DbInstance, projectId: string, runId: string): PrCiAdmissionRow | undefined {
  return db.prepare('SELECT * FROM pr_ci_admissions WHERE project_id = ? AND run_id = ?').get(projectId, runId) as PrCiAdmissionRow | undefined
}

export function getPrCiAdmissionByTarget(db: DbInstance, projectId: string, repositoryId: string, prNumber: number): PrCiAdmissionRow | undefined {
  return db.prepare('SELECT * FROM pr_ci_admissions WHERE project_id = ? AND repository_id = ? AND pr_number = ?').get(projectId, repositoryId, prNumber) as PrCiAdmissionRow | undefined
}

/**
 * Idempotent prepare. A new target inserts an `offered` row; an existing one
 * keeps its identity, and its refs are refreshed only while nothing is running
 * (a `started` admission is never rewritten under its run). A finished or
 * dismissed row returns to `offered` so the PR can be repaired again.
 */
export function upsertPrCiAdmission(db: DbInstance, target: PrCiAdmissionTarget, now: () => number = Date.now): PrCiAdmissionRow {
  const at = new Date(now()).toISOString()
  const write = db.transaction((): PrCiAdmissionRow => {
    const existing = getPrCiAdmissionByTarget(db, target.projectId, target.repositoryId, target.prNumber)
    if (!existing) {
      const id = randomUUID()
      db.prepare(`INSERT INTO pr_ci_admissions (id, project_id, repository_id, repository_path, pr_number, pr_url, head_branch, head_sha, base_branch, origin_conversation_id, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?)`)
        .run(id, target.projectId, target.repositoryId, target.repositoryPath, target.prNumber, target.prUrl, target.headBranch, target.headSha, target.baseBranch, target.originConversationId, at, at)
      return getPrCiAdmission(db, target.projectId, id)!
    }
    if (existing.state === 'started') return existing
    db.prepare(`UPDATE pr_ci_admissions SET repository_path = ?, pr_url = ?, head_branch = ?, head_sha = ?, base_branch = ?, origin_conversation_id = COALESCE(?, origin_conversation_id),
        state = 'offered', run_id = NULL, reason = NULL, pushes = NULL, rounds = NULL, worktree_path = NULL, updated_at = ? WHERE id = ?`)
      .run(target.repositoryPath, target.prUrl, target.headBranch, target.headSha, target.baseBranch, target.originConversationId, at, existing.id)
    return getPrCiAdmission(db, target.projectId, existing.id)!
  })
  return write()
}

/** Atomic claim: exactly one caller moves `offered` (or a settled row) to `started`. */
export function claimPrCiAdmission(db: DbInstance, projectId: string, id: string, runId: string, now: () => number = Date.now): boolean {
  const result = db.prepare("UPDATE pr_ci_admissions SET state = 'started', run_id = ?, reason = NULL, pushes = NULL, rounds = NULL, updated_at = ? WHERE project_id = ? AND id = ? AND state != 'started'")
    .run(runId, new Date(now()).toISOString(), projectId, id)
  return result.changes === 1
}

export function setPrCiAdmissionWorktree(db: DbInstance, id: string, worktreePath: string): void {
  db.prepare('UPDATE pr_ci_admissions SET worktree_path = ? WHERE id = ?').run(worktreePath, id)
}

/** Return a failed claim to `offered`, keeping the stated reason for the card. */
export function releasePrCiAdmission(db: DbInstance, id: string, reason: string, now: () => number = Date.now): void {
  db.prepare("UPDATE pr_ci_admissions SET state = 'offered', run_id = NULL, worktree_path = NULL, reason = ?, updated_at = ? WHERE id = ? AND state = 'started'")
    .run(reason.slice(0, 1200), new Date(now()).toISOString(), id)
}

export function dismissPrCiAdmission(db: DbInstance, projectId: string, id: string, now: () => number = Date.now): boolean {
  return db.prepare("UPDATE pr_ci_admissions SET state = 'dismissed', updated_at = ? WHERE project_id = ? AND id = ? AND state = 'offered'")
    .run(new Date(now()).toISOString(), projectId, id).changes === 1
}

export interface PrCiAdmissionSettlement { state: Extract<PrCiAdmissionState, 'green' | 'no-ci' | 'needs-attention'>; reason?: string; pushes: number; rounds: number }

/** Idempotent: only a `started` row settles, so a replay returns the same state. */
export function settlePrCiAdmission(db: DbInstance, id: string, settlement: PrCiAdmissionSettlement, now: () => number = Date.now): boolean {
  return db.prepare("UPDATE pr_ci_admissions SET state = ?, reason = ?, pushes = ?, rounds = ?, updated_at = ? WHERE id = ? AND state = 'started'")
    .run(settlement.state, settlement.reason ?? null, settlement.pushes, settlement.rounds, new Date(now()).toISOString(), id).changes === 1
}

/** Admissions left `started` (a restart interrupted them), oldest first. */
export function listStartedPrCiAdmissions(db: DbInstance, projectId: string): PrCiAdmissionRow[] {
  return db.prepare("SELECT * FROM pr_ci_admissions WHERE project_id = ? AND state = 'started' ORDER BY updated_at").all(projectId) as PrCiAdmissionRow[]
}

/** The started mission-origin run on this exact PR, if any (the delivery-backed start refuses while it runs). */
export function findActivePrCiAdmissionForPr(db: DbInstance, projectId: string, prUrl: string): PrCiAdmissionRow | undefined {
  return db.prepare("SELECT * FROM pr_ci_admissions WHERE project_id = ? AND pr_url = ? AND state = 'started'").get(projectId, prUrl) as PrCiAdmissionRow | undefined
}

/** A delivery generation still building on this exact PR (any loop): two writers on one branch are never allowed. */
export function findBuildingDeliveryForPr(db: DbInstance, prUrl: string): { id: string } | undefined {
  return db.prepare("SELECT id FROM rail_pr_deliveries WHERE pr_url = ? AND decision = 'building' LIMIT 1").get(prUrl) as { id: string } | undefined
}
