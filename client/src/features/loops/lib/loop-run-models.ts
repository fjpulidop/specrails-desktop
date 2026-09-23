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
    { value: 'fable', label: 'Claude Fable' },
    { value: 'opus', label: 'Claude Opus' },
    { value: 'haiku', label: 'Claude Haiku' },
  ],
  codex: [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
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
  kimi: [
    { value: 'k3', label: 'Kimi K3' },
    { value: 'kimi-for-coding', label: 'Kimi for Coding' },
    { value: 'kimi-for-coding-highspeed', label: 'Kimi for Coding Highspeed' },
  ],
}

/**
 * Dynamic catalogs for providers with no static list — local AI engines whose
 * models are DISCOVERED by the server (`GET /v1/models`). Fed by
 * `useProviderDetection` (`providers[id].models`) and by the connections card
 * after a successful test; a machine property, not per-project state.
 */
const dynamicCatalogs = new Map<string, LoopRunModel[]>()

export function registerDynamicModelCatalog(provider: string, models: readonly string[]): void {
  if (!provider) return
  const unique = Array.from(new Set(models.filter((value) => typeof value === 'string' && value.trim())))
  if (unique.length === 0) { dynamicCatalogs.delete(provider); return }
  dynamicCatalogs.set(provider, unique.map((value) => ({ value, label: value })))
}

/** Test seam. */
export function resetDynamicModelCatalogs(): void {
  dynamicCatalogs.clear()
}

/** The selectable models for a provider: the static catalog, else the dynamic
 *  (discovered) one, else empty — never throws for an unknown id. */
export function modelsForProvider(provider: string | undefined | null): LoopRunModel[] {
  if (!provider) return []
  return LOOP_RUN_MODELS[provider] ?? dynamicCatalogs.get(provider) ?? []
}

/** The provider's default model (its catalog's first entry). */
export function defaultModelForProvider(provider: string | undefined | null): string {
  return modelsForProvider(provider)[0]?.value ?? ''
}
