import type { DbInstance } from './db'

/** Project migration 60. Historical rows belong to the primary repository. */
export function migrateRepositoryProvenance(db: DbInstance): void {
  const columns = db.prepare('PRAGMA table_info(file_provenance)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'repository_id')) {
    db.exec('ALTER TABLE file_provenance ADD COLUMN repository_id TEXT')
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_file_provenance_repository_path
    ON file_provenance(repository_id, file_path, at);
    CREATE INDEX IF NOT EXISTS idx_file_provenance_repository_job
    ON file_provenance(repository_id, job_id, file_path);`)
}

export interface ProvenanceRepositoryScope {
  repositoryId: string
  /** Only the project's primary membership may read pre-migration rows. */
  includeLegacy?: boolean
}

/** Unscoped internal callers retain the project-wide history view. REST/code
 * callers always supply a resolved member; a missing column never exposes a
 * primary's historical files as a secondary repository's history. */
export function provenanceRepositoryFilter(
  db: DbInstance,
  scope?: ProvenanceRepositoryScope,
  alias = '',
): { sql: string; params: string[] } {
  if (!scope) return { sql: '1 = 1', params: [] }
  const columns = db.prepare('PRAGMA table_info(file_provenance)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'repository_id')) {
    return { sql: scope.includeLegacy ? '1 = 1' : '0 = 1', params: [] }
  }
  const column = `${alias ? `${alias}.` : ''}repository_id`
  return {
    sql: scope.includeLegacy ? `(${column} = ? OR ${column} IS NULL)` : `${column} = ?`,
    params: [scope.repositoryId],
  }
}
