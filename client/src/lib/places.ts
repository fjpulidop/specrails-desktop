/**
 * Places: the navigable "where am I" of the app, written to the URL so Back /
 * Forward and deep links work.
 *
 * A place is the router location plus the search params below. Everything that
 * is NOT a place (filters, sort, search, tabs inside a modal, run-strip focus,
 * terminal toggle, scroll, composer state, the Board/Mission mode toggle) must
 * never push a history entry.
 *
 * This module is pure: the URL scheme, the mode-aware place key, and the stack
 * that mirrors the router history (so Back can skip entries that mean nothing
 * in the current mode, and the title bar can label its targets).
 */

export type PlaceMode = 'kanban' | 'agent'

/** `?spec=<ticketId>` — the spec detail modal. */
export const SPEC_PARAM = 'spec'
/** `?review=<prDeliveryId>` — the review packet over a mission (route `/review/:id` in Board mode). */
export const REVIEW_PARAM = 'review'
/** `?job=<jobId>` — the job detail over a mission (route `/jobs/:id` in Board mode). */
export const JOB_PARAM = 'job'
/** `?mission=<conversationId>` — the selected mission (Mission mode). */
export const MISSION_PARAM = 'mission'
/** `?inbox=1` — the "Needs you" inbox panel, over whatever place the person is on. */
export const INBOX_PARAM = 'inbox'
/** `?overlay=loops|plugins|docs|analytics` — a full-page modal. */
export const OVERLAY_PARAM = 'overlay'
/**
 * `?view=<savedViewId>` — a saved specs-board view (CD4). NOT a place: opening a
 * link applies the view and the param is dropped in place (replace), and picking
 * a view in the switcher never touches history. `placeKey` ignores it.
 */
export const VIEW_PARAM = 'view'
/** `?p=<projectId>` — the project a place belongs to (Back across a project switch restores it). */
export const PROJECT_PARAM = 'p'

export const OVERLAY_KINDS = ['loops', 'plugins', 'docs', 'analytics'] as const
export type OverlayKind = (typeof OVERLAY_KINDS)[number]

export function parseOverlay(value: string | null): OverlayKind | null {
  return (OVERLAY_KINDS as readonly string[]).includes(value ?? '') ? (value as OverlayKind) : null
}

/** Marker stored in `location.state` on entries a place param pushed, so closing pops them. */
export const PLACE_PUSH_STATE = 'placePush'

export interface PlaceLocation {
  pathname: string
  search: string
}

export interface PlaceEntry extends PlaceLocation {
  /** react-router `location.key`. */
  key: string
  /** Project that was active when the entry was created (null before the project list resolved). */
  projectId: string | null
  /** First successfully resolved human label (kept so a later deletion still labels the entry). */
  label?: string
}

/** `/review/:id` → id. */
export function reviewIdFromPath(pathname: string): string | null {
  const m = /^\/review\/([^/]+)\/?$/.exec(pathname)
  return m ? decodeURIComponent(m[1]) : null
}

/** `/jobs/:id` → id. */
export function jobIdFromPath(pathname: string): string | null {
  const m = /^\/jobs\/([^/]+)\/?$/.exec(pathname)
  return m ? decodeURIComponent(m[1]) : null
}

/**
 * The mode-aware identity of a place in `mode`: two entries with the same key
 * are the same place, so Back/Forward skip the duplicate instead of landing on
 * something that looks like a no-op.
 *
 * - Board mode: the route (+ spec, + docs/analytics overlays). `?mission` is
 *   meaningless there; `?review`/`?job`/loops/plugins overlays are the same
 *   place as their route form (`/review/:id`, `/jobs/:id`, `/loops`, `/plugins`).
 * - Mission mode: the mission + overlays (spec, review, job, overlay). Board
 *   routes (`/jobs`, `/analytics`...) render nothing there, so they collapse
 *   onto the mission itself; `/docs` stays a real routed place; `/loops`,
 *   `/plugins`, `/review/:id` map to their modal form. See `isComposeKey` for
 *   the compose screen.
 */
