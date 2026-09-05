// Provider usage/rate limits as a FIRST-CLASS loop signal.
//
// Run 52124009 (2026-09-04): the claude subscription hit its session limit
// mid-batch. The CLI answered every later spawn in ~0.5 s with a `result`
// frame whose text was "You've hit your session limit · resets 3am
// (Europe/Madrid)" and `is_error: true`. The engine saw a non-empty, exit-0
// reply → step `ok` → verify → decider (unparseable → continue) → fix … three
// full cycles until the no-progress stall guard finally stopped the run. A
// limit is not something to iterate on: detect it on the step's FINAL text,
// stop the loop at once with an honest reason, and tell the user when it
// resets.

export type ProviderLimitKind = 'session_limit' | 'rate_limit' | 'quota'

export interface ProviderLimit {
  kind: ProviderLimitKind
  /** The provider's own sentence, trimmed (surfaced verbatim, never rephrased). */
  message: string
  /** "3am (Europe/Madrid)", "in 2 hours" … when the message says so; else null. */
  resetsAt: string | null
}

/** Only the tail of a transcript is judged — a spec discussing rate limiting
 *  must never trip the classifier; the provider's own notice is always last. */
const TAIL_CHARS = 600

const PATTERNS: Array<{ kind: ProviderLimitKind; re: RegExp }> = [
  // claude: "You've hit your session limit · resets 3am (Europe/Madrid)"
  //         "You've hit your usage limit …", "…weekly limit…"
  { kind: 'session_limit', re: /\byou(?:'|’)?ve hit your (?:session|usage|weekly|daily|monthly|plan)?\s*limit\b/i },
  // claude API error wrapper: "(error type rate_limit, HTTP 429 …)"
  { kind: 'rate_limit', re: /\berror type rate_limit\b/i },
  { kind: 'rate_limit', re: /\bHTTP 429\b|\b429 Too Many Requests\b|\brate[ _-]?limit(?:ed|s)? (?:exceeded|reached|hit)\b|\brate_limit_error\b/i },
  // codex / openai
  { kind: 'quota', re: /\binsufficient_quota\b|\byou(?:'|’)?ve reached your (?:usage )?limit\b|\busage limit (?:reached|exceeded)\b/i },
  // gemini / google
  { kind: 'quota', re: /\bRESOURCE_EXHAUSTED\b|\bquota (?:exceeded|exhausted)\b/i },
]

// "resets 3am (Europe/Madrid)", "resets at 14:00", "resets in 2 hours".
const RESETS_RE = /\bresets?\s+(?:at\s+|in\s+)?([^\n·(]*?\d[^\n·(]*?)(\s*\([^)]*\))?(?=\s*(?:\(error|[.,;]\s|\n|$))/i

export function extractLimitReset(text: string): string | null {
  const m = RESETS_RE.exec(text)
  if (!m) return null
  const value = `${m[1].trim()}${m[2] ? ` ${m[2].trim()}` : ''}`.trim().replace(/[.,;:]+$/, '')
  return value.length > 0 && value.length <= 80 ? value : null
}

/** Classify a step's FINAL text / error text. Null when no provider limit
 *  notice is present. Never throws. */
export function classifyProviderLimit(text: string | null | undefined): ProviderLimit | null {
  if (!text) return null
  const tail = text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(tail)
    if (!m) continue
    // The provider's sentence: the line carrying the match, trimmed.
    const lineStart = tail.lastIndexOf('\n', m.index) + 1
    const lineEndIdx = tail.indexOf('\n', m.index)
    const line = tail.slice(lineStart, lineEndIdx === -1 ? undefined : lineEndIdx).trim()
    return { kind, message: line.slice(0, 300), resetsAt: extractLimitReset(tail) }
  }
  return null
}

/** Human line for logs/toasts: "<message> — resets 3am (Europe/Madrid)". */
export function describeProviderLimit(limit: ProviderLimit): string {
  return limit.resetsAt && !limit.message.toLowerCase().includes('reset')
    ? `${limit.message} — resets ${limit.resetsAt}`
    : limit.message
}
