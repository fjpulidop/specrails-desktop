import type { V2Success } from './envelope'
import { encodeCursor } from './cursor'
import type { View } from './views'

/**
 * Response size guard. Every v2 success passes through `guardSize` before it
 * is serialized: above the cap it drops trailing array items (never part of an
 * object), largest array first, and sets `page.truncated` with a cursor that
 * resumes at the first dropped item. Long strings are shortened only when the
 * arrays alone cannot get under the cap; as a last resort `data` is replaced by
 * an `omitted` marker. The summary, refs and state always survive.
 */

/** Token caps (o200k, estimated by `approxTokens`). Targets are what tools aim for; the guard enforces the caps. */
export const RESPONSE_BUDGET = {
  summaryCap: 1500,
  detailTarget: 6000,
  detailCap: 10000,
  logsPage: 4000,
  waitWake: 800,
  writeAccept: 600,
} as const

export function viewCap(view: View): number {
  return view === 'detail' ? RESPONSE_BUDGET.detailCap : RESPONSE_BUDGET.summaryCap
}

/**
 * Conservative o200k estimate for JSON text (≈2.9 bytes per token). The
 * catalog budget test calibrates it against the real tokenizer: it must never
 * undercount by more than 10%.
 */
export function approxTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 2.9)
}

export interface GuardOptions {
  capTokens: number
  /** Offset of the first item of the paged array in the full list (absolute cursors; `result(..., { pageBase })`). */
  baseOffset?: number
  /** Pointer of the paged array `baseOffset` applies to (default `/items`); another cut array resumes at 0. */
  basePath?: string
  /** Query key stamped on the cursor (see cursor.ts). */
  cursorKey?: string
}

interface ArrayAt { pointer: string; parent: unknown; key: string | number; value: unknown[]; bytes: number }

const MAX_DEPTH = 6
const tokensOf = (value: unknown) => approxTokens(JSON.stringify(value))
const escapePointer = (key: string | number) => String(key).replace(/~/g, '~0').replace(/\//g, '~1')

function collectArrays(value: unknown, pointer: string, parent: unknown, key: string | number, depth: number, out: ArrayAt[]): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    if (value.length > 0) out.push({ pointer, parent, key, value, bytes: JSON.stringify(value).length })
    value.forEach((item, index) => collectArrays(item, `${pointer}/${index}`, value, index, depth + 1, out))
    return
  }
  for (const [childKey, child] of Object.entries(value)) collectArrays(child, `${pointer}/${escapePointer(childKey)}`, value, childKey, depth + 1, out)
}

function setChild(parent: unknown, key: string | number, value: unknown): void {
  ;(parent as Record<string | number, unknown>)[key] = value
}

function shortenStrings(value: unknown, max: number): number {
  let changed = 0
  const visit = (node: unknown, parent: unknown, key: string | number | null, depth: number) => {
    if (typeof node === 'string' && node.length > max && parent !== null && key !== null) {
      setChild(parent, key, `${node.slice(0, max)}… [${node.length - max} chars cut]`)
      changed++
      return
    }
    if (depth > MAX_DEPTH + 2 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) node.forEach((item, index) => visit(item, node, index, depth + 1))
    else for (const [childKey, child] of Object.entries(node)) visit(child, node, childKey, depth + 1)
  }
  visit(value, null, null, 0)
  return changed
}

/** The envelope, cut to fit `capTokens`. Returns the input unchanged when it already fits. */
export function guardSize(envelope: V2Success, options: GuardOptions): V2Success {
  if (tokensOf(envelope) <= options.capTokens) return envelope
  // The page cursor and warnings are added after the cut; retry with their room reserved.
  let budget = options.capTokens
  let out = cut(envelope, { ...options, capTokens: budget })
  for (let attempt = 0; attempt < 3 && tokensOf(out) > options.capTokens; attempt++) {
    budget -= tokensOf(out) - options.capTokens + 8
    out = cut(envelope, { ...options, capTokens: Math.max(1, budget) })
  }
  return out
}

function cut(envelope: V2Success, options: GuardOptions): V2Success {
  const out: V2Success = structuredClone(envelope)
  const holder = { data: out.data }
  const fits = () => tokensOf({ ...out, data: holder.data }) <= options.capTokens
  const warnings: string[] = []
  let primary: { pointer: string; kept: number } | null = null

  const arrays: ArrayAt[] = []
  collectArrays(holder.data, '', holder, 'data', 0, arrays)
  // Largest first; a nested array whose ancestor was already cut is skipped below.
  arrays.sort((a, b) => b.bytes - a.bytes)
  const cut = new Set<string>()
  for (const entry of arrays) {
    if (fits()) break
    if ([...cut].some((pointer) => entry.pointer.startsWith(`${pointer}/`))) continue
    const full = entry.value
    let lo = 0
    let hi = full.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      setChild(entry.parent, entry.key, full.slice(0, mid))
      if (fits()) { best = mid; lo = mid + 1 } else hi = mid - 1
    }
    const kept = Math.max(best, 0)
    setChild(entry.parent, entry.key, full.slice(0, kept))
    cut.add(entry.pointer)
    if (!primary) primary = { pointer: entry.pointer || '/', kept }
    else warnings.push(`truncated ${entry.pointer || '/'}: kept ${kept} of ${full.length}`)
  }
  for (const max of [2000, 500]) {
    if (fits()) break
    if (shortenStrings(holder, max)) warnings.push(`long text shortened to ${max} characters`)
  }
  if (!fits()) {
    holder.data = { omitted: true, reason: 'response_too_large' }
    warnings.push('data omitted: the response exceeded the size cap; ask for a narrower view, fields or a smaller limit')
  }
  out.data = holder.data
  if (primary) {
    out.page = {
      ...(out.page ?? {}),
      cursor: encodeCursor({ offset: (primary.pointer === (options.basePath ?? '/items') ? options.baseOffset ?? 0 : 0) + primary.kept, path: primary.pointer, ...(options.cursorKey ? { key: options.cursorKey } : {}) }),
      truncated: true,
    }
  } else if (out.page) out.page = { ...out.page, truncated: true }
  if (warnings.length) out.warnings = [...new Set([...(out.warnings ?? []), ...warnings])]
  return out
}
