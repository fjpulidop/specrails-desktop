import type {
  AdapterEvent,
  ProviderAdapter,
  ReasoningEffort,
  SpawnOptions,
} from './types'

export type RestrictedToolPolicy = Exclude<NonNullable<SpawnOptions['toolPolicy']>, 'default'>

/**
 * Conservative grammar for provider-configured model aliases passed as the
 * value immediately following a CLI model flag (for example Kimi's `-m`).
 *
 * Keep aliases shell-neutral even though Desktop spawns with argv arrays:
 * no leading `-`, whitespace, controls, quoting, or unbounded values. Common
 * provider/model forms such as `kimi-code/k3`, `team/model:v2`, and dotted
 * registry ids remain valid and are preserved byte-for-byte after validation.
 */
export const CUSTOM_MODEL_ALIAS_MAX_LENGTH = 128
const SAFE_CUSTOM_MODEL_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/

export function isSafeCustomModelAlias(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= CUSTOM_MODEL_ALIAS_MAX_LENGTH
    && SAFE_CUSTOM_MODEL_ALIAS_PATTERN.test(value)
}

/**
 * Provider-aware model validation.
 *
 * Catalog entries are always accepted. Off-catalog values are accepted only
 * when the adapter explicitly advertises configured aliases and the value
 * satisfies the safe argv grammar above.
 */
export function isModelAvailableForAdapter(
  adapter: ProviderAdapter,
  value: unknown,
): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (adapter.modelCatalog().some((model) => model.value === value)) return true
  return adapter.capabilities.customModelAliases === true
    && isSafeCustomModelAlias(value)
}

/** Whether an adapter natively enforces the requested non-default boundary. */
export function supportsToolPolicy(
  adapter: ProviderAdapter,
  policy: RestrictedToolPolicy,
): boolean {
  return (adapter.capabilities.toolPolicies ?? []).includes(policy)
}

/**
 * Safest boundary for a pure-output transform. Prefer a true no-tools mode;
 * read-only is an acceptable fallback when the CLI has no native `none`.
 * `null` means the action must fail closed before a child is spawned.
 */
export function pureOutputToolPolicy(
  adapter: ProviderAdapter,
): RestrictedToolPolicy | null {
  if (supportsToolPolicy(adapter, 'none')) return 'none'
  if (supportsToolPolicy(adapter, 'read-only')) return 'read-only'
  return null
}

/** Throw a stable, provider-identifying error for an unsupported boundary. */
export function requireToolPolicy(
  adapter: ProviderAdapter,
  policy: RestrictedToolPolicy,
): RestrictedToolPolicy {
  if (!supportsToolPolicy(adapter, policy)) {
    throw new Error(`provider_tool_policy_unsupported:${adapter.id}:${policy}`)
  }
  return policy
}

/** Exact effort tiers accepted by a provider for the effective model. */
export function reasoningEffortsForModel(
  adapter: ProviderAdapter,
  model: string,
): readonly ReasoningEffort[] {
  if (adapter.capabilities.supportsReasoningEffort !== true) return []
  return adapter.reasoningEffortsForModel?.(model)
    ?? adapter.capabilities.reasoningEfforts
    ?? []
}

/**
 * Safe app default for a model: medium where available, otherwise high where
 * available, then the first tier. Kimi K3's native default is high; preferring
 * it over low keeps an omitted Desktop selection semantically identical to the
 * upstream CLI without changing the ordered selector catalog.
 */
export function defaultReasoningEffortForModel(
  adapter: ProviderAdapter,
  model: string,
): ReasoningEffort | undefined {
  const efforts = reasoningEffortsForModel(adapter, model)
  if (efforts.includes('medium')) return 'medium'
  if (efforts.includes('high')) return 'high'
  return efforts[0]
}

/** Narrow an untrusted effort value against the model-specific catalog. */
export function isReasoningEffortValidForModel(
  adapter: ProviderAdapter,
  model: string,
  value: unknown,
): value is ReasoningEffort {
  return typeof value === 'string'
    && (reasoningEffortsForModel(adapter, model) as readonly string[]).includes(value)
}

/** Merge provider runtime overrides without mutating the caller or process.env. */
export function buildProviderEnv(
  adapter: ProviderAdapter,
  opts: SpawnOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...baseEnv }
  for (const [key, value] of Object.entries(adapter.buildEnv?.(opts) ?? {})) {
    // Windows treats environment names case-insensitively. Remove every
    // inherited casing before applying an adapter-owned override/deletion so
    // `kimi_code_experimental_flag` cannot survive a scrub of the canonical
    // `KIMI_CODE_EXPERIMENTAL_FLAG` (and likewise for reasoning effort).
    const foldedKey = key.toLowerCase()
    for (const inheritedKey of Object.keys(merged)) {
      if (inheritedKey.toLowerCase() === foldedKey) delete merged[inheritedKey]
    }
    if (value !== undefined) merged[key] = value
  }
  return merged
}

/**
 * Provider-native Core command/prompt, identity when no hook is declared.
 * `cwd` points at the provider artifact root for adapters that must load the
 * headless workflow content before spawn.
 */
export function formatProviderCommand(
  adapter: ProviderAdapter,
  command: string,
  cwd?: string,
  sessionId?: string,
): string {
  return adapter.formatCoreCommand?.(command, cwd, sessionId) ?? command
}

/** Flatten provider-native access flags for additional repository roots. */
export function buildProviderRepoAccessArgs(
  adapter: ProviderAdapter,
  paths: readonly string[],
): string[] {
  return adapter.buildRepoAccessArgs?.(paths) ?? []
}

/**
 * Normalize an adapter's single-or-batch parser contract into an event list.
 * One JSONL record may contain assistant text and several tool calls (Kimi).
 */
export function parseStreamEvents(adapter: ProviderAdapter, line: string): readonly AdapterEvent[] {
  const parsed = adapter.parseStreamLine(line)
  if (parsed == null) return []
  return Array.isArray(parsed) ? parsed : [parsed as AdapterEvent]
}
