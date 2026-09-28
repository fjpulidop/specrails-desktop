import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DbInstance } from '../../../db'
import { readRuntimeExpiration, recordRuntimeExpiration, type RuntimeExpirationRecord } from './agent-runtime-retention-records'

/*
 * Durable quarantine protocol. Every crash boundary leaves one recognizable state:
 *
 *   1. `.retention/.staging-<token>/` holds at most a partial intent. The original
 *      journal was not moved yet, so recovery deletes only the staging directory.
 *   2. `.retention/<token>/intent.json` is published by an atomic directory rename.
 *      Before the journal move the original is intact and still has the recorded
 *      identity; recovery removes only the intent.
 *   3. `<token>/run` is the moved journal (same inode). Without an expiration
 *      record recovery restores it; with an owning record it finishes deletion.
 *   4. Deletion removes the journal first and the intent last, so an interrupted
 *      deletion always keeps the intent that authorizes it. A directory without
 *      an intent is removed only when it is empty.
 *   5. Restoration moves the journal back first; before the intent is removed the
 *      original must still have the recorded identity. Replacement data is never
 *      deleted or overwritten.
 */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const STAGING = /^\.staging-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/
interface Identity { dev: string; ino: string }
interface Intent { schemaVersion: 1; runId: string; token: string; journalIdentity: Identity }
type Files = ReturnType<typeof locations>

