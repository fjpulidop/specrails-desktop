import type { DbInstance } from './db'
import type { PrDecision, PrDeliveryOutcome, PrImplementationOutcome, PrDeliveryStatusCode } from './rail-pr-store'

/** Frozen at allocation. Paths in a delivery never follow later project edits. */
export interface RunRepositorySnapshot {
  repositoryId: string
  name: string
  sourcePath: string
  gitCommonDir: string
  baseBranch: string
  /** Local acceptance target; differs from baseBranch for a stacked milestone. */
  integrationBranch?: string
  baseSha: string
  worktreePath: string
  branch: string
  worktreeId: string
}

export interface RunExecutionManifest {
  version: 1
  groupId: string
  projectId: string
  primaryRepositoryId: string
  artifactRepositoryId: string
  selectedRepositoryIds: string[]
  repositories: RunRepositorySnapshot[]
}

export interface RepositoryDeliverySnapshot {
  integrationBranch?: string
  repositoryId: string
  name: string
  path: string
  deliveryId: string
  baseBranch: string
  branch: string | null
  deliverySha: string | null
  decision: PrDecision
  implementationOutcome: PrImplementationOutcome
  deliveryOutcome: PrDeliveryOutcome
  statusCode: PrDeliveryStatusCode | null
  statusDetail: string | null
  prUrl: string | null
  prNumber: number | null
  worktreeIds: string[]
  runIds: string[]
}

/** Project DB migration 59. Desktop membership is migrated separately. */
export function migrateMultiRepoExecution(db: DbInstance): void {
  db.exec(`
    ALTER TABLE rail_pr_deliveries ADD COLUMN parent_delivery_id TEXT REFERENCES rail_pr_deliveries(id);
    ALTER TABLE rail_pr_deliveries ADD COLUMN repository_id TEXT;
    ALTER TABLE rail_pr_deliveries ADD COLUMN repository_path TEXT;
    ALTER TABLE rail_pr_deliveries ADD COLUMN execution_manifest TEXT;
    ALTER TABLE rail_pr_deliveries ADD COLUMN repository_deliveries TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE rail_worktrees ADD COLUMN repository_id TEXT;
    ALTER TABLE rail_worktrees ADD COLUMN repository_path TEXT;
    ALTER TABLE loop_runs ADD COLUMN execution_manifest TEXT;
    CREATE INDEX idx_rail_pr_delivery_parent ON rail_pr_deliveries(parent_delivery_id);
    CREATE INDEX idx_rail_worktree_repository ON rail_worktrees(repository_id);
    DROP INDEX IF EXISTS idx_rail_pr_deliveries_one_active_per_rail;
    CREATE UNIQUE INDEX idx_rail_pr_deliveries_one_active_per_rail
      ON rail_pr_deliveries(rail_index)
      WHERE parent_delivery_id IS NULL AND decision NOT IN ('completed','merged','discarded','superseded');
  `)
}

export function readExecutionManifest(raw: string | null | undefined): RunExecutionManifest | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as RunExecutionManifest
    if (value.version !== 1 || !Array.isArray(value.repositories) || !Array.isArray(value.selectedRepositoryIds)) return null
    return value
  } catch { return null }
}

export function getRepositoryExecutionReferences(db: DbInstance, repositoryId: string): { runIds: string[]; deliveryIds: string[] } {
  const deliveries = db.prepare(`SELECT id, parent_delivery_id, run_ids FROM rail_pr_deliveries
    WHERE repository_id = ? AND decision NOT IN ('completed','merged','discarded','superseded')`).all(repositoryId) as
    Array<{ id: string; parent_delivery_id: string | null; run_ids: string }>
  const worktrees = db.prepare(`SELECT run_id FROM rail_worktrees WHERE repository_id = ?
    AND merge_state NOT IN ('merged','failed','released')`).all(repositoryId) as Array<{ run_id: string | null }>
  const runs = db.prepare("SELECT id, execution_manifest FROM loop_runs WHERE status <> 'completed' AND execution_manifest IS NOT NULL").all() as Array<{ id: string; execution_manifest: string }>
  const manifestRunIds = runs.filter((row) => readExecutionManifest(row.execution_manifest)?.selectedRepositoryIds.includes(repositoryId)).map((row) => row.id)
  return {
    runIds: [...new Set([...worktrees.flatMap((row) => row.run_id ? [row.run_id] : []), ...manifestRunIds])],
    deliveryIds: [...new Set(deliveries.map((row) => row.parent_delivery_id ?? row.id))],
  }
}

export function executionManifestPrompt(manifest?: RunExecutionManifest): string {
  if (!manifest) return ''
  return [
    'Specrails repository execution scope (immutable for this run):',
    JSON.stringify({
      projectId: manifest.projectId,
      artifactRepositoryId: manifest.artifactRepositoryId,
      repositories: manifest.repositories.map((repo) => ({ repositoryId: repo.repositoryId, name: repo.name, path: repo.worktreePath, branch: repo.branch, base: repo.baseSha })),
    }),
    'This is ONE shared spec and ONE coordinated implementation. Complete and verify every required repository and their shared contracts before reporting success.',
    'Edit only the listed worktree paths. The original checkouts are not implementation targets. Keep the shared backlog in the project artifact workspace; keep OpenSpec changes in its designated artifact repository.',
    'Specrails owns Git delivery: do not merge, push, delete branches or open pull requests yourself.',
  ].join('\n')
}
