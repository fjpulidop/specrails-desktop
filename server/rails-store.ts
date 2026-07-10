import type { DbInstance } from './db'

/** The three rails every project starts with (indices 0-2, never auto-removed). */
export const BASE_RAIL_COUNT = 3
/** Hard cap on rails per project — keeps railIndex-keyed maps (metrics,
 *  pr-deliveries, worktree progress) bounded and the board renderable. */
export const MAX_RAILS = 12

export interface RailState {
  railIndex: number
  ticketIds: number[]
  mode: string
  /** Optional agent profile to use when launching this rail. null/undefined = default resolution. */
  profileName?: string | null
  /** Optional AI engine override (multi-provider projects). null/undefined = project's primary provider. */
  aiEngine?: string | null
  /** User-given display name (suffix after "Rail "), synced desktop ⇄ mobile. null = default "Rail N". */
  name?: string | null
}

/** Read the per-rail display names from rail_meta into a lookup map. */
function railNames(db: DbInstance): Map<number, string | null> {
  const rows = db.prepare('SELECT rail_index, name FROM rail_meta').all() as {
    rail_index: number
    name: string | null
  }[]
  const map = new Map<number, string | null>()
  for (const r of rows) map.set(r.rail_index, r.name)
  return map
}

/** Materialize a rail's identity row (idempotent). rail_meta is the existence
 *  authority for rails: a rail exists iff it has a rail_meta row (the base
 *  three are seeded by db migration 39; created rails insert theirs) or any
 *  leftover ticket rows. Called by every mutation that "touches" a rail so a
 *  rail the client only knew locally (legacy localStorage rail-4+) becomes
 *  server-backed the first time it is named / assigned tickets. */
export function ensureRailMeta(db: DbInstance, railIndex: number): void {
  db.prepare('INSERT OR IGNORE INTO rail_meta (rail_index, name) VALUES (?, NULL)').run(railIndex)
}

/** Every existing rail index, ascending: the union of rail_meta identity rows
 *  and any index that still holds ticket rows (defensive — covers rows written
 *  before rail_meta materialization existed). */
export function listRailIndices(db: DbInstance): number[] {
  const rows = db
    .prepare(
      'SELECT rail_index FROM rail_meta UNION SELECT rail_index FROM rails ORDER BY rail_index'
    )
    .all() as { rail_index: number }[]
  return rows.map((r) => r.rail_index)
}

/** How many rails currently exist (>= BASE_RAIL_COUNT unless deleted below it). */
export function railCount(db: DbInstance): number {
  return listRailIndices(db).length
}

