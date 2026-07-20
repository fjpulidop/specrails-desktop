import type { ProviderId } from './providers/types'
import { getAdapter, hasAdapter, isModelAvailableForAdapter } from './providers'

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
  { value: 'fable', label: 'Claude Fable' },
  { value: 'opus', label: 'Claude Opus' },
  { value: 'haiku', label: 'Claude Haiku' },
]

export const CODEX_MODELS: SpecModelOption[] = [
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
]

// Mirrors GEMINI_MODELS in server/providers/gemini-adapter.ts.
export const GEMINI_MODELS: SpecModelOption[] = [
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
]

// Mirrors KIMI_MODELS in server/providers/kimi-adapter.ts.
export const KIMI_MODELS: SpecModelOption[] = [
  { value: 'k3', label: 'Kimi K3' },
  { value: 'kimi-for-coding', label: 'Kimi for Coding' },
  { value: 'kimi-for-coding-highspeed', label: 'Kimi for Coding Highspeed' },
]

/** Per-provider model catalog. Unknown providers intentionally return none. */
const PROVIDER_MODELS: Record<string, SpecModelOption[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  gemini: GEMINI_MODELS,
  kimi: KIMI_MODELS,
}

export const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  claude: 'sonnet',
  codex: 'gpt-5.5',
  gemini: 'gemini-3.5-flash',
  kimi: 'k3',
}

export function getModelsForProvider(provider: SpecProvider): SpecModelOption[] {
  return PROVIDER_MODELS[provider] ?? []
}

export function isValidModelForProvider(model: unknown, provider: SpecProvider): model is string {
  if (!hasAdapter(provider)) return false
  return isModelAvailableForAdapter(getAdapter(provider), model)
}

export function getProviderDefault(provider: SpecProvider): string {
  return PROVIDER_DEFAULT_MODEL[provider] ?? ''
}
