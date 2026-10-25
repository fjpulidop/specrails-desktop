// Shared helpers for FTS5 trigram search with highlighted snippets (missions,
// job logs, specs). The index returns text with MARK_START/MARK_END control
// characters around matches (`highlight()`); the helpers cut a window around
// the first match and turn it into plain text + ranges. Rendering marks from
// ranges (never raw HTML) is the client's job.

/** A highlighted excerpt: plain text plus `[start, end)` ranges to mark. */
export interface SearchSnippet {
  text: string
  ranges: Array<[number, number]>
}

/** The trigram tokenizer matches nothing below three characters; shorter
 *  queries take the bounded substring scan instead. */
export const TRIGRAM_MIN_CHARS = 3
/** Rows the substring fallback inspects at most (newest first). */
export const FALLBACK_SCAN_ROWS = 400
/** Characters kept on each side of the first match in a snippet window. */
export const FALLBACK_CONTEXT = 60
export const MARK_START = '\u0001'
export const MARK_END = '\u0002'

/** Lowercase + strip combining diacritics, mirroring the index tokenizer so a
 *  title compare and a content compare agree on what "matches". */
export function foldSearchText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/** Quote a raw user query as one FTS5 phrase so operators/punctuation in it
 *  never become syntax; a trigram phrase is a plain substring match. */
export function ftsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`
}

/**
 * Cut a marked full-content string (`highlight()` output, or the substring
 * fallback's own marking) down to a window of ~${FALLBACK_CONTEXT} characters on
 * each side of the FIRST match, with ellipses where text was dropped and
 * whitespace collapsed. Markers outside the window are simply cut away;
 * `parseMarkedSnippet` tolerates a dangling one.
 */
export function windowMarked(marked: string): string {
  const at = marked.indexOf(MARK_START)
  if (at < 0) return marked.slice(0, FALLBACK_CONTEXT * 2).replace(/\s+/g, ' ')
  const close = marked.indexOf(MARK_END, at)
  const matchEnd = close < 0 ? marked.length : close + 1
  const start = Math.max(0, at - FALLBACK_CONTEXT)
  const end = Math.min(marked.length, matchEnd + FALLBACK_CONTEXT)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < marked.length ? '…' : ''
  return prefix + marked.slice(start, end).replace(/\s+/g, ' ') + suffix
}

/** Turn a marked window into plain text + `[start, end)` highlight ranges. */
export function parseMarkedSnippet(marked: string): SearchSnippet {
  let text = ''
  const ranges: Array<[number, number]> = []
  let open = -1
  for (const ch of marked) {
    if (ch === MARK_START) {
      open = text.length
    } else if (ch === MARK_END) {
      if (open >= 0 && text.length > open) ranges.push([open, text.length])
      open = -1
    } else {
      text += ch
    }
  }
  return { text, ranges }
}

