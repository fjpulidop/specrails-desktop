import { createHash } from 'node:crypto'
import type { DbInstance } from './db'
import { getProjectRepositories, type ProjectRepository, type RepositoryProject } from './project-repositories'

export interface CodeActivityEntry {
  id: number
  repositoryId: string
  repositoryName: string
  path: string
  jobId: string | null
  ticketId: number | null
  kind: 'created' | 'modified' | 'deleted'
  at: number
  hasPatch: boolean
  patchTruncated: boolean
}
export interface CodeActivityQuery {
  repositoryId?: string
  ticketId?: number
  jobId?: string
  limit?: number
  cursor?: string
}
export interface CodeActivityPage {
  entries: CodeActivityEntry[]
  nextCursor: string | null
  truncated: boolean
  warnings: string[]
}
export class CodeActivityQueryError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}
export type CodeActivityPathFilter = (repository: ProjectRepository, paths: string[], remainingMs: number) => Promise<{
  allowed: Set<string>
  incomplete?: boolean
  unavailable?: boolean
}>

interface Cursor { v: 1; scope: string; snapshot: number; at: number; id: number }
interface Row {
  id: number; repository_id: string | null; file_path: string; ticket_id: number | null
  job_id: string | null; kind: CodeActivityEntry['kind']; at: number; has_patch: number; patch_truncated: number | null
}
const MAX_SCAN_ROWS = 2_000
const MAX_SCAN_MS = 2_000
const BATCH_SIZE = 200

function scalar(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new CodeActivityQueryError(`invalid_activity_${field}`)
  return value
}
export function parseCodeActivityQuery(query: Record<string, unknown>, scopedRepositoryId?: string): CodeActivityQuery {
  const repositoryId = scalar(query.repositoryId, 'repository')
  if (scopedRepositoryId && repositoryId && repositoryId !== scopedRepositoryId) throw new CodeActivityQueryError('repository_scope_mismatch')
  const ticket = scalar(query.ticketId, 'ticket')
  const limit = scalar(query.limit, 'limit')
  if (ticket !== undefined && (!/^\d+$/.test(ticket) || !Number.isSafeInteger(Number(ticket)) || Number(ticket) <= 0)) throw new CodeActivityQueryError('invalid_activity_ticket')
  if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) throw new CodeActivityQueryError('invalid_activity_limit')
  return {
    repositoryId: scopedRepositoryId ?? repositoryId,
    ticketId: ticket === undefined ? undefined : Number(ticket),
    jobId: scalar(query.jobId, 'job'), limit: limit === undefined ? undefined : Number(limit),
    cursor: scalar(query.cursor, 'cursor'),
  }
}

/** Keyset pagination is fenced to the first request's maximum provenance ID.
 * Newly captured events (including backdated ones) cannot move that snapshot.
 * The cursor is a position, never authorization: every page rechecks membership,
 * filters and current path policy. No provider or current source read is needed. */
