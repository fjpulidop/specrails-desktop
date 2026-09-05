import type { AgentConversation, MissionSearchHit, MissionSearchSnippet } from './agent-api'
import type { UiMode } from '../context/UiModeContext'
import { parseTimestampMs } from './relative-time'

// ─── Mission search model (search-missions-in-palette) ────────────────────────
//
// Pure helpers behind the ⌘K Missions group. Phase A (synchronous) matches
// titles from the conversations already in memory; phase B merges the server's
// full-text hits (title + content, with snippets) into the same rows. Nothing
// here fetches or renders — the palette owns the debounce and the DOM.

export type PaletteGroup = 'missions' | 'projects' | 'spec' | 'jobs' | 'navigation'

/** Missions shown with an empty query. */
export const RECENT_MISSIONS_MAX = 8
/** Keystroke → server request quiet period. */
export const MISSION_SEARCH_DEBOUNCE_MS = 80
/** Rows requested from the server per query. */
export const MISSION_SEARCH_LIMIT = 20

export type MissionMatchKind = 'title' | 'content' | 'recent'

export interface MissionSearchRow {
  conversation: AgentConversation
  match: MissionMatchKind
  /** Best matching message for content hits (server-provided); null otherwise. */
  messageId: string | null
  snippet: MissionSearchSnippet | null
}

/** Lowercase + strip combining diacritics — the same folding the server index
 *  applies, so a client title match and a server hit agree. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/**
 * Case- and diacritics-insensitive substring match used for the palette's own
 * groups now that cmdk's fuzzy filter is off (a content hit whose title lacks
 * the query must not be hidden by cmdk). An empty query matches everything.
 */
export function matchesPaletteQuery(query: string, value: string, keywords: readonly string[] = []): boolean {
  const q = foldText(query.trim())
  if (!q) return true
  if (foldText(value).includes(q)) return true
  return keywords.some((k) => k && foldText(k).includes(q))
}

function newestFirst(a: AgentConversation, b: AgentConversation): number {
  return parseTimestampMs(b.updated_at) - parseTimestampMs(a.updated_at)
}

/** The most recently updated missions, for the empty-query state. */
export function recentMissions(conversations: readonly AgentConversation[], max = RECENT_MISSIONS_MAX): MissionSearchRow[] {
  return [...conversations]
    .sort(newestFirst)
    .slice(0, Math.max(0, max))
    .map((conversation) => ({ conversation, match: 'recent', messageId: null, snippet: null }))
}

/**
 * Phase A: missions whose title (or the shared untitled fallback) contains the
 * query, newest first. Runs on every keystroke from memory.
 */
export function matchMissionTitles(
  conversations: readonly AgentConversation[],
  query: string,
  untitledLabel: string,
  max = MISSION_SEARCH_LIMIT,
): MissionSearchRow[] {
  const q = foldText(query.trim())
  if (!q) return []
  const fallback = foldText(untitledLabel)
  return [...conversations]
    .sort(newestFirst)
    .filter((c) => foldText(c.title?.trim() || '').includes(q) || (!c.title?.trim() && fallback.includes(q)))
    .slice(0, Math.max(0, max))
    .map((conversation) => ({ conversation, match: 'title', messageId: null, snippet: null }))
}

/**
 * Phase B: fold the server's hits into the title rows. One row per mission;
 * a server row for a mission already listed by title ENRICHES it (snippet,
 * message id) and keeps `match: 'title'`; server title hits the client did not
 * know (older than the in-memory window) come next; content hits last, in the
 * server's relevance order.
 */
export function mergeMissionResults(
  titleRows: readonly MissionSearchRow[],
  serverHits: readonly MissionSearchHit[],
  max = MISSION_SEARCH_LIMIT,
): MissionSearchRow[] {
  const byId = new Map<string, MissionSearchHit>()
  for (const hit of serverHits) if (!byId.has(hit.conversation.id)) byId.set(hit.conversation.id, hit)

  const out: MissionSearchRow[] = []
  const seen = new Set<string>()
  for (const row of titleRows) {
    const hit = byId.get(row.conversation.id)
    out.push(hit ? { conversation: hit.conversation, match: 'title', messageId: hit.messageId, snippet: hit.snippet } : row)
    seen.add(row.conversation.id)
  }
  for (const kind of ['title', 'content'] as const) {
    for (const hit of serverHits) {
      if (hit.match !== kind || seen.has(hit.conversation.id)) continue
      seen.add(hit.conversation.id)
      out.push({ conversation: hit.conversation, match: hit.match, messageId: hit.messageId, snippet: hit.snippet })
    }
  }
  return out.slice(0, Math.max(0, max))
}

/** Missions lead in Agent Mode; Projects keep the lead on the board. */
export function groupOrderForMode(uiMode: UiMode): PaletteGroup[] {
  return uiMode === 'agent'
    ? ['missions', 'projects', 'spec', 'jobs', 'navigation']
    : ['projects', 'missions', 'spec', 'jobs', 'navigation']
}