export function placeKey(entry: PlaceLocation & { projectId?: string | null }, mode: PlaceMode): string | null {
  const params = new URLSearchParams(entry.search)
  const path = entry.pathname
  const spec = params.get(SPEC_PARAM) ?? ''
  const reviewId = params.get(REVIEW_PARAM) ?? reviewIdFromPath(path) ?? ''
  const jobId = params.get(JOB_PARAM) ?? jobIdFromPath(path) ?? ''
  let overlay: string = parseOverlay(params.get(OVERLAY_PARAM)) ?? ''
  if (path.startsWith('/loops')) overlay = 'loops'
  else if (path.startsWith('/plugins')) overlay = 'plugins'
  const project = entry.projectId ?? ''
  // Appended only while open, so the key of every other place keeps its shape.
  const inbox = params.get(INBOX_PARAM) === '1' ? '|i=1' : ''

  if (mode === 'kanban') {
    // Param-form overlays that only exist as modals in Mission mode collapse onto their route.
    const asRoute = reviewId ? `/review/${reviewId}`
      : jobId ? `/jobs/${jobId}`
        : overlay === 'loops' && !path.startsWith('/loops') ? '/loops'
          : overlay === 'plugins' && !path.startsWith('/plugins') ? '/plugins'
            : path
    const kanbanOverlay = overlay === 'docs' || overlay === 'analytics' ? overlay : ''
    return `k|${project}|${asRoute}|s=${spec}|o=${kanbanOverlay}${inbox}`
  }

  const mission = params.get(MISSION_PARAM) ?? ''
  const isDocsRoute = path.startsWith('/docs')
  return `a|${project}|${isDocsRoute ? path : '/'}|m=${mission}|s=${spec}|r=${reviewId}|j=${jobId}|o=${overlay}${inbox}`
}

/**
 * The Mission-mode compose screen (no mission selected) or an overlay over it.
 * Going back TO it from a place that has a mission would mean resetting the
 * conversation to a new-mission draft, which Back/Forward must never do — so
 * the stack only treats it as reachable from another compose-context place.
 */
export function isComposeKey(key: string | null): boolean {
  return key !== null && key.startsWith('a|') && key.includes('|/|m=|')
}

// ── User intent marker ──────────────────────────────────────────────────────
// A mission the person picked (sidebar, selector, palette) is a PLACE (push);
// one the app selected on its own (initial restore, first send creating the
// conversation) is not (replace). The selection finishes asynchronously, so the
// click leaves a short-lived mark the URL sync consumes.
let userIntentAt = 0
const USER_INTENT_TTL_MS = 10_000

export function markUserPlaceIntent(): void {
  userIntentAt = Date.now()
}

export function consumeUserPlaceIntent(): boolean {
  const fresh = userIntentAt > 0 && Date.now() - userIntentAt < USER_INTENT_TTL_MS
  userIntentAt = 0
  return fresh
}

const MAX_SCAN = 50

/**
 * Mirror of the router history stack. The router owns the real history; this
 * records what each index holds (so Back can pick the nearest *distinct,
 * restorable* entry and the UI can label targets). Indices follow react-router's
 * `history.state.idx` scheme.
 */
export class PlaceStack {
  idx = 0
  private entries = new Map<number, PlaceEntry>()
  private byKey = new Map<string, number>()
  private dead = new Set<number>()
  private started = false

  /** Record a navigation. `browserIdx` is `history.state.idx` when the router exposes it. */
  record(
    navType: 'PUSH' | 'REPLACE' | 'POP',
    loc: PlaceLocation & { key: string },
    projectId: string | null,
    browserIdx?: number,
  ): PlaceEntry {
    if (!this.started) {
      this.started = true
      this.idx = typeof browserIdx === 'number' ? browserIdx : 0
      return this.put(this.idx, { ...loc, projectId })
    }
    if (navType === 'PUSH') {
      // The router numbers its entries (`history.state.idx`): trust it when a
      // render was skipped (two navigations batched into one) so we never drift.
      const next = typeof browserIdx === 'number' && browserIdx > this.idx ? browserIdx : this.idx + 1
      for (const i of [...this.entries.keys()]) if (i >= next) this.drop(i)
      this.idx = next
      return this.put(next, { ...loc, projectId })
    }
    if (navType === 'REPLACE') {
      const prev = this.entries.get(this.idx)
      return this.put(this.idx, { ...loc, projectId: prev?.projectId ?? projectId })
    }
    const known = this.byKey.get(loc.key)
    const target = known ?? (typeof browserIdx === 'number' ? browserIdx : this.idx)
    this.idx = target
    const existing = this.entries.get(target)
    if (existing && existing.key === loc.key) return existing
    return this.put(target, { ...loc, projectId: existing?.projectId ?? projectId })
  }