export async function listCodeActivity(
  db: DbInstance, project: RepositoryProject, query: CodeActivityQuery, filterPaths: CodeActivityPathFilter,
): Promise<CodeActivityPage> {
  const started = Date.now()
  const limit = query.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CodeActivityQueryError('invalid_activity_limit')
  const members = getProjectRepositories(project)
  const repositories = query.repositoryId ? members.filter(repository => repository.id === query.repositoryId) : members
  if (!repositories.length) throw new CodeActivityQueryError('repository_not_found', 404)
  const primary = repositories.find(repository => repository.isPrimary)
  const repositoryById = new Map(repositories.map(repository => [repository.id, repository]))
  const scope = createHash('sha256').update(JSON.stringify({
    projectId: project.id,
    repositories: repositories.map(({ id, path, isPrimary }) => ({ id, path, isPrimary })).sort((a, b) => a.id.localeCompare(b.id)),
    ticketId: query.ticketId ?? null, jobId: query.jobId ?? null,
  })).digest('hex')
  let cursor: Cursor | undefined
  if (query.cursor) {
    try {
      if (query.cursor.length > 2048) throw new Error()
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as Cursor
      if (cursor.v !== 1 || cursor.scope !== scope || !Number.isSafeInteger(cursor.snapshot) || cursor.snapshot < 0 ||
        !Number.isSafeInteger(cursor.id) || cursor.id <= 0 || cursor.id > cursor.snapshot || !Number.isSafeInteger(cursor.at)) throw new Error()
    } catch { throw new CodeActivityQueryError('invalid_activity_cursor') }
  }
  const snapshot = cursor?.snapshot ?? (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM file_provenance').get() as { id: number }).id
  const columns = db.prepare('PRAGMA table_info(file_provenance)').all() as { name: string }[]
  const hasRepository = columns.some(column => column.name === 'repository_id')
  const hasDiffs = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_provenance_diffs'").get()
  const conditions = ['p.id <= ?']
  const parameters: (string | number)[] = [snapshot]
  if (hasRepository) {
    conditions.push(`(p.repository_id IN (${repositories.map(() => '?').join(',')})${primary ? ' OR p.repository_id IS NULL' : ''})`)
    parameters.push(...repositories.map(repository => repository.id))
  } else if (!primary) conditions.push('0 = 1')
  if (query.ticketId !== undefined) { conditions.push('p.ticket_id = ?'); parameters.push(query.ticketId) }
  if (query.jobId !== undefined) { conditions.push('p.job_id = ?'); parameters.push(query.jobId) }
  const where = conditions.join(' AND ')
  const join = hasDiffs ? 'LEFT JOIN file_provenance_diffs d ON d.provenance_id = p.id' : ''
  const projection = `p.id, ${hasRepository ? 'p.repository_id' : 'NULL AS repository_id'}, p.file_path, p.ticket_id, p.job_id, p.kind, p.at, ${hasDiffs ? '(d.provenance_id IS NOT NULL) AS has_patch, d.truncated AS patch_truncated' : '0 AS has_patch, 0 AS patch_truncated'}`
  let last = cursor ? { at: cursor.at, id: cursor.id } : undefined
  const entries: CodeActivityEntry[] = []
  const warnings = new Set<string>()
  let scanned = 0
  let exhausted = false
  while (entries.length < limit && scanned < MAX_SCAN_ROWS && Date.now() - started < MAX_SCAN_MS) {
    const rows = db.prepare(`SELECT ${projection} FROM file_provenance p ${join} WHERE ${where}
      ${last ? 'AND (p.at < ? OR (p.at = ? AND p.id < ?))' : ''}
      ORDER BY p.at DESC, p.id DESC LIMIT ?`).all(...parameters, ...(last ? [last.at, last.at, last.id] : []), Math.min(BATCH_SIZE, MAX_SCAN_ROWS - scanned)) as Row[]
    if (!rows.length) { exhausted = true; break }
    const allowedByRepository = new Map<string, Set<string>>()
    for (const repository of repositories) {
      const paths = [...new Set(rows.filter(row => row.repository_id === repository.id || (row.repository_id == null && repository.isPrimary)).map(row => row.file_path))]
      if (!paths.length) continue
      const filtered = await filterPaths(repository, paths, Math.max(0, MAX_SCAN_MS - (Date.now() - started)))
      allowedByRepository.set(repository.id, filtered.allowed)
      if (filtered.unavailable) warnings.add(`repository-unavailable:${repository.id}`)
      else if (filtered.incomplete) warnings.add(`ignore-unverified:${repository.id}`)
    }
    for (const row of rows) {
      last = { at: row.at, id: row.id }
      scanned++
      const repository = row.repository_id == null ? primary : repositoryById.get(row.repository_id)
      if (repository && allowedByRepository.get(repository.id)?.has(row.file_path)) {
        entries.push({ id: row.id, repositoryId: repository.id, repositoryName: repository.name,
          path: row.file_path, jobId: row.job_id, ticketId: row.ticket_id, kind: row.kind, at: row.at,
          hasPatch: !!row.has_patch, patchTruncated: !!row.patch_truncated })
      }
      if (entries.length >= limit) break
    }
  }
  const more = !exhausted && last !== undefined && !!db.prepare(`SELECT 1 FROM file_provenance p WHERE ${where} AND (p.at < ? OR (p.at = ? AND p.id < ?)) LIMIT 1`).get(...parameters, last.at, last.at, last.id)
  if (more && entries.length < limit) warnings.add(scanned >= MAX_SCAN_ROWS ? 'scan-limit' : 'time-limit')
  return {
    entries, nextCursor: more && last ? Buffer.from(JSON.stringify({ v: 1, scope, snapshot, ...last } satisfies Cursor)).toString('base64url') : null,
    truncated: warnings.size > 0, warnings: [...warnings],
  }
}
