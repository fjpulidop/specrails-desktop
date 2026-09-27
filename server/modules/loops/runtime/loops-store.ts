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
  }
}

// Backups can be large; load their contents only for an explicit export.
const loopColumns = 'id, name, description, status, graph, created_at, updated_at, (graph_legacy IS NOT NULL) AS has_legacy_graph'

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
  patch: { name?: string; description?: string | null; graph?: LoopGraph }
): LoopDefinition | undefined {
  return db.transaction(() => {
    const existing = getLoop(db, id)
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
    db.prepare(`UPDATE loops SET status = 'published', updated_at = datetime('now') WHERE id = ?`).run(id)
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
