import { MAX_RECENT_ACTIONS } from './palette-actions'

/** Per viewer (localStorage); never project data, only action ids. */
export const RECENT_ACTIONS_KEY = 'specrails-desktop:palette:recent-actions'

export function readRecentActionIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_ACTIONS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX_RECENT_ACTIONS) : []
  } catch {
    return []
  }
}

/** Puts `id` first, drops a repeat, keeps the last few. Returns the new list. */
export function recordRecentAction(id: string): string[] {
  const next = [id, ...readRecentActionIds().filter((x) => x !== id)].slice(0, MAX_RECENT_ACTIONS)
  try {
    localStorage.setItem(RECENT_ACTIONS_KEY, JSON.stringify(next))
  } catch {
    // storage unavailable (private window, blocked): the list just does not persist
  }
  return next
}
