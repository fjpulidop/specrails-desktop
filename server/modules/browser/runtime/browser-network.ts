// Pure, side-effect-free helpers for the browser-capture network feature.
//
// The Playwright/CDP wiring lives in `browser-playwright.ts` (excluded from
// coverage — needs a live Chromium). Everything testable — the request ring
// buffer and the response-shape sketcher — lives HERE so it is fully unit-tested.
//
// Privacy invariant: we NEVER store a raw request/response body. Only a
// structural shape (key names) is derived via `sketchJsonShape`, so a capture of
// an arbitrary website cannot leak tokens / PII into a spec ticket.

import type { CapturedNetworkRequest } from './browser-capture-types'

/** Static-asset resource types we never record — only XHR/Fetch/Document/etc. */
export const NETWORK_DENY_TYPES = new Set(['Image', 'Stylesheet', 'Font', 'Media', 'Manifest'])

const URL_CAP = 2000
const RESPONSE_BODY_CAP = 200_000
const SHAPE_CAP = 400

/**
 * Strip the query string (and any embedded credentials / fragment) from a URL
 * before it is persisted into a captured-network entry. Mirrors the body-sketch
 * privacy invariant: the SHAPE (origin + path) is kept for spec usefulness, but
 * the values — bearer tokens, API keys, signed-URL signatures, OAuth `code`/
 * `state`, session ids — are dropped. A `?` marker is appended when a query was
 * present so the AI still knows the request was parameterised. Non-parseable or
 * non-http(s) URLs degrade to a truncated raw copy with the query lexically
 * chopped, so we never persist a raw query even on a parse failure.
 */
export function redactUrlQuery(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  try {
    const u = new URL(raw)
    const hadQuery = u.search.length > 0
    // Drop credentials, query, and fragment — keep origin + path only.
    u.username = ''
    u.password = ''
    u.search = ''
    u.hash = ''
    return hadQuery ? `${u.toString()}?…` : u.toString()
  } catch {
    // Relative or malformed URL: lexically chop at the first '?' / '#'.
    const cut = raw.search(/[?#]/)
    const base = cut >= 0 ? raw.slice(0, cut) : raw
    return cut >= 0 ? `${base}?…` : base
  }
}

/** True when an entry should be dropped (static asset or non-network URL scheme). */
export function shouldSkipNetworkEntry(resourceType: string, url: string): boolean {
  if (NETWORK_DENY_TYPES.has(resourceType)) return true
  if (/^(data|blob):/i.test(url)) return true
  return false
}

/**
 * Derive a compact structural sketch of a JSON payload — key names and leaf
 * TYPES only, never values. Returns null for non-JSON or oversized input.
 *   '{"id":1,"tags":["a"]}'        → '{ id: number, tags: [string] }'
 *   '[{"id":1,"name":"x"}]'        → '[{ id: number, name: string }]'
 */
export function sketchJsonShape(
  bodyText: string,
  opts: { maxKeys?: number; maxDepth?: number } = {},
): string | null {
  if (typeof bodyText !== 'string' || bodyText.length === 0 || bodyText.length > RESPONSE_BODY_CAP) return null
  const maxKeys = opts.maxKeys ?? 24
  const maxDepth = opts.maxDepth ?? 3
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return null
  }
  const describe = (v: unknown, depth: number): string => {
    if (v === null) return 'null'
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]'
      return `[${describe(v[0], depth)}${v.length > 1 ? ', …' : ''}]`
    }
    const t = typeof v
    if (t === 'object') {
      if (depth >= maxDepth) return 'object'
      const obj = v as Record<string, unknown>
      const keys = Object.keys(obj)
      const shown = keys.slice(0, maxKeys)
      const inner = shown.map((k) => `${k}: ${describe(obj[k], depth + 1)}`).join(', ')
      const more = keys.length > maxKeys ? ', …' : ''
      return `{ ${inner}${more} }`
    }
    return t // 'string' | 'number' | 'boolean' | 'function' | 'undefined'
  }
  const sketch = describe(parsed, 0)
  return sketch.length > SHAPE_CAP ? sketch.slice(0, SHAPE_CAP) + '…' : sketch
}

interface StartInfo {
  method: string
  url: string
  resourceType: string
  startedAt: number
  requestBodyShape?: string | null
}

/**
 * Bounded, insertion-ordered buffer of in-flight + completed network requests,
 * keyed by CDP requestId. Oldest entries are evicted past `cap`. Static assets
 * and data:/blob: URLs are dropped at insertion.
 */
export class NetworkRingBuffer {
  private readonly cap: number
  private readonly map = new Map<string, CapturedNetworkRequest>()

  constructor(cap = 150) {
    this.cap = Math.max(1, cap)
  }

  start(requestId: string, info: StartInfo): void {
    if (shouldSkipNetworkEntry(info.resourceType, info.url)) return
    if (!this.map.has(requestId)) {
      while (this.map.size >= this.cap) {
        const oldest = this.map.keys().next().value
        if (oldest === undefined) break
        this.map.delete(oldest)
      }
    }
    this.map.set(requestId, {
      method: info.method,
      // Redact the query string before storing — never persist tokens/PII into
      // the spec attachment / LLM prompt (BUG-BROWSER-03). Mirrors the body-sketch
      // policy: keep the structural origin+path, drop the values.
      url: redactUrlQuery(info.url).slice(0, URL_CAP),
      status: null,
      resourceType: info.resourceType,
      mimeType: null,
      requestBodyShape: info.requestBodyShape ?? null,
      responseShape: null,
      durationMs: null,
      startedAt: info.startedAt,
    })
  }

  response(requestId: string, info: { status: number; mimeType: string | null }): void {
    const e = this.map.get(requestId)
    if (!e) return
    e.status = info.status
    e.mimeType = info.mimeType
  }

  finish(requestId: string, info: { finishedAt: number }): void {
    const e = this.map.get(requestId)
    if (!e) return
    e.durationMs = Math.max(0, Math.round(info.finishedAt - e.startedAt))
  }

  fail(requestId: string, info: { finishedAt: number; errorText?: string }): void {
    const e = this.map.get(requestId)
    if (!e) return
    e.failed = true
    e.errorText = info.errorText
    e.durationMs = Math.max(0, Math.round(info.finishedAt - e.startedAt))
  }

  setResponseShape(requestId: string, shape: string | null): void {
    const e = this.map.get(requestId)
    if (!e || !shape) return
    e.responseShape = shape
  }

  /** True when the entry is a JSON response still missing a body sketch — used to
   *  avoid fetching response bodies for non-JSON resources. */
  wantsBodySketch(requestId: string): boolean {
    const e = this.map.get(requestId)
    return !!e && !e.responseShape && !!e.mimeType && e.mimeType.includes('json')
  }

  /** Entries that started at/after `sinceMs`, newest-first, capped at `cap`. */
  recent(sinceMs: number, cap = 40): CapturedNetworkRequest[] {
    return [...this.map.values()]
      .filter((e) => e.startedAt >= sinceMs)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, cap)
      .map((e) => ({ ...e }))
  }

  get size(): number {
    return this.map.size
  }
}