function realDirectory(directory: string): void {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Runtime retention cannot cross a storage link')
}
function syncDirectory(directory: string): void {
  // Directory handles cannot be flushed on Windows; NTFS journals the rename itself.
  if (process.platform === 'win32') return
  const handle = fs.openSync(directory, 'r')
  try { fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
}
function locations(pipeline: string, runId: string, token: string) {
  if (!RUN_ID.test(runId) || !TOKEN.test(token)) throw new Error('Invalid runtime retention identity')
  realDirectory(pipeline)
  const root = path.join(pipeline, '.retention')
  if (fs.existsSync(root)) realDirectory(root)
  const directory = path.join(root, token)
  if (fs.existsSync(directory)) realDirectory(directory)
  return { original: path.join(pipeline, runId), root, directory, staging: path.join(root, `.staging-${token}`), journal: path.join(directory, 'run'), intent: path.join(directory, 'intent.json') }
}
function identity(directory: string): Identity {
  realDirectory(directory)
  const stat = fs.statSync(directory, { bigint: true })
  if (stat.ino === 0n) throw new Error('Runtime journal filesystem identity is unavailable')
  return { dev: String(stat.dev), ino: String(stat.ino) }
}
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino
function readIntent(file: string): Intent {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('Invalid runtime quarantine intent')
  const intent = JSON.parse(fs.readFileSync(file, 'utf8')) as Intent
  if (intent?.schemaVersion !== 1 || typeof intent.runId !== 'string' || typeof intent.token !== 'string' || !intent.journalIdentity ||
    typeof intent.journalIdentity.dev !== 'string' || typeof intent.journalIdentity.ino !== 'string') throw new Error('Runtime quarantine intent identity changed')
  return intent
}
function inspectIntent(files: Files, runId: string, token: string): Intent {
  const intent = readIntent(files.intent)
  if (intent.runId !== runId || intent.token !== token) throw new Error('Runtime quarantine intent identity changed')
  if (fs.readdirSync(files.directory).some(name => !['intent.json', 'run'].includes(name))) throw new Error('Unknown files in runtime quarantine')
  if (fs.existsSync(files.journal) && !sameIdentity(identity(files.journal), intent.journalIdentity)) throw new Error('Runtime quarantine journal was replaced')
  return intent
}
/** Journal first, intent last: every interruption keeps the deletion authority. */
function deleteQuarantine(files: Files, runId: string, token: string): void {
  if (!fs.existsSync(files.directory)) return
  if (fs.existsSync(files.intent)) {
    inspectIntent(files, runId, token)
    fs.rmSync(files.journal, { recursive: true, force: true })
    fs.rmSync(files.intent, { force: true })
  }
  // Fails with ENOTEMPTY rather than deleting data this protocol did not create.
  fs.rmdirSync(files.directory)
}
/** Journal back first; the intent stays until the restored original is proven. */
function restoreQuarantine(files: Files, intent: Intent): void {
  if (fs.existsSync(files.journal)) {
    if (fs.existsSync(files.original)) throw new Error('Original runtime location was replaced; recovery must not overwrite it')
    realDirectory(files.journal)
    fs.renameSync(files.journal, files.original)
    syncDirectory(path.dirname(files.original))
  }
  if (!fs.existsSync(files.original) || !sameIdentity(identity(files.original), intent.journalIdentity)) throw new Error('Restored runtime journal identity changed; quarantine retained for review')
  if (fs.readdirSync(files.directory).some(name => name !== 'intent.json')) throw new Error('Unknown files in runtime quarantine')
  fs.rmSync(files.intent)
  fs.rmdirSync(files.directory)
}

/** Host execution/delivery reservations must be held for the complete lifecycle.
 * Only journal storage is moved; no path from frozen repository metadata is used. */
export function runtimeJournalQuarantine(db: DbInstance, pipeline: string, record: Omit<RuntimeExpirationRecord, 'quarantineToken'>) {
  const token = randomUUID(), files = locations(pipeline, record.runId, token)
  const own = (value: string) => { if (value !== token) throw new Error('Runtime quarantine ownership changed'); return locations(pipeline, record.runId, token) }
  return {
    async quarantine(): Promise<{ token: string }> {
      realDirectory(files.original)
      fs.mkdirSync(files.root, { recursive: true, mode: 0o700 }); realDirectory(files.root)
      fs.mkdirSync(files.staging, { mode: 0o700 })
      const intent: Intent = { schemaVersion: 1, runId: record.runId, token, journalIdentity: identity(files.original) }
      const handle = fs.openSync(path.join(files.staging, 'intent.json'), 'wx', 0o600)
      try { fs.writeFileSync(handle, JSON.stringify(intent)); fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
      // Publication is atomic: recovery sees either staging or a complete intent.
      fs.renameSync(files.staging, files.directory)
      syncDirectory(files.root)
      fs.renameSync(files.original, files.journal)
      syncDirectory(pipeline)
      return { token }
    },
    async expire(value: string): Promise<void> {
      const target = own(value), intent = inspectIntent(target, record.runId, token)
      if (!fs.existsSync(target.journal) || !sameIdentity(identity(target.journal), intent.journalIdentity)) throw new Error('Runtime quarantine journal is not owned')
      recordRuntimeExpiration(db, { ...record, quarantineToken: token })
    },
    async restore(value: string): Promise<void> {
      const target = own(value)
      if (readRuntimeExpiration(db, record.runId)) throw new Error('Expired runtime cannot be restored as executable history')
      restoreQuarantine(target, inspectIntent(target, record.runId, token))
    },
    async remove(value: string): Promise<void> {
      const target = own(value), expired = readRuntimeExpiration(db, record.runId)
      if (!expired || expired.quarantineToken !== token) throw new Error('Runtime expiration is not durable')
      deleteQuarantine(target, record.runId, token)
    },
  }
}

export interface RuntimeQuarantineRecovery { restored: string[]; removed: string[]; protected: string[]; errors: string[] }
/** Recovery runs under a host reservation supplied for each intent. A live
 * collection must return null; no age/PID heuristic takes over its ownership.
 * One damaged entry is reported and left in place without blocking the others;
 * package collection refuses to run while any quarantine entry remains. */
export function recoverRuntimeQuarantine(db: DbInstance, pipeline: string, reserve: (runId: string) => (() => void) | null): RuntimeQuarantineRecovery {
  const result: RuntimeQuarantineRecovery = { restored: [], removed: [], protected: [], errors: [] }
  const root = path.join(pipeline, '.retention')
  if (!fs.existsSync(root)) return result
  realDirectory(pipeline); realDirectory(root)
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unknown runtime quarantine entry ${entry.name}`)
      const directory = path.join(root, entry.name), staging = STAGING.exec(entry.name)
      if (staging) {
        // Unpublished: the original journal was never moved.
        if (fs.readdirSync(directory).some(name => name !== 'intent.json')) throw new Error('Unknown files in unpublished runtime quarantine')
        fs.rmSync(path.join(directory, 'intent.json'), { force: true }); fs.rmdirSync(directory); continue
      }
      if (!TOKEN.test(entry.name)) throw new Error(`Unknown runtime quarantine entry ${entry.name}`)
      if (!fs.existsSync(path.join(directory, 'intent.json'))) {
        // Deletion removed the intent last, or a pre-protocol crash left an empty
        // directory. Anything else has no authority and is kept.
        if (fs.readdirSync(directory).length) throw new Error('Runtime quarantine has data without an intent')
        fs.rmdirSync(directory); continue
      }
      const intent = readIntent(path.join(directory, 'intent.json'))
      if (intent.token !== entry.name) throw new Error('Runtime quarantine intent identity changed')
      const files = locations(pipeline, intent.runId, intent.token)
      inspectIntent(files, intent.runId, intent.token)
      const release = reserve(intent.runId)
      if (!release) { result.protected.push(intent.runId); continue }
      try {
        const expired = readRuntimeExpiration(db, intent.runId)
        if (expired) {
          if (expired.quarantineToken !== intent.token) throw new Error('Runtime expiration does not own this quarantine')
          deleteQuarantine(files, intent.runId, intent.token); result.removed.push(intent.runId)
        } else {
          restoreQuarantine(files, intent); result.restored.push(intent.runId)
        }
      } finally { release() }
    } catch (error) {
      result.errors.push(`${entry.name}: ${error instanceof Error ? error.message : 'Runtime quarantine recovery failed'}`)
    }
  }
  return result
}
