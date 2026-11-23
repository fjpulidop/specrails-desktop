/**
 * Per-rail configuration handlers of the rail header: mode, Loop, model,
 * reasoning effort, engine, profile and target PR. localStorage holds the
 * truth; profile/engine are also persisted server-side best-effort.
 */
import { getApiBase } from '../../../lib/api'
import type { RailState } from '../../rails/components/RailsBoard'
import type { RailTargetPr } from '../../rails/components/RailTargetPrSelector'
import type { RailMode } from '../../rails/components/RailControls'
import { deriveRailMode } from '../../rails/lib/rail-loops'
import { defaultModelForProvider, modelsForProvider } from '../../loops/lib/loop-run-models'
import {
  defaultReasoningEffortForProvider,
  isRolesEngine,
  providerSupportsCustomModelAliases,
  reasoningEffortsForProvider,
} from '../../providers/lib/provider-capabilities'
import { isSafeCustomModelAlias } from '../../providers/lib/model-alias'
import { railProviderOf, serverRailIndex } from '../lib/board-rails'
import type { RailsUpdater } from './useBoardRails'

export function useRailConfigHandlers(rails: RailState[], updateRails: RailsUpdater, railProviders: readonly string[]) {
  const railProvider = (r: { aiEngine?: string | null } | undefined) => railProviderOf(r, railProviders)

  // ── Rail controls ─────────────────────────────────────────────────────────────
  function handleModeChange(railId: string, mode: RailMode) {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, mode } : r)))
  }


  async function handleProfileChange(railId: string, profileName: string | null) {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, profileName } : r)))
    const railIndex = serverRailIndex(rails, railId)
    if (railIndex === -1) return
    try {
      await fetch(`${getApiBase()}/rails/${railIndex}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileName }),
      })
    } catch {
      // Silent — server persistence is best-effort; localStorage holds the truth
      // and the profile will be sent inline in the next launch either way.
    }
  }

  function handleLoopChange(railId: string, loopId: string) {
    // rails-as-loops: the chosen Loop (factory or custom) drives the rail; derive
    // the legacy `mode` from it so launch + selector gating stay correct. Stored
    // in localStorage and sent inline at launch.
    const mode = deriveRailMode(loopId)
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, selectedLoopId: loopId, mode } : r)))
  }


  function handleLoopModelChange(railId: string, model: string) {
    updateRails((prev) => prev.map((r) => {
      if (r.id !== railId) return r
      const provider = railProvider(r)
      const efforts = reasoningEffortsForProvider(provider, model)
      return {
        ...r,
        loopModel: model,
        reasoningEffort: r.reasoningEffort && efforts.includes(r.reasoningEffort)
          ? r.reasoningEffort
          : defaultReasoningEffortForProvider(provider, model) ?? null,
      }
    }))
  }

  function handleEffortChange(railId: string, effort: import('../../agents/components/RailEffortSelector').ReasoningEffort) {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, reasoningEffort: effort } : r)))
  }

  async function handleEngineChange(railId: string, aiEngine: string) {
    // Hybrid per-role engines: no single provider to derive model/effort from
    // (each role is configured in Settings ▸ Specrails Agents), so the rail
    // keeps its model/effort untouched and only the engine flips.
    if (isRolesEngine(aiEngine)) {
      updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, aiEngine, profileName: null } : r)))
      await persistRailEngine(railId, aiEngine)
      return
    }
    // Provider-specific model and effort selections are reset if the previous
    // value is not accepted by the new adapter.
    updateRails((prev) => prev.map((r) => {
      if (r.id !== railId) return r
      const validModels = modelsForProvider(aiEngine)
      const modelIsValid = (value: string | null | undefined) =>
        Boolean(
          value
          && (
            validModels.some((model) => model.value === value)
            || (
              providerSupportsCustomModelAliases(aiEngine)
              && isSafeCustomModelAlias(value)
            )
          ),
        )
      const nextLoopModel = modelIsValid(r.loopModel)
        ? r.loopModel
        : defaultModelForProvider(aiEngine)
      const efforts = reasoningEffortsForProvider(aiEngine, nextLoopModel)
      return {
        ...r,
        aiEngine,
        profileName: null,
        loopModel: nextLoopModel,
        reasoningEffort: r.reasoningEffort && efforts.includes(r.reasoningEffort)
          ? r.reasoningEffort
          : defaultReasoningEffortForProvider(aiEngine, nextLoopModel) ?? null,
      }
    }))
    await persistRailEngine(railId, aiEngine)
  }

  async function persistRailEngine(railId: string, aiEngine: string) {
    const railIndex = serverRailIndex(rails, railId)
    if (railIndex === -1) return
    try {
      await fetch(`${getApiBase()}/rails/${railIndex}/engine`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiEngine }),
      })
    } catch {
      // Best-effort persistence; localStorage holds the truth and the engine is
      // sent inline on the next launch regardless.
    }
  }

  function handleTargetPrChange(railId: string, value: RailTargetPr | null) {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, targetPr: value } : r)))
  }

  function handleWorkspaceSelectionChange(railId: string, workspaceSelection: RailState['workspaceSelection']) {
    updateRails(prev => prev.map(rail => rail.id === railId ? { ...rail, workspaceSelection } : rail))
  }

  return {
    handleModeChange,
    handleProfileChange,
    handleLoopChange,
    handleLoopModelChange,
    handleEffortChange,
    handleEngineChange,
    handleTargetPrChange,
    handleWorkspaceSelectionChange,
  }
}
