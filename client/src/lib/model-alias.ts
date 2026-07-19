/**
 * Runtime-safe grammar for provider-defined model aliases.
 *
 * Model aliases are forwarded as the value of a CLI argument, never parsed by
 * a shell. Keeping the first character alphanumeric prevents a custom alias
 * from being mistaken for a flag by a provider CLI while still supporting the
 * namespaced aliases documented by Kimi Code (for example
 * `moonshot-team/private-coder:v2`).
 *
 * Keep this contract byte-for-byte aligned with server/providers/runtime.ts.
 */
export const CUSTOM_MODEL_ALIAS_MAX_LENGTH = 128

const SAFE_CUSTOM_MODEL_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/

export function isSafeCustomModelAlias(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= CUSTOM_MODEL_ALIAS_MAX_LENGTH
    && SAFE_CUSTOM_MODEL_ALIAS_PATTERN.test(value)
}
