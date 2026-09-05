/** Failure carried by a terminal provider result, independently of exit code.
 * Keep the result event intact so its usage remains available for accounting.
 * This deliberately does not inspect nested tool_result errors: a tool can
 * fail and the model can recover within an otherwise successful turn. */
export function terminalResultError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const result = payload as Record<string, unknown>
  if (result.type !== undefined && result.type !== 'result') return null
  const subtype = typeof result.subtype === 'string' ? result.subtype : ''
  if (result.is_error !== true && !/^error(?:_|$)/.test(subtype)) return null
  const errors = Array.isArray(result.errors)
    ? result.errors.filter((error): error is string => typeof error === 'string' && Boolean(error.trim()))
    : []
  const detail = errors.length > 0
    ? errors.join('; ')
    : typeof result.result === 'string' ? result.result.trim() : ''
  return [/^error(?:_|$)/.test(subtype) ? subtype : 'terminal result error', detail].filter(Boolean).join(': ').slice(0, 2000)
}
