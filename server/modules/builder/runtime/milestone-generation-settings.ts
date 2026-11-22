import type { DbInstance } from '../../../db'
import type { ProjectRow } from '../../../desktop-db'
import { derivePrimaryProvider, installedProviders } from '../../../provider-selection'
import { getAdapter, isModelAvailableForAdapter, reasoningEffortsForModel } from '../../../providers'
import { supportsToolPolicy } from '../../../providers/runtime'
import { readUsualMilestoneEngine, saveUsualMilestoneEngine } from './milestone-engine-preference'

export interface MilestoneGenerationSelection {
  provider: string
  model: string
  reasoningEffort: string | null
}

/** Project-owned preference ("usual configuration for the following
 *  iterations"): generates M2+ specs and, once saved while a launch chain is
 *  live, runs that chain's next rails (milestone-engine-preference.ts). Never
 *  changes the project/provider or day-0 defaults. */
export function readMilestoneGenerationSelection(db: DbInstance): MilestoneGenerationSelection | null {
  return readUsualMilestoneEngine(db)?.engine ?? null
}

export function milestoneGenerationCatalog(project: ProjectRow) {
  return installedProviders(project).flatMap((provider) => {
    try {
      const adapter = getAdapter(provider)
      if (!supportsToolPolicy(adapter, 'read-only')) return []
      const models = adapter.modelCatalog()
      return [{
        provider, models, defaultModel: adapter.defaultModel(),
        effortsByModel: Object.fromEntries(models.map(({ value }) => [value, reasoningEffortsForModel(adapter, value)])),
      }]
    } catch { return [] }
  })
}

export function milestoneGenerationSettings(db: DbInstance, project: ProjectRow) {
  const providers = milestoneGenerationCatalog(project)
  const primary = providers.find((entry) => entry.provider === derivePrimaryProvider(project)) ?? providers[0]
  const saved = readMilestoneGenerationSelection(db)
  return {
    providers,
    // Keep unavailable saved choices visible: never silently switch engines.
    selection: saved ?? (primary
      ? { provider: primary.provider, model: primary.defaultModel, reasoningEffort: null }
      : null),
    /** `project`: the person saved this usual configuration; `default`: the project's primary provider and its default model. */
    source: saved ? 'project' as const : 'default' as const,
  }
}

export function validateMilestoneGenerationSelection(project: ProjectRow, raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid generation settings'
  const { provider, model, reasoningEffort } = raw as Record<string, unknown>
  const catalog = milestoneGenerationCatalog(project)
  const entry = catalog.find((item) => item.provider === provider)
  if (!entry) return 'provider unavailable or read-only policy unsupported'
  const adapter = getAdapter(entry.provider)
  if (typeof model !== 'string' || !model || !isModelAvailableForAdapter(adapter, model)) return 'model not in provider catalog'
  if (reasoningEffort !== null && (typeof reasoningEffort !== 'string'
    || !(reasoningEffortsForModel(adapter, model) as readonly string[]).includes(reasoningEffort))) {
    return 'reasoning effort not in provider catalog'
  }
  return null
}

/** Execution has its own initial choice; generation preferences never leak into M1. */
export function milestoneLaunchSettings(project: ProjectRow) {
  const providers = milestoneGenerationCatalog(project)
  const primary = providers.find((entry) => entry.provider === derivePrimaryProvider(project)) ?? providers[0]
  return { providers, selection: primary ? { provider: primary.provider, model: primary.defaultModel, reasoningEffort: null } : null }
}

export function saveMilestoneGenerationSelection(db: DbInstance, selection: MilestoneGenerationSelection, nowMs: number = Date.now()): void {
  saveUsualMilestoneEngine(db, selection, nowMs)
}
