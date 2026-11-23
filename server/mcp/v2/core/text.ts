/**
 * Small value helpers every v2 tool needs (one copy instead of one per tool).
 * Pure; no domain knowledge.
 */

export type Row = Record<string, unknown>

/** Set: not undefined, not null and not a blank string. */
export function present(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())
}

/** A plain object, or `{}` for anything else (arrays and null included). */
export function asRecord(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
}

/** Text cut to `max` characters with an ellipsis. Non-strings give null. */
export function clip(text: string, max: number): string
export function clip(text: string | null | undefined, max: number): string | null
export function clip(text: string | null | undefined, max: number): string | null {
  if (typeof text !== 'string') return null
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

/** Bounded copy of untrusted structured content: long strings and long arrays cut, nulls dropped. */
export function clipDeep(value: unknown, maxString = 600, maxItems = 20, depth = 0): unknown {
  if (typeof value === 'string') return clip(value, maxString)
  if (Array.isArray(value)) return value.slice(0, maxItems).map((item) => clipDeep(item, maxString, maxItems, depth + 1))
  if (value && typeof value === 'object' && depth < 6) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, clipDeep(v, maxString, maxItems, depth + 1)]))
  }
  return value
}
