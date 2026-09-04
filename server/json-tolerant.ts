// ─── Tolerant JSON parsing for model-emitted payloads ─────────────────────────
//
// A model writing a ~20 KB JSON snapshot by hand makes small, predictable
// mistakes: a raw newline inside a string, an unescaped inner quote, a
// trailing comma, a nested ```json fence, a stray comment. `JSON.parse`
// rejects all of them and the whole snapshot used to be dropped silently.
//
// `parseJsonTolerant` first tries strict `JSON.parse`; only when that fails
// does it run ONE deterministic repair pass (a small string-aware state
// machine — never a regex over the whole text, so repairs inside string
// literals can't corrupt structure) and parses again. The result says whether
// a repair was needed and which kinds were applied, so callers can log/badge
// it. It never throws.
//
// Client mirror: client/src/lib/json-tolerant.ts — keep the two in sync.

export type JsonRepairKind =
  | 'nested_fence'
  | 'trimmed_wrapper'
  | 'raw_newline'
  | 'raw_control'
  | 'inner_quote'
  | 'invalid_escape'
  | 'dangling_escape'
  | 'trailing_comma'
  | 'comment'

export type TolerantParseResult =
  | { ok: true; value: unknown; repaired: boolean; repairs: JsonRepairKind[] }
  | { ok: false; error: string; position: number | null; excerpt: string | null }

const VALID_ESCAPES = '"\\/bfnrtu'

function isJsonWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n'
}

/** One string-aware pass over `source` fixing the common model mistakes. */
export function repairJsonText(source: string): { text: string; repairs: JsonRepairKind[] } {
  const repairs = new Set<JsonRepairKind>()
  let text = source.trim()

  // A nested code fence around the payload (```json … ``` inside the
  // blueprint-draft block). Leading and trailing fences are stripped
  // independently: the outer lazy fence regex may already have eaten one.
  const leadingFence = /^```[A-Za-z0-9_-]*[ \t]*\r?\n/.exec(text)
  if (leadingFence) {
    text = text.slice(leadingFence[0].length)
    repairs.add('nested_fence')
  }
  const trailingFence = /\r?\n[ \t]*```[ \t]*$/.exec(text)
  if (trailingFence) {
    text = text.slice(0, trailingFence.index)
    repairs.add('nested_fence')
  }

  // Prose before/after the object ("Here is the snapshot: {...} Done.").
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first && (first > 0 || last < text.length - 1)) {
    text = text.slice(first, last + 1)
    repairs.add('trimmed_wrapper')
  }

  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') {
        const next = text[i + 1]
        if (next === undefined) {
          repairs.add('dangling_escape')
          break
        }
        if (VALID_ESCAPES.includes(next)) {
          out += ch + next
          i += 1
          continue
        }
        // `\'` and friends are not JSON escapes — keep the character, drop the
        // backslash (a raw newline after a backslash becomes a real escape).
        out += next === '\n' ? '\\n' : next
        i += 1
        repairs.add('invalid_escape')
        continue
      }
      if (ch === '"') {
        // Terminator, or a stray inner quote? A real terminator is followed
        // (after whitespace) by a structural character or the end of input.
        let j = i + 1
        while (j < text.length && isJsonWhitespace(text[j])) j += 1
        const after = text[j]
        if (after === undefined || after === ',' || after === '}' || after === ']' || after === ':') {
          inString = false
          out += ch
          continue
        }
        out += '\\"'
        repairs.add('inner_quote')
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        repairs.add('raw_newline')
        continue
      }
      if (ch === '\r') {
        repairs.add('raw_newline')
        continue
      }
      if (ch === '\t') {
        out += '\\t'
        repairs.add('raw_control')
        continue
      }
      const code = ch.charCodeAt(0)
      if (code < 0x20) {
        out += '\\u' + code.toString(16).padStart(4, '0')
        repairs.add('raw_control')
        continue
      }
      out += ch
      continue
    }

    // Outside a string literal.
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && isJsonWhitespace(text[j])) j += 1
      if (text[j] === '}' || text[j] === ']') {
        repairs.add('trailing_comma')
        continue
      }
      out += ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
      repairs.add('comment')
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      repairs.add('comment')
      continue
    }
    out += ch
  }

  return { text: out, repairs: [...repairs] }
}

function describeParseError(err: unknown, text: string): { error: string; position: number | null; excerpt: string | null } {
  const message = err instanceof Error ? err.message : String(err)
  const match = /position (\d+)/i.exec(message)
  const position = match ? Number(match[1]) : null
  let excerpt: string | null = null
  if (position !== null && Number.isFinite(position)) {
    const start = Math.max(0, position - 40)
    const end = Math.min(text.length, position + 40)
    excerpt = text.slice(start, end).replace(/\s+/g, ' ')
  }
  return { error: message, position, excerpt }
}

/**
 * Strict `JSON.parse` first; on failure ONE repair pass, then parse again.
 * `repaired` is true only when the strict parse failed AND the repaired text
 * parsed. Never throws.
 */
export function parseJsonTolerant(source: string): TolerantParseResult {
  try {
    return { ok: true, value: JSON.parse(source), repaired: false, repairs: [] }
  } catch (strictErr) {
    const { text, repairs } = repairJsonText(source)
    try {
      const value = JSON.parse(text)
      return { ok: true, value, repaired: true, repairs }
    } catch {
      return { ok: false, ...describeParseError(strictErr, source) }
    }
  }
}
