import type { DbInstance } from '../../../db/types'

/** Every app setting as stored (redacted by the domain before it leaves the server). */
export function readDesktopSettingsRows(db: DbInstance | undefined): Array<{ key: string; value: string }> {
  if (!db) return []
  try {
    return (db.prepare('SELECT key, value FROM desktop_settings').all() as Array<{ key: unknown; value: unknown }>)
      .filter(row => typeof row.key === 'string')
      .map(row => ({ key: row.key as string, value: typeof row.value === 'string' ? row.value : String(row.value ?? '') }))
  } catch {
    return []
  }
}
