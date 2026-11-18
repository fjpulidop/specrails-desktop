/**
 * Attention notification preferences (pure). One app-wide record, stored as
 * JSON under the `desktop_settings` key {@link ATTENTION_PREFS_KEY}: whether
 * the app tells the person about what needs them (OS notifications, in-app
 * toasts, the Dock badge), per category, and which projects are muted.
 *
 * Mirror of `client/src/lib/attention/attention-policy.ts` (types only; the
 * server never decides whether to notify, the client does).
 */

export const ATTENTION_PREFS_KEY = 'attention_notifications'

export const ATTENTION_CATEGORIES = ['question', 'review', 'failed', 'budget', 'done'] as const
export type AttentionCategory = (typeof ATTENTION_CATEGORIES)[number]

export interface AttentionPrefs {
  enabled: boolean
  categories: Record<AttentionCategory, boolean>
  sound: boolean
  dockBadge: boolean
  /** Project ids whose attention never notifies (their items stay in the inbox). */
  mutedProjects: string[]
}

export const MAX_MUTED_PROJECTS = 500
const MAX_PROJECT_ID_LENGTH = 200

export function defaultAttentionPrefs(): AttentionPrefs {
  return {
    enabled: true,
    categories: { question: true, review: true, failed: true, budget: true, done: true },
    sound: false,
    dockBadge: true,
    mutedProjects: [],
  }
}

export class AttentionPrefsValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(message)
    this.name = 'AttentionPrefsValidationError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PROJECT_ID_LENGTH
}

/**
 * Stored value → prefs. Tolerant: a missing, corrupt or partial record falls
 * back field by field to the defaults (a bad row must never silence the app).
 */
export function readAttentionPrefs(stored: string | undefined | null): AttentionPrefs {
  const prefs = defaultAttentionPrefs()
  if (!stored) return prefs
  let raw: unknown
  try { raw = JSON.parse(stored) } catch { return prefs }
  if (!isRecord(raw)) return prefs
  if (typeof raw.enabled === 'boolean') prefs.enabled = raw.enabled
  if (typeof raw.sound === 'boolean') prefs.sound = raw.sound
  if (typeof raw.dockBadge === 'boolean') prefs.dockBadge = raw.dockBadge
  if (isRecord(raw.categories)) {
    for (const category of ATTENTION_CATEGORIES) {
      const value = raw.categories[category]
      if (typeof value === 'boolean') prefs.categories[category] = value
    }
  }
  if (Array.isArray(raw.mutedProjects)) {
    prefs.mutedProjects = [...new Set(raw.mutedProjects.filter(isProjectId))].slice(0, MAX_MUTED_PROJECTS)
  }
  return prefs
}

const BOOLEAN_FIELDS = ['enabled', 'sound', 'dockBadge'] as const
const KNOWN_FIELDS = new Set<string>([...BOOLEAN_FIELDS, 'categories', 'mutedProjects'])

/**
 * Partial update (PATCH semantics): every field is optional, `categories` merges
 * per category, `mutedProjects` replaces the list. Anything unknown or of the
 * wrong type is a validation error and nothing is applied.
 */
export function applyAttentionPrefsPatch(current: AttentionPrefs, body: unknown): AttentionPrefs {
  if (!isRecord(body)) throw new AttentionPrefsValidationError('body', 'body must be an object')
  for (const key of Object.keys(body)) {
    if (!KNOWN_FIELDS.has(key)) throw new AttentionPrefsValidationError(key, `unknown field: ${key}`)
  }
  const next: AttentionPrefs = { ...current, categories: { ...current.categories }, mutedProjects: [...current.mutedProjects] }
  for (const field of BOOLEAN_FIELDS) {
    const value = body[field]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw new AttentionPrefsValidationError(field, `${field} must be a boolean`)
    next[field] = value
  }
  if (body.categories !== undefined) {
    if (!isRecord(body.categories)) throw new AttentionPrefsValidationError('categories', 'categories must be an object')
    for (const [category, value] of Object.entries(body.categories)) {
      if (!(ATTENTION_CATEGORIES as readonly string[]).includes(category)) {
        throw new AttentionPrefsValidationError(`categories.${category}`, `unknown category: ${category}`)
      }
      if (typeof value !== 'boolean') throw new AttentionPrefsValidationError(`categories.${category}`, `categories.${category} must be a boolean`)
      next.categories[category as AttentionCategory] = value
    }
  }
  if (body.mutedProjects !== undefined) {
    const list = body.mutedProjects
    if (!Array.isArray(list) || !list.every(isProjectId)) {
      throw new AttentionPrefsValidationError('mutedProjects', 'mutedProjects must be a list of project ids')
    }
    const unique = [...new Set(list)]
    if (unique.length > MAX_MUTED_PROJECTS) {
      throw new AttentionPrefsValidationError('mutedProjects', `at most ${MAX_MUTED_PROJECTS} muted projects`)
    }
    next.mutedProjects = unique
  }
  return next
}
