/**
 * Ticket non-goals ("Out of scope", feedback-2026-10 task 3.2).
 *
 * Pure rules for the optional top-level ticket field `nonGoals: string[]`:
 * validation and bounds, extraction of a generated spec's `## Out of Scope`
 * section into the field, and the rendering every launch door appends to the
 * description so agents keep seeing the non-goals once they live in their own
 * field. Zero imports (the architecture test pins domain files to none).
 *
 * The field is Desktop-owned and additive: the ticket store stays at schema
 * 1.5 because Core ignores unknown ticket fields. The Contract Layer is not
 * involved: it reads and appends to `description` exactly as before.
 */

export const NON_GOALS_MAX_ITEMS = 20
export const NON_GOAL_MAX_CHARS = 300

/** Matches the `## Out of Scope` heading (also `Non-Goals` / `Out-of-scope`). */
const SECTION_HEADING = /^##\s*(?:out[\s-]+of[\s-]+scope|non[\s-]?goals)\s*$/i

/** One non-goal line without list markers, trimmed; null when empty. */
function cleanItem(raw: string): string | null {
  const text = raw.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, NON_GOAL_MAX_CHARS) : null
}

export type NonGoalsValidation =
  | { ok: true; nonGoals: string[] }
  | { ok: false; error: string }

/**
 * Validate a caller-supplied `nonGoals` value (HTTP, MCP). `null` clears the
 * field (an empty list); strings are cleaned of list markers, blanks dropped,
 * duplicates collapsed, each item and the list capped.
 */
export function validateNonGoals(value: unknown): NonGoalsValidation {
  if (value === null) return { ok: true, nonGoals: [] }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return { ok: false, error: 'nonGoals must be an array of strings' }
  }
  return { ok: true, nonGoals: normalizeNonGoals(value) }
}

/** Tolerant normalization used on read: never throws, never invents. */
export function normalizeNonGoals(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const cleaned = cleanItem(item)
    if (cleaned && !out.includes(cleaned)) out.push(cleaned)
    if (out.length >= NON_GOALS_MAX_ITEMS) break
  }
  return out
}

/** Split free text (the modal's textarea) into non-goals, one per line. */
export function parseNonGoalsText(text: string): string[] {
  return normalizeNonGoals(text.replace(/\r\n?/g, '\n').split('\n'))
}

/**
 * Pull the `## Out of Scope` section out of a markdown spec body. Returns the
 * description without that section and its bullet lines as non-goals. A body
 * without the section is returned unchanged with no non-goals. Only the first
 * section is moved; the section ends at the next `#`/`##` heading.
 */
export function extractOutOfScopeSection(markdown: string): { description: string; nonGoals: string[] } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((line) => SECTION_HEADING.test(line.trim()))
  if (start < 0) return { description: markdown, nonGoals: [] }
  let end = start + 1
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++
  const nonGoals = normalizeNonGoals(lines.slice(start + 1, end).filter((line) => line.trim().length > 0))
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { description: rest, nonGoals }
}

/** The `## Out of Scope` block rendered from non-goals ('' when none). */
export function renderNonGoalsSection(nonGoals: readonly string[] | undefined | null): string {
  const items = normalizeNonGoals(nonGoals ?? [])
  return items.length ? `## Out of Scope\n${items.map((item) => `- ${item}`).join('\n')}` : ''
}

/**
 * The description an agent receives: the stored description plus the
 * non-goals as an `## Out of Scope` section, unless the description already
 * carries one (older specs, hand-written sections) — never duplicated.
 */
export function descriptionWithNonGoals(description: string | null | undefined, nonGoals: readonly string[] | undefined | null): string {
  const body = description ?? ''
  const section = renderNonGoalsSection(nonGoals)
  if (!section) return body
  if (body.split('\n').some((line) => SECTION_HEADING.test(line.trim()))) return body
  return body.trim() ? `${body.trimEnd()}\n\n${section}` : section
}
