// ─── Live spec-draft fence stripper ──────────────────────────────────────────

export interface StreamFilterState {
  /** True when we are currently inside a ```spec-draft fenced block. */
  inBlock: boolean
  /**
   * Last few characters of the incoming stream not yet emitted because they
   * could be the prefix of an unfinished fence marker (open or close).
   * Inside a block, holds only a possible split closing fence; content is dropped.
   */
  pendingTail: string
}

const FENCE_OPEN = '```spec-draft'
const FENCE_CLOSE = '```'

/**
 * I/O-free filter that advances caller-owned state and returns the
 * substring that is safe to broadcast to the chat stream. Holds back partial
 * fence markers in `state.pendingTail` so the next call can resolve them.
 *
 * Behaviour:
 *  - While outside a block: emit text up to (but not including) the start of
 *    a `\`\`\`spec-draft` marker. If no marker is present, hold back the
 *    trailing few chars so a marker starting on a chunk boundary is not
 *    leaked.
 *  - While inside a block: emit nothing. Look for the closing `\`\`\``.
 *    When found, consume it (plus an optional trailing newline) and resume
 *    emitting from the bytes that follow.
 *
 * The filter intentionally does NOT validate the JSON payload — that is
 * server-side concern of `parseSpecDraftBlocks`. It only strips the fenced
 * span.
 */
export function filterDraftBlocksLive(state: StreamFilterState, newText: string): string {
  let buf = state.pendingTail + newText
  let out = ''
  state.pendingTail = ''

  // Iterate in case a single delta contains multiple transitions
  // (e.g. close + open + close again — pathological but cheap to support).
  while (buf.length > 0) {
    if (state.inBlock) {
      const closeIdx = buf.indexOf(FENCE_CLOSE)
      if (closeIdx === -1) {
        // No close yet — but the close could span the chunk boundary.
        // Hold back up to 2 trailing chars (closing fence is 3 chars; we keep
        // any trailing run of `\`` so the next call resolves it).
        const tailLen = trailingBacktickRun(buf, 2)
        state.pendingTail = buf.slice(buf.length - tailLen)
        return out
      }
      // Consume the close fence + an optional trailing newline.
      let after = closeIdx + FENCE_CLOSE.length
      if (buf[after] === '\n') after += 1
      buf = buf.slice(after)
      state.inBlock = false
      continue
    }

    // Not in block: look for the open marker.
    const openIdx = buf.indexOf(FENCE_OPEN)
    if (openIdx !== -1) {
      out += buf.slice(0, openIdx)
      buf = buf.slice(openIdx + FENCE_OPEN.length)
      // Drop an optional newline immediately after the open marker so the
      // user never sees `\n` belonging to the fence.
      if (buf[0] === '\n') buf = buf.slice(1)
      state.inBlock = true
      continue
    }

    // No open marker — hold back only the trailing run that could become a
    // prefix of FENCE_OPEN (i.e. the longest suffix of `buf` that is also a
    // prefix of FENCE_OPEN). Anything past that is safe to emit.
    const holdBack = longestSuffixThatIsPrefixOf(buf, FENCE_OPEN)
    const safeEnd = buf.length - holdBack
    out += buf.slice(0, safeEnd)
    state.pendingTail = buf.slice(safeEnd)
    return out
  }

  return out
}

/** Length of the longest suffix of `s` that is a prefix of `target`. */
function longestSuffixThatIsPrefixOf(s: string, target: string): number {
  const max = Math.min(s.length, target.length - 1)
  for (let len = max; len > 0; len--) {
    if (target.startsWith(s.slice(s.length - len))) return len
  }
  return 0
}

function trailingBacktickRun(s: string, max: number): number {
  let n = 0
  for (let i = s.length - 1; i >= 0 && n < max; i--) {
    if (s[i] === '`') n++
    else break
  }
  return n
}
