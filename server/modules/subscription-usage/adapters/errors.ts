export class UsageError extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly retryMs?: number) { super(code) }
}
