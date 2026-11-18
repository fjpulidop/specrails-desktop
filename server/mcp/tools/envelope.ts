import { z } from 'zod'

/**
 * The uniform MCP tool result contract (docs/internals/mcp-response-envelope.md).
 *
 * Every tool call answers with ONE envelope, returned twice: as pretty JSON text
 * (for clients that only read `content`) and as MCP `structuredContent`
 * validated by `ENVELOPE_OUTPUT_SHAPE` (advertised as each tool's
 * `outputSchema`). `data` carries the tool's own payload byte-compatibly with
 * the pre-envelope result, so existing consumers move one level down only.
 *
 * Pure module: no I/O, no SDK imports, so the envelope is testable alone.
 */

/** A suggested follow-up call: exact tool + arguments + why it helps. */
export interface NextCall {
  tool: string
  args: Record<string, unknown>
  why: string
}

export type ErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'unauthorized'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'internal'
  | 'ambiguous'
  | 'confirmation_required'

export interface EnvelopeError {
  code: ErrorCode
  message: string
  retryable: boolean
  /** Valid values for an ambiguous or unknown selector (projects, repositories, …). */
  choices?: unknown[]
  next?: NextCall[]
  /** The loopback route that answered, for diagnostics (never a token). */
  http?: { method: string; path: string; status: number }
  /** Machine code the backend returned (e.g. `rail_busy`), when it differs from `code`. */
  backendCode?: string
  /** confirmation_required: the exact arguments to resend. */
  resend?: { tool: string; args: Record<string, unknown> }
}

export interface SuccessEnvelope {
  ok: true
  summary: string
  status?: string
  data: unknown
  ids?: Record<string, unknown>
  links?: Record<string, string>
  next?: NextCall[]
  truncated?: boolean
  cursor?: string | number | null
  partial?: boolean
}

export interface ErrorEnvelope {
  ok: false
  summary: string
  error: EnvelopeError
}

export type Envelope = SuccessEnvelope | ErrorEnvelope

/** The fields a handler (or the summarizer) may set besides `data`. */
export type EnvelopeMeta = Partial<Omit<SuccessEnvelope, 'ok' | 'data'>>

const RESPONSE = Symbol.for('specrails.mcp.response')

/** A handler result that carries its own summary/next instead of the generic one. */
export interface ToolResponse extends EnvelopeMeta {
  [RESPONSE]: true
  data: unknown
}

/**
 * Wrap a handler payload with a hand-written summary / next calls. Handlers
 * that return plain data still work: the framework builds a generic summary.
 */
export function toolResponse(data: unknown, meta: EnvelopeMeta = {}): ToolResponse {
  return { ...meta, data, [RESPONSE]: true }
}

export function isToolResponse(value: unknown): value is ToolResponse {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[RESPONSE] === true
}

/**
 * Output schema advertised for every tool (MCP `outputSchema`). Kept compact —
 * it is repeated in every tools/list entry; the field meanings live in
 * docs/internals/mcp-response-envelope.md and specrails_guide. Error payloads
 * are not validated by the SDK, so `error` stays a loose object.
 */
const nextCallSchema = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()), why: z.string() })
export const ENVELOPE_OUTPUT_SHAPE = {
  ok: z.boolean(),
  summary: z.string(),
  status: z.string().optional(),
  data: z.unknown().optional(),
  ids: z.record(z.string(), z.unknown()).optional(),
  links: z.record(z.string(), z.string()).optional(),
  next: z.array(nextCallSchema).optional(),
  truncated: z.boolean().optional(),
  cursor: z.union([z.string(), z.number(), z.null()]).optional(),
  partial: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).passthrough().optional(),
}

// ── Success ─────────────────────────────────────────────────────────────────

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** Generic one-liner for tools without a hand-written summary. */
export function genericSummary(tool: string, action: string | null, data: unknown): string {
  const label = action ? `${tool}(${action})` : tool
  if (data === null || data === undefined) return `${label} completed with no data.`
  if (typeof data === 'string') {
    const first = data.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim() ?? ''
    return `${label} returned text${first ? `: ${first.slice(0, 120)}` : ''}.`
  }
  if (Array.isArray(data)) return `${label} returned ${plural(data.length, 'item')}.`
  if (typeof data === 'object') {
    const record = data as Record<string, unknown>
    const listKey = Object.keys(record).find((key) => Array.isArray(record[key]))
    const total = typeof record.total === 'number' ? record.total : undefined
    if (listKey) {
      const count = (record[listKey] as unknown[]).length
      return `${label} returned ${count}${total !== undefined && total !== count ? ` of ${total}` : ''} ${listKey}.`
    }
    if (record.ok === false) return `${label} reported a failure; see data for details.`
    if (typeof record.status === 'string') return `${label} completed; status is ${record.status}.`
  }
  return `${label} completed.`
}

/** Build the success envelope from a handler result (plain data or toolResponse). */
export function successEnvelope(result: unknown, fallback: { tool: string; action: string | null; meta?: EnvelopeMeta }): SuccessEnvelope {
  const own = isToolResponse(result) ? result : null
  const data = own ? own.data : result
  const merged: EnvelopeMeta = { ...(fallback.meta ?? {}), ...(own ? stripBrand(own) : {}) }
  const envelope: SuccessEnvelope = {
    ok: true,
    summary: merged.summary ?? genericSummary(fallback.tool, fallback.action, data),
    ...(merged.status !== undefined ? { status: merged.status } : {}),
    data: data ?? null,
  }
  if (merged.ids && Object.keys(merged.ids).length) envelope.ids = merged.ids
  if (merged.links && Object.keys(merged.links).length) envelope.links = merged.links
  if (merged.next?.length) envelope.next = merged.next
  if (merged.truncated !== undefined) envelope.truncated = merged.truncated
  if (merged.cursor !== undefined) envelope.cursor = merged.cursor
  if (merged.partial !== undefined) envelope.partial = merged.partial
  return envelope
}

