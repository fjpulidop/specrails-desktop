/**
 * Attention policy (pure, no React, no DOM): given something that needs the
 * person and where they are, decide how — or whether — to tell them.
 *
 * - `notify`: an OS notification (the person is away from the app, or the alert
 *   must interrupt even a focused window, like a stuck run).
 * - `toast`: an in-app toast (the app is focused, but on another place).
 * - `skip`: nothing (disabled, category off, project muted, or the place is on screen).
 *
 * The prefs mirror `server/modules/inbox/attention-prefs.ts` (the server stores
 * them; this module only reads them).
 */

export const ATTENTION_CATEGORIES = ['question', 'review', 'failed', 'budget', 'done'] as const
export type AttentionCategory = (typeof ATTENTION_CATEGORIES)[number]

export interface AttentionPrefs {
  enabled: boolean
  categories: Record<AttentionCategory, boolean>
  sound: boolean
  dockBadge: boolean
  mutedProjects: string[]
}

export const DEFAULT_ATTENTION_PREFS: AttentionPrefs = Object.freeze({
  enabled: true,
  categories: Object.freeze({ question: true, review: true, failed: true, budget: true, done: true }),
  sound: false,
  dockBadge: true,
  mutedProjects: Object.freeze([]) as unknown as string[],
}) as AttentionPrefs

export interface AttentionSituation {
  category: AttentionCategory
  projectId: string | null
  /** Some window of the app has the keyboard focus. */
  windowFocused: boolean
  /** The item's own place is visible in the focused window (the person is looking at it). */
  placeOnScreen: boolean
  /** Interrupt even a focused window (a stalled run the person cannot see stalling). */
  persistent?: boolean
}

export type AttentionDecision = 'notify' | 'toast' | 'skip'

export function isProjectMuted(prefs: AttentionPrefs, projectId: string | null): boolean {
  return projectId !== null && prefs.mutedProjects.includes(projectId)
}

export function decideAttention(situation: AttentionSituation, prefs: AttentionPrefs): AttentionDecision {
  if (!prefs.enabled || !prefs.categories[situation.category]) return 'skip'
  if (isProjectMuted(prefs, situation.projectId)) return 'skip'
  if (situation.persistent) return 'notify'
  if (!situation.windowFocused) return 'notify'
  // A finished job is good news, not a request: while the person is in the
  // app it is visible where it ran, so it never interrupts with a toast.
  if (situation.category === 'done') return 'skip'
  return situation.placeOnScreen ? 'skip' : 'toast'
}

/** Defensive read of the wire record (GET/PATCH `/api/attention-prefs`, WS `desktop.attention_prefs`). */
export function readAttentionPrefs(raw: unknown): AttentionPrefs {
  const value = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
  const categories = (value.categories && typeof value.categories === 'object' ? value.categories : {}) as Record<string, unknown>
  return {
    enabled: bool(value.enabled, DEFAULT_ATTENTION_PREFS.enabled),
    sound: bool(value.sound, DEFAULT_ATTENTION_PREFS.sound),
    dockBadge: bool(value.dockBadge, DEFAULT_ATTENTION_PREFS.dockBadge),
    categories: Object.fromEntries(
      ATTENTION_CATEGORIES.map((category) => [category, bool(categories[category], DEFAULT_ATTENTION_PREFS.categories[category])]),
    ) as Record<AttentionCategory, boolean>,
    mutedProjects: Array.isArray(value.mutedProjects) ? value.mutedProjects.filter((id): id is string => typeof id === 'string' && id.length > 0) : [],
  }
}

/** The localStorage prefs the old job notifications kept (`enabled`, `filter`). */
export const LEGACY_OS_NOTIFICATION_KEY = 'specrails-os-notifications'

/**
 * The one-time migration of the legacy job-notification prefs into a PATCH:
 * `filter: 'completed'` silenced failures (and the stuck / provider-limit alerts
 * filtered with them), `filter: 'failed'` silenced completions. Null when the
 * stored value says nothing beyond the defaults.
 */
export function legacyPrefsPatch(raw: string | null): Partial<Pick<AttentionPrefs, 'enabled'>> & { categories?: Partial<Record<AttentionCategory, boolean>> } | null {
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const { enabled, filter } = parsed as { enabled?: unknown; filter?: unknown }
  const patch: Partial<Pick<AttentionPrefs, 'enabled'>> & { categories?: Partial<Record<AttentionCategory, boolean>> } = {}
  if (enabled === false) patch.enabled = false
  if (filter === 'completed') patch.categories = { failed: false, budget: false }
  else if (filter === 'failed') patch.categories = { done: false }
  return Object.keys(patch).length > 0 ? patch : null
}
