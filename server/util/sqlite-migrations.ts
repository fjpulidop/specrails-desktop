import type { DbInstance } from '../db'

/** Recheck the version while holding the write lock: another startup may have
 * migrated the database after our initial read, while we waited for SQLite. */
export function applyNumberedMigrations(db: DbInstance, migrations: Array<(db: DbInstance) => void>): void {
  const applied = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((row) => row.version),
  )
  const hasVersion = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
  const recordVersion = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)')
  const migrate = db.transaction((version: number, body: (db: DbInstance) => void) => {
    if (hasVersion.get(version)) return
    body(db)
    recordVersion.run(version)
  })
  for (let i = 0; i < migrations.length; i++) {
    if (!applied.has(i + 1)) migrate.immediate(i + 1, migrations[i])
  }
}
