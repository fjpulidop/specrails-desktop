import { getDetectionSnapshot, type DetectionSnapshot } from '../../../provider-detection'
import { getAdapter, hasAdapter, listAdapters } from '../../../providers'
import { isLocalAdapter } from '../../../providers/local-adapter'
import { resolvePriceEntry } from '../../accounting/runtime/pricing'
import { getModelsForProvider } from '../../specs/runtime/spec-models'
import type { PresetProviderCandidate } from '../domain'

/**
 * The machine's providers as the preset chooser sees them: usable/auth state
 * from the app-level detection snapshot, models and their rate-card price from
 * the provider catalog. Local engines carry their discovered models and no price.
 */
export function presetCandidates(snapshot: DetectionSnapshot): PresetProviderCandidate[] {
  const candidates: PresetProviderCandidate[] = []
  for (const adapter of listAdapters()) {
    const row = snapshot.providers[adapter.id]
    if (!row || !hasAdapter(adapter.id)) continue
    const local = isLocalAdapter(adapter)
    const models = local
      ? (row.models ?? []).map((value) => ({ value, priceUsdPer1M: null }))
      : getModelsForProvider(adapter.id).map(({ value }) => {
          const price = resolvePriceEntry(adapter.id, value)
          return { value, priceUsdPer1M: price ? price.inputPer1M + price.outputPer1M : null }
        })
    candidates.push({
      id: adapter.id,
      local,
      usable: row.usable === true,
      authState: row.authState,
      defaultModel: getAdapter(adapter.id).defaultModel(),
      models,
    })
  }
  return candidates
}

export async function loadPresetCandidates(refresh = false): Promise<PresetProviderCandidate[]> {
  return presetCandidates(await getDetectionSnapshot(refresh ? { refresh: true } : undefined))
}