/** Whether a rail exists (base rails always do; dynamic rails via rail_meta/rows). */
export function railExists(db: DbInstance, railIndex: number): boolean {
  return listRailIndices(db).includes(railIndex)
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function getRails(db: DbInstance): RailState[] {
  const rows = db
    .prepare(
      'SELECT rail_index, ticket_id, position, mode, profile_name, ai_engine FROM rails ORDER BY rail_index, position'
    )
    .all() as {
      rail_index: number
      ticket_id: number
      position: number
      mode: string
      profile_name: string | null
      ai_engine: string | null
    }[]

  const map = new Map<
    number,
    { ticketIds: number[]; mode: string; profileName: string | null; aiEngine: string | null }
  >()
  for (const row of rows) {
    if (!map.has(row.rail_index)) {
      map.set(row.rail_index, {
        ticketIds: [],
        mode: row.mode,
        profileName: row.profile_name,
        aiEngine: row.ai_engine,
      })
    }
    map.get(row.rail_index)!.ticketIds.push(row.ticket_id)
  }

  const names = railNames(db)
  // DYNAMIC rail count: every rail with an identity row (rail_meta) or ticket
  // rows is listed — the base three are seeded, created rails append, deleted
  // dynamic rails disappear (indices may be sparse after a middle deletion).
  return listRailIndices(db).map((railIndex) => {
    const rail = map.get(railIndex)
    return {
      railIndex,
      ticketIds: rail?.ticketIds ?? [],
      mode: rail?.mode ?? 'implement',
      profileName: rail?.profileName ?? null,
      aiEngine: rail?.aiEngine ?? null,
      name: names.get(railIndex) ?? null,
    }
  })
}

export function getRail(db: DbInstance, railIndex: number): RailState {
  const rows = db
    .prepare(
      'SELECT ticket_id, position, mode, profile_name, ai_engine FROM rails WHERE rail_index = ? ORDER BY position'
    )
    .all(railIndex) as {
      ticket_id: number
      position: number
      mode: string
      profile_name: string | null
      ai_engine: string | null
    }[]

  const meta = db.prepare('SELECT name FROM rail_meta WHERE rail_index = ?').get(railIndex) as
    | { name: string | null }
    | undefined

  return {
    railIndex,
    ticketIds: rows.map((r) => r.ticket_id),
    mode: rows[0]?.mode ?? 'implement',
    profileName: rows[0]?.profile_name ?? null,
    aiEngine: rows[0]?.ai_engine ?? null,
    name: meta?.name ?? null,
  }
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function setRailTickets(
  db: DbInstance,
  railIndex: number,
  ticketIds: number[],
  mode?: string,
  profileName?: string | null,
  aiEngine?: string | null,
): RailState {
  const deleteStmt = db.prepare('DELETE FROM rails WHERE rail_index = ?')
  const insertStmt = db.prepare(
    'INSERT INTO rails (rail_index, ticket_id, position, mode, profile_name, ai_engine) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const resolvedMode = mode ?? 'implement'
  const resolvedProfile = profileName === undefined ? null : profileName
  // undefined → preserve existing engine across re-orders; null → explicit clear.
  const resolvedEngine =
    aiEngine === undefined ? (getRail(db, railIndex).aiEngine ?? null) : aiEngine

  db.transaction(() => {
    // Materialize the rail's identity so a rail first touched by a ticket sync
    // (e.g. a legacy client-local rail-4+ at launch time) persists server-side
    // even after its tickets are released.
    ensureRailMeta(db, railIndex)
    deleteStmt.run(railIndex)
    for (let i = 0; i < ticketIds.length; i++) {
      insertStmt.run(railIndex, ticketIds[i], i, resolvedMode, resolvedProfile, resolvedEngine)
    }
    if (ticketIds.length === 0) {
      db.prepare('DELETE FROM rail_ticket_ownership WHERE rail_index = ?').run(railIndex)
    } else {
      const placeholders = ticketIds.map(() => '?').join(', ')
      db.prepare(
        `DELETE FROM rail_ticket_ownership
          WHERE rail_index = ? AND ticket_id NOT IN (${placeholders})`
      ).run(railIndex, ...ticketIds)
    }
  })()

  return { railIndex, ticketIds, mode: resolvedMode, profileName: resolvedProfile, aiEngine: resolvedEngine }
}

/** Claim the exact rail assignments for a concrete launch. Relaunching the
 * same ticket advances its generation and replaces owner_id, so a delayed
 * terminal replay from an older job/run cannot remove the new assignment. */
export function claimRailTickets(
  db: DbInstance,
  railIndex: number,
  ticketIds: readonly number[],
  ownerId: string,
): void {
  const claim = db.prepare(`
    INSERT INTO rail_ticket_ownership (
      rail_index, ticket_id, owner_id, generation, claimed_at
    ) VALUES (?, ?, ?, 1, datetime('now'))
    ON CONFLICT(rail_index, ticket_id) DO UPDATE SET
      owner_id = excluded.owner_id,
      generation = rail_ticket_ownership.generation + 1,
      claimed_at = excluded.claimed_at
  `)
  db.transaction(() => {
    for (const ticketId of [...new Set(ticketIds)]) {
      claim.run(railIndex, ticketId, ownerId)
    }
  })()
}

/** Project-wide causal owner for ticket terminal effects. Unlike the JSON
 * applied-effect marker, this claim participates in the same SQLite commit as
 * queue/loop admission, so a hard crash cannot create a ghost filesystem owner
 * or admit work without ownership. */
export function claimTicketOutcomeOwners(
  db: DbInstance,
  ticketIds: readonly number[],
  ownerId: string,
): void {
  const claim = db.prepare(`
    INSERT INTO ticket_outcome_ownership (
      ticket_id, owner_id, generation, claimed_at
    ) VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(ticket_id) DO UPDATE SET
      owner_id = excluded.owner_id,
      generation = ticket_outcome_ownership.generation + 1,
      claimed_at = excluded.claimed_at
  `)
  for (const ticketId of [...new Set(ticketIds)]) claim.run(ticketId, ownerId)
}

export function ticketOutcomeOwner(db: DbInstance, ticketId: number): string | null {
  try {
    const row = db.prepare(`
      SELECT owner_id FROM ticket_outcome_ownership WHERE ticket_id = ?
    `).get(ticketId) as { owner_id: string } | undefined
    return row?.owner_id ?? null
  } catch (err) {
    // Compatibility only for isolated pre-migration schemas. Every other DB
    // error must fail closed; treating corruption/closed handles as "legacy"
    // would authorize a stale callback.
    if (String((err as Error)?.message ?? err).includes('no such table: ticket_outcome_ownership')) {
      return null
    }
    throw err
  }
}

export interface ReleasedRailTickets {
  rail: RailState
  releasedTicketIds: number[]
}

/** Release only assignments still owned by `ownerId`. `allowUnowned` exists
 * solely for pre-migration live/recovery rows; new launches always claim and
 * therefore fail closed when another generation has taken ownership. */
export function releaseRailTicketsOwnedBy(
  db: DbInstance,
  ownerId: string,
  ticketIds: readonly number[],
  opts?: { railIndex?: number | null; allowUnowned?: boolean },
): ReleasedRailTickets[] {
  const wanted = new Set(ticketIds)
  if (wanted.size === 0) return []
  const rails = opts?.railIndex == null ? getRails(db) : [getRail(db, opts.railIndex)]
  const released: ReleasedRailTickets[] = []
  db.transaction(() => {
    for (const rail of rails) {
      const removed: number[] = []
      for (const ticketId of rail.ticketIds) {
        if (!wanted.has(ticketId)) continue
        const claim = db.prepare(`
          SELECT owner_id FROM rail_ticket_ownership
           WHERE rail_index = ? AND ticket_id = ?
        `).get(rail.railIndex, ticketId) as { owner_id: string } | undefined
        if (claim?.owner_id === ownerId || (!claim && opts?.allowUnowned === true)) {
          removed.push(ticketId)
        }
      }
      if (removed.length === 0) continue
      const remaining = rail.ticketIds.filter((id) => !removed.includes(id))
      const next = setRailTickets(
        db,
        rail.railIndex,
        remaining,
        rail.mode,
        rail.profileName,
        rail.aiEngine,
      )
      db.prepare(`
        DELETE FROM rail_ticket_ownership
         WHERE rail_index = ? AND owner_id = ?
           AND ticket_id IN (${removed.map(() => '?').join(', ')})
      `).run(rail.railIndex, ownerId, ...removed)
      released.push({ rail: { ...next, name: rail.name }, releasedTicketIds: removed })
    }
  })()
  return released
}

/**
 * Update only the profile for a rail, preserving tickets and mode.
 * No-op (returns current state) when the rail has no tickets yet — the
 * profile is stored as a column on each rail row.
 */
export function setRailProfile(
  db: DbInstance,
  railIndex: number,
  profileName: string | null,
): RailState {
  const current = getRail(db, railIndex)
  if (current.ticketIds.length === 0) {
    // No rows to update; insert a placeholder row? No — we store profile on
    // each ticket row. Users must assign tickets first. Caller checks.
    return { ...current, profileName }
  }
  db.prepare('UPDATE rails SET profile_name = ? WHERE rail_index = ?').run(profileName, railIndex)
  return { ...current, profileName }
}

/**
 * Update only the AI engine for a rail, preserving tickets, mode and profile.
 * Like setRailProfile, no-op (returns current state with the new engine) when
 * the rail has no tickets yet — the engine is stored on each rail row.
 */
export function setRailEngine(
  db: DbInstance,
  railIndex: number,
  aiEngine: string | null,
): RailState {
  const current = getRail(db, railIndex)
  if (current.ticketIds.length === 0) {
    return { ...current, aiEngine }
  }
  db.prepare('UPDATE rails SET ai_engine = ? WHERE rail_index = ?').run(aiEngine, railIndex)
  return { ...current, aiEngine }
}

/**
 * Create the next rail (index = highest existing + 1) with an optional display
 * name. The caller (rails-router / MCP create_rail) enforces the MAX_RAILS cap
 * — the store itself stays mechanism-only. Returns the new rail's state.
 */
export function createRail(db: DbInstance, name?: string | null): RailState {
  // Lowest free index (not max+1): re-filling a deleted middle rail's slot keeps
  // indices bounded below MAX_RAILS whenever the COUNT is below the cap. Reuse
  // is safe — the delete guards ensure a deleted index left no active run or
  // undecided PR delivery behind.
  const taken = new Set(listRailIndices(db))
  let railIndex = 0
  while (taken.has(railIndex)) railIndex++
  const trimmed = typeof name === 'string' ? name.trim() : null
  const value = trimmed && trimmed.length > 0 ? trimmed : null
  db.prepare('INSERT OR IGNORE INTO rail_meta (rail_index, name) VALUES (?, ?)').run(railIndex, value)
  return { railIndex, ticketIds: [], mode: 'implement', profileName: null, aiEngine: null, name: value }
}

/**
 * Delete a rail's identity + ticket assignments atomically. Pure mechanism —
 * the router enforces the guards (rail exists, idle, no pending PR decision,
 * not the last rail) before calling it. Deleting a middle rail leaves a sparse index gap on purpose: indices
 * are IDENTITY (metrics / pr-deliveries / worktree maps key by railIndex), so
 * they are never compacted/re-numbered.
 */
export function deleteRail(db: DbInstance, railIndex: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM rail_ticket_ownership WHERE rail_index = ?').run(railIndex)
    db.prepare('DELETE FROM rail_meta WHERE rail_index = ?').run(railIndex)
    db.prepare('DELETE FROM rails WHERE rail_index = ?').run(railIndex)
  })()
}

/**
 * Set a rail's display name (the "Rail "-suffix the user types). Stored in
 * rail_meta (ticket-independent) so even an empty rail keeps its name. Pass
 * an empty/whitespace name to clear it back to the default "Rail N" label.
 */
export function setRailName(
  db: DbInstance,
  railIndex: number,
  name: string | null,
): RailState {
  const trimmed = typeof name === 'string' ? name.trim() : null
  const value = trimmed && trimmed.length > 0 ? trimmed : null
  db.prepare(
    `INSERT INTO rail_meta (rail_index, name) VALUES (?, ?)
     ON CONFLICT(rail_index) DO UPDATE SET name = excluded.name`
  ).run(railIndex, value)
  return { ...getRail(db, railIndex), name: value }
}
