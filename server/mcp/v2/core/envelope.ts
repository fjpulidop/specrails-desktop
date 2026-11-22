import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { errorEnvelope, type EnvelopeError, type ErrorCode, type NextCall } from '../../tools/envelope'
import type { DecisionState } from './decision-state'
import type { Ref } from './refs'

/**
 * Envelope v2: the single result shape of every v2 tool (docs/internals/mcp-v2.md §Envelope).
 *
 * - `structuredContent` IS the envelope; `content[0]` carries the same JSON
 *   minified (no pretty printing, no second payload). Clients on a protocol
 *   without structured results get the summary line plus the compact JSON.
 * - Machine fields (codes, statuses, ids) stay English; `summary`, labels and
 *   messages are already localized by the producer.
 *
 * Pure module apart from the zod output shape.
 */

export const ENVELOPE_VERSION = 2 as const

/** v1 stable codes plus the v2 additions. */
export type V2ErrorCode = ErrorCode | 'stale' | 'held' | 'budget_exceeded' | 'not_implemented'

export interface Page {
  /** Opaque continuation; null when this is the last page. */
  cursor: string | null
  total?: number
  /** True when the server cut the result (size guard or page limit). */
  truncated: boolean
}

export interface V2Success<D = unknown> {
  v: 2
  ok: true
  /** ≤ 2 sentences, in the resolved language. */
  summary: string
  data: D
  refs?: Record<string, Ref>
  state?: DecisionState
  page?: Page
  /** Deprecations, partial sources, stale cursors, truncation notes. */
  warnings?: string[]
  /** JSON pointers (`*` = any key or index) of fields holding third-party or model text. */
  untrusted?: string[]
}

export interface V2ErrorBody extends Omit<EnvelopeError, 'code'> {
  code: V2ErrorCode
  /** `confirmation_required` / `stale`: what the call would do. */
  preview?: unknown
  /** `confirmation_required` / `stale`: resend with `confirm: <token>` after the person agreed. */
  confirmToken?: string
  /** `held`: the entity's decision state (why it waits, what is legal now). */
  state?: DecisionState
  /** `stale`: why the token no longer applies. */
  reason?: string
}

export interface V2Failure {
  v: 2
  ok: false
  summary: string
  error: V2ErrorBody
  warnings?: string[]
}

export type V2Envelope<D = unknown> = V2Success<D> | V2Failure

// ── Handler results ─────────────────────────────────────────────────────────

const RESULT = Symbol.for('specrails.mcp.v2.result')

export type ResultMeta = Partial<Pick<V2Success, 'summary' | 'refs' | 'state' | 'page' | 'warnings' | 'untrusted'>>

/**
 * Where the page of a store- or offset-paged list starts, so a size-guard cut
 * yields an absolute cursor (`offset + kept`, stamped with the query key) that
 * the tool's own `decodeCursor(cursor, key)` resumes from. Not part of the envelope.
 */
export interface PageBase {
  /** Offset of the first returned item in the full list. */
  offset: number
  /** Query key the tool's cursors carry. */
  key?: string
  /** Pointer (relative to `data`) of the paged array; default `/items`. */
  path?: string
}

export interface V2Result<D = unknown> extends ResultMeta {
  [RESULT]: true
  data: D
  pageBase?: PageBase
}

/** What a v2 handler returns: data plus its own summary/refs/state/page. Plain data also works. */
export function result<D>(data: D, meta: ResultMeta & { pageBase?: PageBase } = {}): V2Result<D> {
  return { ...meta, data, [RESULT]: true }
}

export function isV2Result(value: unknown): value is V2Result {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[RESULT] === true
}

// ── Errors ──────────────────────────────────────────────────────────────────

const RETRYABLE: ReadonlySet<V2ErrorCode> = new Set(['provider_unavailable', 'rate_limited', 'stale'])

