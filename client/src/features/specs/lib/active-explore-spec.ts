// Persists the currently-open (visible) ExploreSpec session so a browser
// refresh while the shell is on screen restores the user back into the same
// conversation, instead of dropping the in-progress draft.
//
// Minimized chats are persisted separately by MinimizedChatsContext — the
// two stores are mutually exclusive: minimizing clears this entry, the chip
// persistence takes over.

const STORAGE_KEY = 'specrails-desktop:active-explore-spec'

export interface ActiveExploreSpec {
  projectId: string
  idea: string
  pendingSpecId: string
  initialAttachmentIds: string[]
  resumeConversationId?: string
  seedDraftTitle?: string
  composerText?: string
  draftOverrides?: {
    title?: string
    description?: string
    priority?: 'low' | 'medium' | 'high' | 'critical'
    labels?: string[]
    acceptanceCriteria?: string[]
  }
}

export function loadActiveExploreSpec(): ActiveExploreSpec | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!isValid(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export function saveActiveExploreSpec(value: ActiveExploreSpec): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    /* quota or storage unavailable — silent */
  }
}

export function clearActiveExploreSpec(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* silent */
  }
}

function isValid(v: unknown): v is ActiveExploreSpec {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.projectId === 'string' &&
    typeof o.idea === 'string' &&
    typeof o.pendingSpecId === 'string' &&
    Array.isArray(o.initialAttachmentIds) &&
    o.initialAttachmentIds.every((x) => typeof x === 'string')
  )
}
