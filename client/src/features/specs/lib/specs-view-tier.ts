export type SpecsViewTier = 'row' | 'postit'

export const DEFAULT_SPECS_VIEW_TIER: SpecsViewTier = 'postit'

const KEY = (projectId: string) => `specrails-desktop:specs-view-tier:${projectId}`

function isTier(v: unknown): v is SpecsViewTier {
  return v === 'row' || v === 'postit'
}

export function loadSpecsViewTier(projectId: string | null): SpecsViewTier {
  if (!projectId) return DEFAULT_SPECS_VIEW_TIER
  try {
    const v = localStorage.getItem(KEY(projectId))
    if (isTier(v)) return v
  } catch {
    /* private mode / quota */
  }
  return DEFAULT_SPECS_VIEW_TIER
}

export function saveSpecsViewTier(projectId: string | null, tier: SpecsViewTier): void {
  if (!projectId) return
  try {
    localStorage.setItem(KEY(projectId), tier)
  } catch {
    /* private mode / quota */
  }
}
