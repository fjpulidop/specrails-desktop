import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DbInstance } from '../../../db'
import { readRuntimeExpiration, recordRuntimeExpiration, type RuntimeExpirationRecord } from './agent-runtime-retention-records'

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
interface Intent { schemaVersion: 1; runId: string; token: string; journalIdentity: { dev: string; ino: string } }
function realDirectory(directory: string): void {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Runtime retention cannot cross a storage link')
}
function locations(pipeline: string, runId: string, token: string) {
  if (!RUN_ID.test(runId) || !TOKEN.test(token)) throw new Error('Invalid runtime retention identity')
  realDirectory(pipeline)
  const root = path.join(pipeline, '.retention')
  if (fs.existsSync(root)) realDirectory(root)
  const directory = path.join(root, token)
  if (fs.existsSync(directory)) realDirectory(directory)
  return { original: path.join(pipeline, runId), root, directory, journal: path.join(directory, 'run'), intent: path.join(directory, 'intent.json') }
}
function identity(directory: string) {
  realDirectory(directory)
  const stat = fs.statSync(directory, { bigint: true })
  if (stat.ino === 0n) throw new Error('Runtime journal filesystem identity is unavailable')
  return { dev: String(stat.dev), ino: String(stat.ino) }
}
function inspectIntent(files: ReturnType<typeof locations>, runId: string, token: string): Intent {
  const stat = fs.lstatSync(files.intent)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('Invalid runtime quarantine intent')
  const intent = JSON.parse(fs.readFileSync(files.intent, 'utf8')) as Intent
  if (intent.schemaVersion !== 1 || intent.runId !== runId || intent.token !== token || !intent.journalIdentity ||
    typeof intent.journalIdentity.dev !== 'string' || typeof intent.journalIdentity.ino !== 'string') throw new Error('Runtime quarantine intent identity changed')
  if (fs.readdirSync(files.directory).some(name => !['intent.json', 'run'].includes(name))) throw new Error('Unknown files in runtime quarantine')
  if (fs.existsSync(files.journal)) {
    const actual = identity(files.journal)
    if (actual.dev !== intent.journalIdentity.dev || actual.ino !== intent.journalIdentity.ino) throw new Error('Runtime quarantine journal was replaced')
  }
  return intent
}
/** Host execution/delivery reservations must be held for the complete lifecycle.
 * Only journal storage is moved; no path from frozen repository metadata is used. */
export function runtimeJournalQuarantine(db: DbInstance, pipeline: string, record: Omit<RuntimeExpirationRecord, 'quarantineToken'>) {
  const token = randomUUID(), files = locations(pipeline, record.runId, token)
  const own = (value: string) => { if (value !== token) throw new Error('Runtime quarantine ownership changed'); return locations(pipeline, record.runId, token) }
  return {
    async quarantine(): Promise<{ token: string }> {
      realDirectory(files.original)
      fs.mkdirSync(files.directory, { recursive: true, mode: 0o700 })
      const intent: Intent = { schemaVersion: 1, runId: record.runId, token, journalIdentity: identity(files.original) }
      fs.writeFileSync(files.intent, JSON.stringify(intent), { flag: 'wx', mode: 0o600 })
      fs.renameSync(files.original, files.journal)
      return { token }
    },
    async expire(value: string): Promise<void> { inspectIntent(own(value), record.runId, token); recordRuntimeExpiration(db, { ...record, quarantineToken: token }) },
    async restore(value: string): Promise<void> {
      const target = own(value)
      if (readRuntimeExpiration(db, record.runId)) throw new Error('Expired runtime cannot be restored as executable history')
      inspectIntent(target, record.runId, token)
      if (fs.existsSync(target.original)) throw new Error('Original runtime location was replaced; recovery must not overwrite it')
      realDirectory(target.journal); fs.renameSync(target.journal, target.original)
      fs.rmSync(target.directory, { recursive: true })
    },
    async remove(value: string): Promise<void> {
      const target = own(value), expired = readRuntimeExpiration(db, record.runId)
      if (!expired || expired.quarantineToken !== token) throw new Error('Runtime expiration is not durable')
      if (fs.existsSync(target.directory)) inspectIntent(target, record.runId, token)
      fs.rmSync(target.directory, { recursive: true, force: true })
    },
  }
}

/** Recovery runs under a host reservation supplied for each intent. A live
 * collection must return null; no age/PID heuristic takes over its ownership. */
export function recoverRuntimeQuarantine(db: DbInstance, pipeline: string, reserve: (runId: string) => (() => void) | null): { restored: string[]; removed: string[]; protected: string[] } {
  const result = { restored: [] as string[], removed: [] as string[], protected: [] as string[] }
  const root = path.join(pipeline, '.retention')
  if (!fs.existsSync(root)) return result
  realDirectory(pipeline); realDirectory(root)
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !TOKEN.test(entry.name)) throw new Error('Unknown runtime quarantine entry')
    const intentFile = path.join(root, entry.name, 'intent.json')
    const stat = fs.lstatSync(intentFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('Invalid runtime quarantine intent')
    const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8')) as Intent
    if (intent.schemaVersion !== 1 || intent.token !== entry.name) throw new Error('Runtime quarantine intent identity changed')
    const files = locations(pipeline, intent.runId, intent.token)
    inspectIntent(files, intent.runId, intent.token)
    const release = reserve(intent.runId)
    if (!release) { result.protected.push(intent.runId); continue }
    try {
      const expired = readRuntimeExpiration(db, intent.runId)
      if (expired) {
        if (expired.quarantineToken !== intent.token) throw new Error('Runtime expiration does not own this quarantine')
        fs.rmSync(files.directory, { recursive: true }); result.removed.push(intent.runId)
      } else if (fs.existsSync(files.journal)) {
        if (fs.existsSync(files.original)) throw new Error('Original runtime location was replaced; recovery must not overwrite it')
        realDirectory(files.journal); fs.renameSync(files.journal, files.original)
        fs.rmSync(files.directory, { recursive: true }); result.restored.push(intent.runId)
      } else {
        // Crash before rename: only the intent exists; the original is intact.
        realDirectory(files.original)
        if (fs.readdirSync(files.directory).some(name => name !== 'intent.json')) throw new Error('Unknown files in unpublished runtime quarantine')
        fs.rmSync(files.directory, { recursive: true }); result.restored.push(intent.runId)
      }
    } finally { release() }
  }
  return result
}