/** A v2 tool error with a stable code; extra fields land on `error`. */
export class V2ToolError extends Error {
  constructor(
    readonly code: V2ErrorCode,
    message: string,
    readonly extra: Partial<Omit<V2ErrorBody, 'code' | 'message'>> = {},
  ) {
    super(message)
    this.name = 'V2ToolError'
  }
}

/** Any thrown value → a v2 failure. v1 errors (McpToolError, McpApiError) keep their mapping. */
export function failure(err: unknown, label: string, summary?: string): V2Failure {
  if (err instanceof V2ToolError) {
    const error: V2ErrorBody = { code: err.code, message: err.message, retryable: err.extra.retryable ?? RETRYABLE.has(err.code), ...stripUndefined(err.extra) }
    return { v: 2, ok: false, summary: summary ?? `${label}: ${oneLine(err.message)}`, error }
  }
  const legacy = errorEnvelope(err, label, null)
  return { v: 2, ok: false, summary: summary ?? `${label}: ${oneLine(legacy.error.message)}`, error: legacy.error }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// ── Building ────────────────────────────────────────────────────────────────

/** Success envelope from a handler result; empty optional sections are omitted. */
export function success(value: unknown, fallbackSummary: string, extraWarnings: readonly string[] = []): V2Success {
  const own = isV2Result(value) ? value : null
  const envelope: V2Success = { v: 2, ok: true, summary: own?.summary ?? fallbackSummary, data: (own ? own.data : value) ?? null }
  if (own?.refs && Object.keys(own.refs).length) envelope.refs = own.refs
  if (own?.state) envelope.state = own.state
  if (own?.page) envelope.page = own.page
  const warnings = [...(own?.warnings ?? []), ...extraWarnings]
  if (warnings.length) envelope.warnings = [...new Set(warnings)]
  if (own?.untrusted?.length) envelope.untrusted = [...new Set(own.untrusted)]
  return envelope
}

/** How `content[0]` renders: minified JSON, or summary + compact JSON for clients without structured results. */
export type TextMode = 'json' | 'summary+json'

/** structuredContent arrived with protocol 2025-06-18; older clients read only `content`. */
export function textModeFor(protocolVersion: string | undefined | null): TextMode {
  return typeof protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(protocolVersion) && protocolVersion < '2025-06-18' ? 'summary+json' : 'json'
}

/** The MCP result: one minified copy in `content`, the envelope as `structuredContent`. */
export function toCallToolResult(envelope: V2Envelope, mode: TextMode = 'json'): CallToolResult {
  const json = JSON.stringify(envelope)
  const text = mode === 'json' ? json : `${envelope.summary}\n${json}`
  return {
    content: [{ type: 'text', text }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    ...(envelope.ok ? {} : { isError: true }),
  }
}

/**
 * Advertised `outputSchema` of every v2 tool: the keys every envelope has,
 * open for the rest (validated server-side by this module's types). `v` is
 * optional because a v1 alias served through a v2 tool answers with the v1
 * envelope (ok + summary, no `v`).
 */
export const V2_OUTPUT_SCHEMA = z.looseObject({ v: z.literal(2).optional(), ok: z.boolean(), summary: z.string() }).meta({ $schema: undefined } as Record<string, unknown>)

export type { NextCall }

/**
 * Re-serves another call's envelope (`ctx.v2.dispatch`) as this call's result:
 * a success keeps its data and meta, a failure is rethrown with its code and
 * extras (`preview`, `confirmToken`, `state`, `choices`…), so a delegated
 * confirmation reaches the agent unchanged.
 */
export function relay(envelope: V2Envelope): V2Result {
  if (envelope.ok) {
    return result(envelope.data, { summary: envelope.summary, ...(envelope.refs ? { refs: envelope.refs } : {}), ...(envelope.state ? { state: envelope.state } : {}), ...(envelope.page ? { page: envelope.page } : {}), ...(envelope.warnings ? { warnings: envelope.warnings } : {}), ...(envelope.untrusted ? { untrusted: envelope.untrusted } : {}) })
  }
  const { code, message, ...extra } = envelope.error
  throw new V2ToolError(code, message, extra)
}
