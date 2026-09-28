import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

/** SQLite's OS-backed write reservation serializes package publication and
 * collection across Desktop processes and releases automatically after a crash.
 * No timestamps, guessed stale owners or advisory PID files authorize deletion. */
export function withRuntimePackageLock<T>(cache: string, operation: () => T): T {
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(cache).isSymbolicLink() || !fs.statSync(cache).isDirectory()) throw new Error('Runtime package cache must be a real directory')
  const lock = path.join(cache, '.maintenance.sqlite')
  try { fs.writeFileSync(lock, '', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const stat = fs.lstatSync(lock)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Runtime package maintenance lock is invalid')
  const database = new Database(lock, { timeout: 0 })
  try {
    // No asynchronous work may escape this transaction. Retention's host/Core
    // inspection happens before package collection; copying is synchronous.
    return database.transaction(operation).immediate()
  } finally { database.close() }
}
