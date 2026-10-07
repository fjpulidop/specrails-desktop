import type { SessionErrorData } from './protocol'

/** A session protocol request failed; `code` is Core's stable error code. */
export class SessionRequestError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly detail: Record<string, unknown> | undefined

  constructor(message: string, data: SessionErrorData, readonly rpcCode?: number) {
    super(message)
    this.name = 'SessionRequestError'
    this.code = data.code
    this.retryable = data.retryable
    this.detail = data.detail
  }
}

export function isSessionRequestError(error: unknown, code?: string): error is SessionRequestError {
  return error instanceof SessionRequestError && (code === undefined || error.code === code)
}
