/**
 * Untrusted content marking. Spec bodies, logs, PR text, mission messages,
 * Jira text, file contents and model output reach the agent as data, never as
 * instructions. A v2 result lists where that text sits in `untrusted`: JSON
 * pointers into the envelope where `*` matches any array index or object key
 * (`/data/items/*\/body`). The server instructions tell agents to treat those
 * fields as data. Patterns stay valid when the size guard drops items.
 */

/** Validated pointer patterns (relative to the envelope root, so they start with `/data`, `/state`…). */
export function untrusted(...patterns: string[]): string[] {
  for (const pattern of patterns) {
    if (!pattern.startsWith('/')) throw new Error(`Untrusted pointer "${pattern}" must start with "/".`)
  }
  return [...new Set(patterns)]
}

/** True when a concrete pointer (`/data/items/3/body`) is covered by a pattern. */
export function matchesPointer(pattern: string, pointer: string): boolean {
  const want = pattern.split('/')
  const have = pointer.split('/')
  if (have.length < want.length) return false
  // A pattern also covers everything below the field it names.
  return want.every((segment, index) => segment === '*' || segment === have[index])
}

// Bidi overrides and C0/C1 controls except tab and newline: invisible text that can hide instructions.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g

/** Third-party text with invisible control and bidi-override characters removed. */
export function neutralize(text: string): string {
  return text.replace(HIDDEN, '')
}

/**
 * Third-party text with the same invisible characters made visible as `⟦U+XXXX⟧`
 * instead of removed: diffs and file contents, where a reviewer must see them
 * (trojan-source).
 */
export function reveal(text: string): string {
  return text.replace(HIDDEN, (ch) => `⟦U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`)
}

/** Third-party text for a short field: neutralized and cut to `max`; a non-string or empty value gives null. */
export function clipUntrusted(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || !value) return null
  const clean = neutralize(value)
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean
}
