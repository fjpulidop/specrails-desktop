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
// explicitly selected level survives across missions and app restarts. The
// server keeps the same value as the default of missions created anywhere
// (MCP clients, Run on a PR); Autonomous until the person picks a level.
const LAST_TIER_KEY = 'specrails-desktop:agent-tier-last'
const DEFAULT_TIER: AgentTierLevel = 3

export function readLastTierLevel(): AgentTierLevel {
  try {
    const raw = localStorage.getItem(LAST_TIER_KEY)
    const n = raw === null ? DEFAULT_TIER : Number.parseInt(raw, 10)
    return (n === 0 || n === 1 || n === 2 || n === 3 ? n : DEFAULT_TIER) as AgentTierLevel
  } catch {
    return DEFAULT_TIER
  }
}

export function saveLastTierLevel(level: AgentTierLevel): void {
  try { localStorage.setItem(LAST_TIER_KEY, String(level)) } catch { /* ignore */ }
}
