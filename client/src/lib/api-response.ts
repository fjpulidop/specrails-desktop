import i18n from './i18n'

export class ApiResponseError extends Error {
  constructor(readonly code: 'htmlResponse' | 'invalidResponse' | 'endpointUnavailable', readonly status: number) {
    super(i18n.t(`network.${code}`, { ns: 'common', status }))
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

export async function readApiJson<T>(res: Response): Promise<T> {
  const data = await parseApiJson<T>(res)
  if (!res.ok) {
    const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined
    if (error === 'api_route_not_found') throw new ApiResponseError('endpointUnavailable', res.status)
    throw new Error(typeof error === 'string' && error ? error : i18n.t('network.httpError', { ns: 'common', status: res.status }))
  }
  return data as T
}