function stripBrand(response: ToolResponse): EnvelopeMeta {
  const { data: _data, ...meta } = response
  void _data
  return meta
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** A tool error that already knows its stable code (and optional choices / next calls). */
export class McpToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { retryable?: boolean; choices?: unknown[]; next?: NextCall[]; resend?: EnvelopeError['resend'] } = {},
  ) {
    super(message)
    this.name = 'McpToolError'
  }
}

/** Structural view of `McpApiError` (types.ts) so this module stays dependency-free. */
interface ApiErrorLike { status: number; data: unknown; route?: { method: string; path: string } }

function isApiErrorLike(value: unknown): value is ApiErrorLike & Error {
  return value instanceof Error && typeof (value as unknown as ApiErrorLike).status === 'number' && 'data' in value
}

/** Stable code for an HTTP status (and the backend's own error code when it is more precise). */
export function codeForStatus(status: number, backendCode?: string): ErrorCode {
  if (backendCode === 'repository_required' || backendCode === 'ambiguous') return 'ambiguous'
  if (backendCode === 'tier_disabled') return 'unauthorized'
  if (status === 400 || status === 422) return 'invalid_input'
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'not_found'
  if (status === 409 || status === 412) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status === 502 || status === 503 || status === 504) return 'provider_unavailable'
  return 'internal'
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['provider_unavailable', 'rate_limited'])

/** The human message inside a REST error body (`{ error, detail, message }`), never the raw JSON dump. */
export function backendMessage(data: unknown): string | null {
  if (typeof data === 'string') return data.trim() ? data.trim().slice(0, 1000) : null
  if (!data || typeof data !== 'object') return null
  const body = data as Record<string, unknown>
  const parts = [body.message, body.error, body.detail]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
  if (!parts.length) return null
  // `error` is often a machine code (`not_a_failed_job`); prefer prose when both exist.
  const prose = parts.find((part) => /\s/.test(part)) ?? parts[0]
  const detail = typeof body.detail === 'string' && body.detail !== prose ? ` ${body.detail}` : ''
  return `${prose}${detail}`.slice(0, 1000)
}

/** Classify a plain thrown message from a handler (no HTTP status available). */
export function codeForMessage(message: string): ErrorCode {
  const text = message.toLowerCase()
  if (/ambiguous|provide repositoryid for this multi-repository/.test(text)) return 'ambiguous'
  if (/permission tier|capability expired|was revoked|raise the level|requires an active first-party|only to an authenticated|available only to/.test(text)) return 'unauthorized'
  if (/unknown (projectid|tool|conversation|action)|not found|no project registered|does not exist|has expired/.test(text)) return 'not_found'
  if (/temporarily unavailable|unreachable|econnrefused|fetch failed|timed out|timeout|aborted/.test(text)) return 'provider_unavailable'
  if (/requires|must be|provide |invalid|no project specified|no project selected|is required|needs a/.test(text)) return 'invalid_input'
  if (/already|busy|conflict|while active|is running/.test(text)) return 'conflict'
  return 'internal'
}

/** Normalize any thrown value into the stable error envelope. */
export function errorEnvelope(err: unknown, tool: string, action: string | null): ErrorEnvelope {
  const label = action ? `${tool}(${action})` : tool
  let error: EnvelopeError
  if (err instanceof McpToolError) {
    error = {
      code: err.code, message: err.message,
      retryable: err.extra.retryable ?? RETRYABLE.has(err.code),
      ...(err.extra.choices ? { choices: err.extra.choices } : {}),
      ...(err.extra.next?.length ? { next: err.extra.next } : {}),
      ...(err.extra.resend ? { resend: err.extra.resend } : {}),
    }
  } else if (isApiErrorLike(err)) {
    const body = err.data && typeof err.data === 'object' ? err.data as Record<string, unknown> : {}
    const backendCode = typeof body.error === 'string' && /^[a-z0-9_]+$/i.test(body.error) ? body.error
      : typeof body.code === 'string' ? body.code : undefined
    const code = codeForStatus(err.status, backendCode)
    const choices = Array.isArray(body.repositories) ? body.repositories
      : Array.isArray(body.choices) ? body.choices : undefined
    // An in-process selector error (no loopback route) already carries a sentence; drop its JSON dump.
    const ownMessage = err.route ? null : err.message.replace(/:\s*[[{][\s\S]*$/, '').trim() || null
    error = {
      code,
      message: ownMessage ?? backendMessage(err.data) ?? `The request failed with HTTP ${err.status}.`,
      retryable: RETRYABLE.has(code),
      ...(choices ? { choices } : {}),
      ...(err.route ? { http: { ...err.route, status: err.status } } : {}),
      ...(backendCode && backendCode !== code ? { backendCode } : {}),
    }
  } else {
    const message = err instanceof Error ? err.message : String(err)
    const code = err instanceof Error && err.name === 'AbortError' ? 'provider_unavailable' : codeForMessage(message)
    error = { code, message, retryable: RETRYABLE.has(code) }
  }
  return { ok: false, summary: `${label} failed: ${oneLine(error.message)}`, error }
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
