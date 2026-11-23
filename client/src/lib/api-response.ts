import i18n from './i18n'

/**
 * Codes the client itself assigns. A server error body's own `code` (e.g.
 * `MISSION_LIVE`, `budget_exceeded`) is passed through unchanged, so `code` is
 * an open string.
 */
export type ApiClientErrorCode = 'htmlResponse' | 'invalidResponse' | 'endpointUnavailable' | 'httpError' | 'timeout'
export type ApiErrorCode = ApiClientErrorCode | 'MISSION_LIVE' | 'NOT_ARCHIVED' | 'MISSION_ARCHIVED' | (string & {})

const LOCALIZED_CODES = new Set<string>(['htmlResponse', 'invalidResponse', 'endpointUnavailable', 'MISSION_LIVE', 'NOT_ARCHIVED', 'MISSION_ARCHIVED'])

export class ApiResponseError extends Error {
  /**
   * @param fromHttpStatus true when the error only reports an HTTP error status
   *   (the server answered and refused), as opposed to an unreadable response,
   *   a timeout or one of the mission conflict codes.
   */
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message?: string,
    readonly body: unknown = undefined,
    readonly fromHttpStatus = false,
  ) {
    super(message ?? (LOCALIZED_CODES.has(code)
      ? i18n.t(`network.${code}`, { ns: 'common', status })
      : i18n.t('network.httpError', { ns: 'common', status })))
    this.name = 'ApiResponseError'
  }
}

/** Parse before HTTP-specific error handling, without leaking a page or syntax
 * error into the UI. This never retries a request: a mutation may have run even
 * when its response was interrupted or replaced by a proxy. */
export async function parseApiJson<T>(res: Response): Promise<T | null> {
  const text = await res.text()
  const type = res.headers?.get('content-type') ?? ''
  if (/\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(type) || /^\s*</.test(text)) {
    throw new ApiResponseError('htmlResponse', res.status)
  }
  if (!text.trim()) return null
  try { return JSON.parse(text) as T } catch {
    throw new ApiResponseError('invalidResponse', res.status)
  }
}

function field(data: unknown, key: string): unknown {
  return data && typeof data === 'object' && key in data ? (data as Record<string, unknown>)[key] : undefined
}

/**
 * The body of a successful response, or an `ApiResponseError` carrying the
 * HTTP status, the body's `code` (else `httpError`) and its `error`/`message`
 * text (else a localized "HTTP <status>" line).
 */
export async function readApiJson<T>(res: Response): Promise<T> {
  const data = await parseApiJson<T>(res)
  if (!res.ok) {
    const error = field(data, 'error')
    const code = field(data, 'code')
    if (code === 'MISSION_LIVE' || code === 'NOT_ARCHIVED' || code === 'MISSION_ARCHIVED') {
      throw new ApiResponseError(code, res.status, typeof error === 'string' ? error : undefined, data)
    }
    if (error === 'api_route_not_found') throw new ApiResponseError('endpointUnavailable', res.status, undefined, data)
    const text = typeof error === 'string' && error ? error : field(data, 'message')
    throw new ApiResponseError(
      typeof code === 'string' && code ? code : 'httpError',
      res.status,
      typeof text === 'string' && text ? text : undefined,
      data,
      true,
    )
  }
  return data as T
}

export interface RequestJsonInit extends RequestInit {
  /** Abort the request after this many ms with `ApiResponseError('timeout')`. */
  timeoutMs?: number
}

/**
 * The client's JSON request helper: `fetch` + `readApiJson`, with an optional
 * caller `signal` (its abort rejects with the usual `AbortError`) and an
 * optional timeout. Use it for new API calls instead of a hand-written
 * `if (!res.ok)` check; see `features/README.md` ("API calls").
 */
export async function requestJson<T>(input: string, init?: RequestJsonInit): Promise<T> {
  if (init?.timeoutMs === undefined) {
    // Plain `fetch(input)` / `fetch(input, init)`: the same call a hand-written site makes.
    const { timeoutMs: _none, ...plain } = init ?? {}
    return readApiJson<T>(await (init ? fetch(input, plain) : fetch(input)))
  }
  const { timeoutMs, signal, ...rest } = init
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    return await readApiJson<T>(await fetch(input, { ...rest, signal: controller.signal }))
  } catch (error) {
    if (timedOut) throw new ApiResponseError('timeout', 0, i18n.t('network.requestFailed', { ns: 'common' }))
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
