/**
 * Per-machine mission chat preferences in localStorage: favourite missions,
 * the mission list's archive scope and the sticky agent-autonomy tier.
 * Storage is optional: every read and write tolerates its absence.
 */
import type { ArchiveScope, AgentTierLevel } from './agent-api'

export const FAVORITE_CONVERSATIONS_KEY = 'specrails-desktop:favorite-agent-conversations'

export function loadFavoriteConversationIds(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITE_CONVERSATIONS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

export function saveFavoriteConversationIds(ids: ReadonlySet<string>): void {
  try { localStorage.setItem(FAVORITE_CONVERSATIONS_KEY, JSON.stringify([...ids])) } catch { /* ignore */ }
}

export const ARCHIVE_SCOPE_KEY = 'specrails-desktop:missionArchiveScope'

export function loadArchiveScope(): ArchiveScope {
  try {
    const scope = localStorage.getItem(ARCHIVE_SCOPE_KEY)
    return scope === 'archived' || scope === 'all' ? scope : 'active'
  } catch { return 'active' }
}

// Sticky agent-autonomy tier (Observe/Edit/Operate/Autonomous): the last
// explicitly selected level survives across missions and app restarts.
const LAST_TIER_KEY = 'specrails-desktop:agent-tier-last'

export function readLastTierLevel(): AgentTierLevel {
  try {
    const raw = localStorage.getItem(LAST_TIER_KEY)
    const n = raw === null ? 0 : Number.parseInt(raw, 10)
    return (n === 0 || n === 1 || n === 2 || n === 3 ? n : 0) as AgentTierLevel
  } catch {
    return 0
  }
}

export function saveLastTierLevel(level: AgentTierLevel): void {
  try { localStorage.setItem(LAST_TIER_KEY, String(level)) } catch { /* ignore */ }
}
