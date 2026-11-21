/**
 * Provider session ids are passed to the CLIs as argv (`--resume <id>`,
 * `codex exec resume <id>`, Core's `providerSessionRef` → `--resume`). They
 * come back from provider streams and the database, so they are validated at
 * every hand-off: an id starting with `-` would be read as a flag, a control
 * character can split or hide argv in logs, and no real id is anywhere near
 * 512 characters.
 */
export const MAX_PROVIDER_SESSION_ID_LENGTH = 512

export class UnsafeProviderSessionIdError extends Error {
  readonly code = 'unsafe_provider_session_id'
  constructor(provider: string) {
    super(`Refusing to resume ${provider}: the stored session id is not a valid session id.`)
    this.name = 'UnsafeProviderSessionIdError'
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export function isSafeProviderSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PROVIDER_SESSION_ID_LENGTH
    && value.trim() === value
    && !value.startsWith('-')
    && !CONTROL.test(value)
}

/** The id itself when safe; throws `UnsafeProviderSessionIdError` otherwise. */
export function safeProviderSessionId(value: string, provider: string): string {
  if (!isSafeProviderSessionId(value)) throw new UnsafeProviderSessionIdError(provider)
  return value
}
