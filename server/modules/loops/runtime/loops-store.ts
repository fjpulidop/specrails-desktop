/**
 * Loops store — CRUD + Draft/Published lifecycle over the app-level `loops`
 * table in `desktop.sqlite` (see desktop-db.ts migration 14).
 *
 * Definitions are GLOBAL (cross-project): a loop is a reusable recipe consumed
 * from any project's rail. The third lifecycle state "Running" is NOT stored
 * here — it is derived from active per-project `loop_runs` and enforced at the
 * router/service layer (which can see the project registry); this store stays
 * focused on the persistent definition + the Draft⇄Published transition.
 */
import { createHash } from 'crypto'
import type { DbInstance } from '../../../db'
import { validateLoopGraph, emptyLoopGraph, type LoopGraph, type GraphValidationError } from './loop-graph'

export type LoopStatus = 'draft' | 'published'

export interface LoopDefinition {
  id: string
  name: string
  description: string | null
  status: LoopStatus
  graph: LoopGraph
  createdAt: string
  updatedAt: string
  /** Present only when a pre-conversion graph was preserved. */
  hasLegacyGraph?: true
  /** Canonical factory id when this row IS an editable built-in loop. */
  builtinId?: string
  /** Built-in rows only: true once its content differs from the seeded default. */
  builtinModified?: boolean
}

interface LoopRowRaw {
  id: string
  name: string
  description: string | null
  status: string
  graph: string
  created_at: string
  updated_at: string
  graph_legacy: string | null
  graph_legacy_saved_at: string | null
  has_legacy_graph?: number
  builtin_id?: string | null
  builtin_default_hash?: string | null
}

/** Thrown by {@link publishLoop} when the graph fails validation. The router
 *  maps this to a 422 carrying the per-node errors. */
export class LoopValidationError extends Error {
  readonly errors: GraphValidationError[]
  constructor(errors: GraphValidationError[]) {
    super(`Loop graph is invalid (${errors.length} error${errors.length === 1 ? '' : 's'})`)
    this.name = 'LoopValidationError'
    this.errors = errors
  }
}

/** Validation cannot authorize publishing a different edit made while Core loaded. */
export class LoopPublicationConflict extends Error {
  constructor() { super('Loop changed during validation; reload and publish again'); this.name = 'LoopPublicationConflict' }
}

function mapRow(raw: LoopRowRaw | undefined): LoopDefinition | undefined {
  if (!raw) return undefined
  let graph: LoopGraph
  try {
    graph = JSON.parse(raw.graph) as LoopGraph
  } catch {
    graph = emptyLoopGraph()
  }
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    status: raw.status === 'published' ? 'published' : 'draft',
    graph,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    ...(raw.has_legacy_graph ? { hasLegacyGraph: true as const } : {}),
    ...(raw.builtin_id ? {
      builtinId: raw.builtin_id,
      builtinModified: builtinContentHash({ name: raw.name, description: raw.description, graph }) !== raw.builtin_default_hash,
    } : {}),
  }
}

/** Content identity of a built-in row (name, description and graph). The
 *  stored hash is the default last seeded, so equality means "unedited". */
export function builtinContentHash(content: { name: string; description: string | null; graph: LoopGraph }): string {
  return createHash('sha256').update(JSON.stringify([content.name, content.description, content.graph])).digest('hex')
}

// Backups can be large; load their contents only for an explicit export.
const loopColumns = 'id, name, description, status, graph, created_at, updated_at, (graph_legacy IS NOT NULL) AS has_legacy_graph, builtin_id, builtin_default_hash'

export function listLoops(db: DbInstance): LoopDefinition[] {
  return (db.prepare(`SELECT ${loopColumns} FROM loops ORDER BY updated_at DESC, created_at DESC`).all() as LoopRowRaw[]).map(
    (r) => mapRow(r)!
  )
}

export function getLoop(db: DbInstance, id: string): LoopDefinition | undefined {
  return mapRow(db.prepare(`SELECT ${loopColumns} FROM loops WHERE id = ?`).get(id) as LoopRowRaw | undefined)
}

/** Create a new loop. Always starts as a Draft. `graph` defaults to an empty
 *  (structurally-invalid-to-publish) canvas the user fills in the builder. */
export function createLoop(
  db: DbInstance,
  input: { id: string; name: string; description?: string | null; graph?: LoopGraph }
): LoopDefinition {
  const graph = input.graph ?? emptyLoopGraph()
  db.prepare(
    `INSERT INTO loops (id, name, description, status, graph) VALUES (?, ?, ?, 'draft', ?)`
  ).run(input.id, input.name, input.description ?? null, JSON.stringify(graph))
  return getLoop(db, input.id)!
}

/**
 * Update a loop's content. ANY edit returns the loop to Draft (editing a
 * Published loop un-publishes it — it must be re-validated and re-published
 * before it is offered in the rail picker again).
 */
