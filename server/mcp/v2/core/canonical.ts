import { createHash } from 'crypto'

/** JSON with sorted object keys and no `undefined` members: equal values serialize equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? 'null'
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]))
  }
  return value
}

/** Short stable hash (16 hex chars) of a value's canonical JSON. */
export function shortHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16)
}
