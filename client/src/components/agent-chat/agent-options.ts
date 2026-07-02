// ─── Agent reply option chips: protocol parsing ────────────────────────────────
// The operator agent ends a reply with a fenced ```options code block containing
// a JSON array of choice labels when (and only when) it asks the user to pick
// between concrete choices (taught in server/agent-operator-prompt.ts). The
// VALIDATION stays strict (a JSON array of 2-8 short strings, nothing after it),
// but the fence SHAPE is parsed tolerantly: real models emit the fence glued to
// the prose ("…extra?```options"), put the array on the fence line itself, or
// drop the closing ``` entirely — all of those must still become chips instead
// of leaking raw protocol text into the bubble. Anything that doesn't validate
// is left untouched in the content.

const MIN_OPTIONS = 2
const MAX_OPTIONS = 8
const MAX_OPTION_LENGTH = 80

const OPTIONS_FENCE = '```options'

export interface ParsedAgentOptions {
  /** Message body with the options block stripped (unchanged when invalid). */
  body: string
  /** The parsed choice labels, or null when no valid trailing block exists. */
  options: string[] | null
}

/** Parse + validate one candidate tail; null when it is not a valid block. */
function parseOptionsTail(rawTail: string): string[] | null {
  // The JSON array may sit on the fence line itself or on following lines,
  // optionally closed by ``` and trailing whitespace.
  const tail = rawTail.replace(/^[^\S\n]*\n?/, '').replace(/\s*(?:```)?\s*$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(tail)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length < MIN_OPTIONS || parsed.length > MAX_OPTIONS) return null
  const options: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string') return null
    const label = item.trim()
    if (!label || label.length > MAX_OPTION_LENGTH) return null
    options.push(label)
  }
  return options
}

/** Extract a trailing ```options block from assistant content.
 *  Valid = JSON array of 2-8 non-empty strings, each ≤80 chars after trimming. */
export function extractAgentOptions(content: string): ParsedAgentOptions {
  // Scan fence occurrences FIRST-to-last and take the first one whose tail
  // validates: an occurrence of the literal ```options INSIDE a label of the
  // real (earlier) block must not shadow it. Occurrences preceded by another
  // backtick (a ````options long fence — e.g. the model quoting the protocol)
  // are never candidates.
  let idx = content.indexOf(OPTIONS_FENCE)
  while (idx !== -1) {
    if (idx === 0 || content[idx - 1] !== '`') {
      const options = parseOptionsTail(content.slice(idx + OPTIONS_FENCE.length))
      if (options) return { body: content.slice(0, idx).replace(/\s+$/, ''), options }
    }
    idx = content.indexOf(OPTIONS_FENCE, idx + 1)
  }
  return { body: content, options: null }
}