export function updateLoop(
  db: DbInstance,
  id: string,
  patch: { name?: string; description?: string | null; graph?: LoopGraph },
  expected?: Pick<LoopDefinition, 'name' | 'description' | 'graph' | 'status'>,
): LoopDefinition | undefined {
  return db.transaction(() => {
    const existing = getLoop(db, id)
    if (expected && (!existing || JSON.stringify([existing.name, existing.description, existing.graph, existing.status]) !==
      JSON.stringify([expected.name, expected.description, expected.graph, expected.status]))) throw new LoopPublicationConflict()
    if (!existing) return undefined
    const name = patch.name ?? existing.name
    const description = patch.description !== undefined ? patch.description : existing.description
    const graph = patch.graph ?? existing.graph
    const converting = patch.graph !== undefined && Array.isArray(graph.nodes) && graph.nodes.some(node => node?.type === 'core') &&
      Array.isArray(existing.graph.nodes) && existing.graph.nodes.some(node => ['ai-step', 'shell', 'decider', 'condition'].includes(node?.type))
    // Both expressions read the old row. A failed save cannot leave a backup
    // that claims a conversion happened, and retries cannot replace its bytes.
    db.prepare(`UPDATE loops SET name = ?, description = ?,
      graph_legacy = CASE WHEN ? THEN COALESCE(graph_legacy, graph) ELSE graph_legacy END,
      graph_legacy_saved_at = CASE WHEN ? THEN COALESCE(graph_legacy_saved_at, datetime('now')) ELSE graph_legacy_saved_at END,
      graph = ?, status = 'draft', updated_at = datetime('now') WHERE id = ?`)
      .run(name, description, Number(converting), Number(converting), JSON.stringify(graph), id)
    return getLoop(db, id)
  }).immediate()
}

/** Read-only original export; does not restore, publish or execute a graph. */
export function readLegacyLoopGraph(db: DbInstance, id: string): { graph: LoopGraph; savedAt: string } | undefined {
  const row = db.prepare('SELECT graph_legacy, graph_legacy_saved_at FROM loops WHERE id = ?').get(id) as Pick<LoopRowRaw, 'graph_legacy' | 'graph_legacy_saved_at'> | undefined
  if (!row?.graph_legacy || !row.graph_legacy_saved_at) return undefined
  return { graph: JSON.parse(row.graph_legacy) as LoopGraph, savedAt: row.graph_legacy_saved_at }
}

/**
 * Validate the graph and, if valid, mark the loop Published (so it becomes
 * selectable in the rail picker). Throws {@link LoopValidationError} otherwise,
 * leaving the loop in Draft.
 */
export function publishLoop(
  db: DbInstance, id: string, validated?: Pick<LoopDefinition, 'name' | 'description' | 'graph' | 'status'>,
): LoopDefinition | undefined {
  return db.transaction(() => {
    const existing = getLoop(db, id)
    if (validated && (!existing || JSON.stringify([existing.name, existing.description, existing.graph, existing.status]) !==
      JSON.stringify([validated.name, validated.description, validated.graph, validated.status]))) throw new LoopPublicationConflict()
    if (!existing) return undefined
    const result = validateLoopGraph(existing.graph)
    if (!result.valid) throw new LoopValidationError(result.errors)
    // The snapshot is what rails launch while a later edit is still Draft.
    db.prepare(`UPDATE loops SET status = 'published', published_graph = graph, updated_at = datetime('now') WHERE id = ?`).run(id)
    return getLoop(db, id)
  }).immediate()
}

/** Return a Published loop to Draft without changing its content. */
export function unpublishLoop(db: DbInstance, id: string): LoopDefinition | undefined {
  const existing = getLoop(db, id)
  if (!existing) return undefined
  db.prepare(`UPDATE loops SET status = 'draft', updated_at = datetime('now') WHERE id = ?`).run(id)
  return getLoop(db, id)
}

/** Clone an existing loop (or template) into a fresh Draft. Used by "Use
 *  template" and by a plain duplicate action. The clone copies the graph
 *  verbatim; node ids are local to a graph so no remapping is needed. */
export function duplicateLoop(
  db: DbInstance,
  id: string,
  newId: string,
  newName: string
): LoopDefinition | undefined {
  const src = getLoop(db, id)
  if (!src) return undefined
  return createLoop(db, { id: newId, name: newName, description: src.description, graph: src.graph })
}

export function deleteLoop(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM loops WHERE id = ?').run(id)
}

/** One loop in an import/export envelope (id/status/timestamps are NOT carried —
 *  imports always land as fresh Drafts with new ids). */
export interface ImportableLoop {
  name: string
  description?: string | null
  graph: LoopGraph
}

/**
 * Import loops as new Drafts. A loop whose (trimmed) NAME already exists is
 * SKIPPED (returned in `skipped`) — the rest import; a malformed/unnamed entry
 * is skipped too. Authoritative dedup happens here (the client list can be
 * stale). New ids are minted by `mintId` so this stays pure of the id module.
 */
