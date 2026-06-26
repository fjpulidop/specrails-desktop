/**
 * Per-provider model catalogs for the standalone Loop "Run" picker. Mirrors the
 * server's `spec-models.ts` catalogs + adapter defaults EXACTLY. The server
 * re-validates the chosen model against its own catalog (`isValidModelForProvider`),
 * so any drift here is rejected with a 400 rather than silently mis-run — but keep
 * the two in sync. The first entry of each list is that provider's default model.
 */
export interface LoopRunModel {
  value: string
  label: string
}

export const LOOP_RUN_MODELS: Record<string, LoopRunModel[]> = {
  claude: [
    { value: 'sonnet', label: 'Claude Sonnet' },
    { value: 'opus', label: 'Claude Opus' },
    { value: 'haiku', label: 'Claude Haiku' },
  ],
  codex: [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  ],
  gemini: [
    { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
    { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  ],
}

/** The selectable models for a provider (empty for an unknown provider). */
export function modelsForProvider(provider: string | undefined | null): LoopRunModel[] {
  return (provider && LOOP_RUN_MODELS[provider]) || []
}

/** The provider's default model (its catalog's first entry). */
export function defaultModelForProvider(provider: string | undefined | null): string {
  return modelsForProvider(provider)[0]?.value ?? ''
}