  private drop(i: number) {
    const e = this.entries.get(i)
    if (e) this.byKey.delete(e.key)
    this.entries.delete(i)
    this.dead.delete(i)
  }

  private put(i: number, entry: PlaceEntry): PlaceEntry {
    const prev = this.entries.get(i)
    if (prev) this.byKey.delete(prev.key)
    this.dead.delete(i)
    this.entries.set(i, entry)
    this.byKey.set(entry.key, i)
    return entry
  }

  current(): PlaceEntry | undefined {
    return this.entries.get(this.idx)
  }

  at(i: number): PlaceEntry | undefined {
    return this.entries.get(i)
  }

  /** Fill the project of an entry created before the project list resolved. */
  adoptProject(projectId: string | null) {
    const cur = this.entries.get(this.idx)
    if (cur && cur.projectId === null && projectId) cur.projectId = projectId
  }

  markDead(i: number) {
    this.dead.add(i)
  }

  /** Highest index that exists (forward entries are only known up to it). */
  get maxIdx(): number {
    let max = this.idx
    for (const i of this.entries.keys()) if (i > max) max = i
    return max
  }

  /**
   * Nearest index in `dir` holding a place different from the current one that
   * is restorable in the current mode. Entries this session never saw (before a
   * reload) count as distinct and restorable.
   */
  findTarget(dir: 1 | -1, keyOf: (e: PlaceEntry) => string | null): number | null {
    const cur = this.entries.get(this.idx)
    const curKey = cur ? keyOf(cur) : null
    const limit = dir === -1 ? Math.max(0, this.idx - MAX_SCAN) : this.maxIdx
    for (let i = this.idx + dir; dir === -1 ? i >= limit : i <= limit; i += dir) {
      const e = this.entries.get(i)
      if (!e) {
        if (dir === -1) return i // pre-reload entry: unknown but navigable
        continue
      }
      if (this.dead.has(i)) continue
      const k = keyOf(e)
      if (k === null) continue
      if (k === curKey) continue
      if (isComposeKey(k) && !isComposeKey(curKey)) continue
      return i
    }
    return null
  }

  /**
   * The most recently visited distinct places (highest history index first, any
   * direction), excluding the current place, dead entries and the compose screen.
   * Feeds the palette's "Recent places".
   */
  recent(keyOf: (e: PlaceEntry) => string | null, limit = 5): { idx: number; entry: PlaceEntry }[] {
    const cur = this.entries.get(this.idx)
    const seen = new Set<string>()
    const curKey = cur ? keyOf(cur) : null
    if (curKey) seen.add(curKey)
    const out: { idx: number; entry: PlaceEntry }[] = []
    const idxs = [...this.entries.keys()].sort((a, b) => b - a)
    for (const i of idxs) {
      if (i === this.idx || this.dead.has(i)) continue
      const e = this.entries.get(i)
      if (!e) continue
      const k = keyOf(e)
      if (k === null || seen.has(k) || isComposeKey(k)) continue
      seen.add(k)
      out.push({ idx: i, entry: e })
      if (out.length >= limit) break
    }
    return out
  }

  /** Up to `limit` distinct places in `dir`, nearest first (consecutive duplicates collapsed). */
  list(dir: 1 | -1, keyOf: (e: PlaceEntry) => string | null, limit = 10): { idx: number; entry: PlaceEntry }[] {
    const out: { idx: number; entry: PlaceEntry }[] = []
    const cur = this.entries.get(this.idx)
    const curKey = cur ? keyOf(cur) : null
    let lastKey = curKey
    const end = dir === -1 ? Math.max(0, this.idx - MAX_SCAN) : this.maxIdx
    for (let i = this.idx + dir; dir === -1 ? i >= end : i <= end; i += dir) {
      const e = this.entries.get(i)
      if (!e || this.dead.has(i)) continue
      const k = keyOf(e)
      if (k === null || k === lastKey) continue
      if (isComposeKey(k) && !isComposeKey(curKey)) continue
      lastKey = k
      out.push({ idx: i, entry: e })
      if (out.length >= limit) break
    }
    return out
  }
}