export function importLoops(
  db: DbInstance,
  items: unknown,
  mintId: () => string
): { imported: Array<{ id: string; name: string }>; skipped: string[] } {
  const imported: Array<{ id: string; name: string }> = []
  const skipped: string[] = []
  if (!Array.isArray(items)) return { imported, skipped }
  const existing = new Set(listLoops(db).map((l) => l.name))
  for (const raw of items) {
    const item = (raw ?? {}) as Partial<ImportableLoop>
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const graph = item.graph
    if (!name || !graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      skipped.push(name || '(invalid)')
      continue
    }
    if (existing.has(name)) {
      skipped.push(name)
      continue
    }
    const loop = createLoop(db, { id: mintId(), name, description: item.description ?? null, graph })
    existing.add(name)
    imported.push({ id: loop.id, name: loop.name })
  }
  return { imported, skipped }
}

// ── Built-in rows (desktop migration 31) ─────────────────────────────────────

/** Default content of one built-in, as produced by the factory for the current
 *  Core capabilities. `id` is the canonical factory id (also the row id). */
export interface BuiltinLoopDefault {
  id: string
  name: string
  description: string
  graph: LoopGraph
}

export interface BuiltinSeedResult {
  inserted: string[]
  refreshed: string[]
}

/**
 * Ensure one published row per built-in default. Missing rows are inserted
 * (`INSERT OR IGNORE`, so concurrent seeders converge on one row). With
 * `refresh`, a row whose content still equals the default it was seeded with
 * (unedited) is moved to the new default when that default changed — user edits
 * are never overwritten. Rows for built-ins absent from `defaults` are kept.
 */
export function seedBuiltinLoops(
  db: DbInstance,
  defaults: readonly BuiltinLoopDefault[],
  options: { refresh: boolean },
): BuiltinSeedResult {
  const result: BuiltinSeedResult = { inserted: [], refreshed: [] }
  db.transaction(() => {
    for (const builtin of defaults) {
      const hash = builtinContentHash({ name: builtin.name, description: builtin.description, graph: builtin.graph })
      const graph = JSON.stringify(builtin.graph)
      const inserted = db.prepare(`INSERT OR IGNORE INTO loops
        (id, name, description, status, graph, builtin_id, builtin_default_hash, published_graph)
        VALUES (?, ?, ?, 'published', ?, ?, ?, ?)`)
        .run(builtin.id, builtin.name, builtin.description, graph, builtin.id, hash, graph)
      if (inserted.changes > 0) { result.inserted.push(builtin.id); continue }
      if (!options.refresh) continue
      const row = db.prepare(`SELECT ${loopColumns} FROM loops WHERE builtin_id = ?`).get(builtin.id) as LoopRowRaw | undefined
      const current = mapRow(row)
      if (!row || !current || current.builtinModified || row.builtin_default_hash === hash) continue
      db.prepare(`UPDATE loops SET name = ?, description = ?, graph = ?, status = 'published', published_graph = ?,
        builtin_default_hash = ?, updated_at = datetime('now') WHERE builtin_id = ?`)
        .run(builtin.name, builtin.description, graph, graph, hash, builtin.id)
      result.refreshed.push(builtin.id)
    }
  }).immediate()
  return result
}

/** Reset a built-in row to `builtin` (its current default), Published. */
export function restoreBuiltinLoop(db: DbInstance, builtin: BuiltinLoopDefault): LoopDefinition | undefined {
  const hash = builtinContentHash({ name: builtin.name, description: builtin.description, graph: builtin.graph })
  const graph = JSON.stringify(builtin.graph)
  const updated = db.prepare(`UPDATE loops SET name = ?, description = ?, graph = ?, status = 'published', published_graph = ?,
    builtin_default_hash = ?, updated_at = datetime('now') WHERE builtin_id = ?`)
    .run(builtin.name, builtin.description, graph, graph, hash, builtin.id)
  return updated.changes > 0 ? getLoop(db, builtin.id) : undefined
}

/** The built-in row for a canonical factory id, when seeded. */
export function getBuiltinLoop(db: DbInstance, builtinId: string): LoopDefinition | undefined {
  return mapRow(db.prepare(`SELECT ${loopColumns} FROM loops WHERE builtin_id = ?`).get(builtinId) as LoopRowRaw | undefined)
}

/** Last published graph snapshot (null when the loop was never published). */
export function readPublishedLoopGraph(db: DbInstance, id: string): LoopGraph | undefined {
  const row = db.prepare('SELECT published_graph FROM loops WHERE id = ?').get(id) as { published_graph: string | null } | undefined
  if (!row?.published_graph) return undefined
  try { return JSON.parse(row.published_graph) as LoopGraph } catch { return undefined }
}
