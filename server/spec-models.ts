import type { ProviderId } from './providers/types'

// Open provider id (see desktop-db `CliProvider`). The per-provider model
// catalog below is a data-driven lookup, not a closed union — a new provider
// adds one entry to `PROVIDER_MODELS` + `PROVIDER_DEFAULT_MODEL`, no branching.
export type SpecProvider = ProviderId

export interface SpecModelOption {
  value: string
  label: string
}

export const CLAUDE_MODELS: SpecModelOption[] = [
  { value: 'sonnet', label: 'Claude Sonnet' },
  { value: 'opus', label: 'Claude Opus' },
  { value: 'haiku', label: 'Claude Haiku' },
]

export const CODEX_MODELS: SpecModelOption[] = [
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
]

/** Per-provider model catalog. Lookup, not a branch — fallback is Claude's. */
const PROVIDER_MODELS: Record<string, SpecModelOption[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
}

export const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  claude: 'sonnet',
  codex: 'gpt-5.5',
}

export function getModelsForProvider(provider: SpecProvider): SpecModelOption[] {
  return PROVIDER_MODELS[provider] ?? CLAUDE_MODELS
}

export function isValidModelForProvider(model: unknown, provider: SpecProvider): model is string {
  if (typeof model !== 'string' || model.length === 0) return false
  return getModelsForProvider(provider).some((m) => m.value === model)
}

export function getProviderDefault(provider: SpecProvider): string {
  return PROVIDER_DEFAULT_MODEL[provider] ?? PROVIDER_DEFAULT_MODEL.claude
}
