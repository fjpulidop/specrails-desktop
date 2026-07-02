// ─── Agent reply option chips: protocol parsing ────────────────────────────────
// The operator agent ends a reply with a fenced ```options code block containing
// a JSON array of choice labels when (and only when) it asks the user to pick
// between concrete choices (taught in server/agent-operator-prompt.ts). This
// module extracts that trailing block STRICTLY — anything malformed is left in
// the content so it renders as a normal code block instead of chips.

const MIN_OPTIONS = 2
const MAX_OPTIONS = 8
const MAX_OPTION_LENGTH = 80

// A ```options fence starting at a line boundary, closing at the END of the
// message (trailing whitespace tolerated). Nothing but whitespace may follow.
const TRAILING_OPTIONS_BLOCK = /(?:^|\n)```options[^\S\n]*\n([\s\S]*?)\n?```\s*$/

export interface ParsedAgentOptions {
  /** Message body with the options block stripped (unchanged when invalid). */
  body: string
  /** The parsed choice labels, or null when no valid trailing block exists. */
  options: string[] | null
}

/** Extract a trailing ```options block from assistant content.
 *  Valid = JSON array of 2-8 non-empty strings, each ≤80 chars after trimming. */
export function extractAgentOptions(content: string): ParsedAgentOptions {
  const match = TRAILING_OPTIONS_BLOCK.exec(content)
  if (!match) return { body: content, options: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return { body: content, options: null }
  }
  if (!Array.isArray(parsed) || parsed.length < MIN_OPTIONS || parsed.length > MAX_OPTIONS) {
    return { body: content, options: null }
  }

  const options: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string') return { body: content, options: null }
    const label = item.trim()
    if (!label || label.length > MAX_OPTION_LENGTH) return { body: content, options: null }
    options.push(label)
  }

  return { body: content.slice(0, match.index).replace(/\s+$/, ''), options }
}
