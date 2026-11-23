/**
 * App-wide attention preferences, read once from `GET /api/attention-prefs`
 * and kept current by every PATCH answer and the `desktop.attention_prefs`
 * WebSocket broadcast (a change in the settings window applies in the main
 * window at once). One record for the whole app — never project data.
 *
 * The first load also migrates the legacy job-notification prefs that lived
 * in localStorage (`specrails-os-notifications`) and drops that key.
 */
import { API_ORIGIN } from '../origin'
import {
  DEFAULT_ATTENTION_PREFS, LEGACY_OS_NOTIFICATION_KEY, legacyPrefsPatch, readAttentionPrefs,
  type AttentionCategory, type AttentionPrefs,
} from './attention-policy'

export interface AttentionPrefsPatch {
  enabled?: boolean
  sound?: boolean
  dockBadge?: boolean
  categories?: Partial<Record<AttentionCategory, boolean>>
  mutedProjects?: string[]
}

export interface AttentionPrefsStore {
  get(): AttentionPrefs
  loaded(): boolean
  subscribe(listener: () => void): () => void
  /** Resolves once the server's record is known (or after a failed read, with the defaults). */
  ready(): Promise<AttentionPrefs>
  /** Re-read from the server. */
  refresh(): Promise<AttentionPrefs>
  /** Optimistic PATCH; reverts and rethrows when the server refuses. */
  update(patch: AttentionPrefsPatch): Promise<AttentionPrefs>
  /** A record pushed by the server (WS broadcast). */
  apply(raw: unknown): void
  /** Back to "never read" with the defaults (tests). */
  reset(): void
}

type Fetch = typeof fetch

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function mergePatch(current: AttentionPrefs, patch: AttentionPrefsPatch): AttentionPrefs {
  return {
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.sound !== undefined ? { sound: patch.sound } : {}),
    ...(patch.dockBadge !== undefined ? { dockBadge: patch.dockBadge } : {}),
    categories: { ...current.categories, ...(patch.categories ?? {}) },
    mutedProjects: patch.mutedProjects ? [...patch.mutedProjects] : current.mutedProjects,
  }
}

export function createAttentionPrefsStore(fetchImpl: () => Fetch = () => fetch, url = (): string => `${API_ORIGIN}/api/attention-prefs`): AttentionPrefsStore {
  let snapshot: AttentionPrefs = DEFAULT_ATTENTION_PREFS
  let isLoaded = false
  let inflight: Promise<AttentionPrefs> | null = null
  const listeners = new Set<() => void>()

  const set = (next: AttentionPrefs): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const patchServer = async (patch: AttentionPrefsPatch): Promise<AttentionPrefs> => {
    const res = await fetchImpl()(url(), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return readAttentionPrefs(await res.json())
  }

  const migrateLegacy = async (): Promise<void> => {
    const storage = safeStorage()
    const raw = storage?.getItem(LEGACY_OS_NOTIFICATION_KEY) ?? null
    if (raw === null) return
    const patch = legacyPrefsPatch(raw)
    if (patch) set(await patchServer(patch))
    // Only once the server holds the choice (a failed PATCH retries on the next start).
    try { storage?.removeItem(LEGACY_OS_NOTIFICATION_KEY) } catch { /* storage blocked */ }
  }

  const load = (): Promise<AttentionPrefs> => {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const res = await fetchImpl()(url())
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        set(readAttentionPrefs(await res.json()))
        try { await migrateLegacy() } catch { /* keep the server's record; migrate next time */ }
      } catch {
        // Unreachable server: keep what we have (the defaults the first time). Never silence the app on a read error.
      } finally {
        isLoaded = true
        inflight = null
      }
      return snapshot
    })()
    return inflight
  }

  return {
    get: () => snapshot,
    loaded: () => isLoaded,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    ready: () => (isLoaded ? Promise.resolve(snapshot) : load()),
    refresh: load,
    async update(patch) {
      const previous = snapshot
      set(mergePatch(snapshot, patch))
      try {
        const next = await patchServer(patch)
        set(next)
        return next
      } catch (err) {
        set(previous)
        throw err
      }
    },
    apply(raw) {
      isLoaded = true
      set(readAttentionPrefs(raw))
    },
    reset() {
      isLoaded = false
      inflight = null
      set(DEFAULT_ATTENTION_PREFS)
    },
  }
}

/** The app's store (each window has its own JS realm, so one per window). */
export const attentionPrefsStore = createAttentionPrefsStore()
