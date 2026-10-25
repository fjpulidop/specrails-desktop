/**
 * Highlighting for ⌘K result rows (CD6). Rows never carry HTML: the server
 * sends plain text plus `[start, end)` ranges (the mission/job/spec snippet
 * shape), and client-side matches (files, settings, docs) are computed here
 * the same way. `highlightParts` turns text + ranges into runs the palette
 * renders as React text nodes and `<mark>` elements, so a title containing
 * `<script>` or `&lt;` is shown literally and can never be injected.
 */
export type HighlightRange = readonly [number, number]

export interface Snippet {
  text: string
  ranges: readonly HighlightRange[]
}

export interface HighlightPart {
  text: string
  mark: boolean
}

/** Keep only usable ranges: integers inside the text, non-empty, sorted and non-overlapping. */
export function sanitizeRanges(text: string, ranges: readonly HighlightRange[] | null | undefined): Array<[number, number]> {
  if (!Array.isArray(ranges)) return []
  const clean: Array<[number, number]> = []
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) continue
    const [a, b] = range as unknown as [unknown, unknown]
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue
    const start = Math.max(0, a as number)
    const end = Math.min(text.length, b as number)
    if (end > start) clean.push([start, end])
  }
  clean.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const merged: Array<[number, number]> = []
  for (const range of clean) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  return merged
}

export function highlightParts(text: string, ranges: readonly HighlightRange[] | null | undefined): HighlightPart[] {
  const parts: HighlightPart[] = []
  let cursor = 0
  for (const [start, end] of sanitizeRanges(text, ranges)) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), mark: false })
    parts.push({ text: text.slice(start, end), mark: true })
    cursor = end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), mark: false })
  return parts
}

/** Lowercase without diacritics, with a map from folded offsets back to `text`. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  let offset = 0
  for (const ch of text) {
    const piece = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    for (let i = 0; i < piece.length; i++) map.push(offset)
    folded += piece
    offset += ch.length
  }
  map.push(offset)
  return { folded, map }
}

/** The first case- and diacritics-insensitive occurrence of `query` in `text`, as a range. */
export function rangesForQuery(text: string, query: string): Array<[number, number]> {
  const needle = foldWithMap(query.trim()).folded
  if (!needle) return []
  const { folded, map } = foldWithMap(text)
  const at = folded.indexOf(needle)
  if (at < 0) return []
  return [[map[at], map[Math.min(at + needle.length, folded.length)]]]
}
