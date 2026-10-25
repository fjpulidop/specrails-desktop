import { FEATURE_CODE_EXPLORER } from '../../lib/feature-flags'

/**
 * ⌘K scoped search (CD6). A leading prefix narrows the palette to one source:
 * `#` specs, `@` missions, `/` settings, `f:` files, `log:` job logs, `?` docs.
 * The prefix becomes a chip in the input; the input then holds only the query.
 * `>` (actions) keeps its own behaviour in palette-actions.
 */
export const SEARCH_SCOPES = ['specs', 'missions', 'settings', 'files', 'logs', 'docs'] as const
export type SearchScope = (typeof SEARCH_SCOPES)[number]

export const SCOPE_PREFIX: Record<SearchScope, string> = {
  specs: '#',
  missions: '@',
  settings: '/',
  files: 'f:',
  logs: 'log:',
  docs: '?',
}

/** Rows each scoped list shows at most. */
export const SCOPE_ROW_CAPS: Record<SearchScope, number> = {
  specs: 8,
  missions: 20,
  settings: 8,
  files: 10,
  logs: 8,
  docs: 8,
}
/** Settings rows added to an unscoped query, and only when the match is strong. */
export const UNSCOPED_SETTINGS_CAP = 3
/** Keystroke → request quiet period for the scopes that ask the server. */
export const SCOPE_SEARCH_DEBOUNCE_MS = 150
/** Shortest query the server-backed scopes (and the unscoped settings group) answer. */
export const SCOPE_MIN_CHARS = 1

/** Scopes that need an open project (their data lives in it). */
export function scopeNeedsProject(scope: SearchScope): boolean {
  return scope === 'specs' || scope === 'files' || scope === 'logs'
}

/** The scopes offered right now (the code explorer can be switched off). */
export function availableScopes(): SearchScope[] {
  return SEARCH_SCOPES.filter((scope) => scope !== 'files' || FEATURE_CODE_EXPLORER)
}

/**
 * A scope prefix at the start of what was typed (`#12`, `f:store`, `log: fail`,
 * `?budget`). Returns the scope and the rest of the query, or null when the text
 * does not start with one. Word prefixes are case-insensitive.
 */
export function detectScope(value: string): { scope: SearchScope; rest: string } | null {
  const text = value.trimStart()
  if (!text) return null
  for (const scope of SEARCH_SCOPES) {
    const prefix = SCOPE_PREFIX[scope]
    if (text.slice(0, prefix.length).toLowerCase() === prefix) {
      return { scope, rest: text.slice(prefix.length).replace(/^\s+/, '') }
    }
  }
  return null
}
