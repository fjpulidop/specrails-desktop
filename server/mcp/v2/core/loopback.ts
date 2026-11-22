/**
 * Loopback calls to the app's own REST routes (master token held server-side),
 * the one way v2 tools reach domain logic they do not read directly.
 *
 * - `apiRow` keeps the v1 error (`McpApiError`) for callers that inspect the
 *   route's status or code themselves; the registry maps it like v1.
 * - `api` turns a route refusal into a typed `V2ToolError` whose message is the
 *   route's own text (`error: detail`).
 * - `maybe` reads something that may legitimately be absent (an HTTP 4xx/5xx
 *   gives null; transport and programming errors still throw).
 */
import { apiCall, McpApiError, type McpToolContext } from '../../tools/types'
import { codeForStatus } from '../../tools/envelope'
import { V2ToolError } from './envelope'
import { asRecord, type Row } from './text'

export type LoopbackMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export async function apiRow(ctx: McpToolContext, method: LoopbackMethod, path: string, body?: unknown): Promise<Row> {
  return asRecord(await apiCall(ctx, method, path, body))
}

/** The typed v2 error for a refused loopback call. */
export function typedApiError(err: McpApiError): V2ToolError {
  const data = asRecord(err.data)
  const text = [data.error, data.detail].filter((part): part is string => typeof part === 'string' && part.length > 0).join(': ') || err.message
  return new V2ToolError(codeForStatus(err.status, err.code), text, err.status >= 500 ? { retryable: true } : {})
}

export async function api(ctx: McpToolContext, method: LoopbackMethod, path: string, body?: unknown): Promise<Row> {
  try {
    return await apiRow(ctx, method, path, body)
  } catch (err) {
    throw err instanceof McpApiError ? typedApiError(err) : err
  }
}

export async function maybe(ctx: McpToolContext, path: string): Promise<Row | null> {
  try {
    return await apiRow(ctx, 'GET', path)
  } catch (err) {
    if (err instanceof McpApiError && err.status >= 400 && err.status < 600) return null
    throw err
  }
}
