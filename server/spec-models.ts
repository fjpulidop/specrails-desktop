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

// Mirrors GEMINI_MODELS in server/providers/gemini-adapter.ts.
export const GEMINI_MODELS: SpecModelOption[] = [
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3 Pro (preview)' },
]

/** Per-provider model catalog. Lookup, not a branch — fallback is Claude's. */
const PROVIDER_MODELS: Record<string, SpecModelOption[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  gemini: GEMINI_MODELS,
}

export const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  claude: 'sonnet',
  codex: 'gpt-5.5',
  gemini: 'gemini-2.5-pro',
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
