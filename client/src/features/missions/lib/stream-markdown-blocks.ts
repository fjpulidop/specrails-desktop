/**
 * Splits a growing (append-only) markdown stream into chunks that will never
 * change once emitted, plus the live tail.
 *
 * Why: the streaming bubble re-parses its whole text on every frame, so a long
 * answer costs O(n) per frame (O(n^2) over the turn). Stable chunks render once
 * (memoised on their text) and only the tail re-parses.
 *
 * A chunk ends only at a blank line that cannot change how the next block
 * reads: outside a fenced code block, and followed by a line that starts a new
 * paragraph/heading/fence at column 0 — never a list item, quote, table row,
 * indented continuation, thematic break, link definition or HTML. Boundaries
 * depend on the prefix alone, so earlier chunks keep their text as the stream
 * grows (that is what makes them memoisable). Settled messages are always
 * rendered whole by the regular path.
 */

/** Streams shorter than this render whole: splitting only pays on long answers. */
export const STREAM_SPLIT_MIN_CHARS = 2400
/** A chunk is closed at the first valid boundary after this many characters. */
const MIN_CHUNK_CHARS = 1200

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CONTINUES_PREVIOUS_BLOCK = /^(?:[-*+]\s|\d{1,9}[.)]\s|>|\||\s|[-*_]{3,}\s*$|\[[^\]]+\]:|<|:)/

export interface StreamChunks {
  stable: string[]
  tail: string
}

export function splitStreamedMarkdown(text: string): StreamChunks {
  if (text.length < STREAM_SPLIT_MIN_CHARS) return { stable: [], tail: text }
  const stable: string[] = []
  let chunkStart = 0
  let fence: string | null = null
  let offset = 0
  let blankBefore = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineStart = offset
    offset += line.length + 1
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (fence === null) fence = marker[0]
      else if (marker[0] === fence && line.trim().replace(/[`~]/g, '') === '') fence = null
      blankBefore = false
      continue
    }
    if (fence !== null) { blankBefore = false; continue }
    if (line.trim() === '') { blankBefore = true; continue }
    // `line` is the first non-blank line after a blank one: a candidate boundary
    // at its start, only when the previous line is complete (not the last, still
    // growing line) and the line opens a fresh block.
    if (blankBefore && lineStart - chunkStart >= MIN_CHUNK_CHARS && !CONTINUES_PREVIOUS_BLOCK.test(line) && i < lines.length - 1) {
      stable.push(text.slice(chunkStart, lineStart))
      chunkStart = lineStart
    }
    blankBefore = false
  }
  return { stable, tail: text.slice(chunkStart) }
}
