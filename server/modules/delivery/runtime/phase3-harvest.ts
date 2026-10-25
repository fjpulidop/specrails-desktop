/**
 * Settle-time options for the phase-3 evidence (feedback-2026-10): which Core
 * run records to read, the project's human-only rules to freeze and where a
 * run's baseline spend comes from. Every source is gated on the active Core's
 * capability; without it the options are empty and the evidence record is
 * exactly what it was before.
 */
import type { DbInstance } from '../../../db'
import { corePhase3Capabilities, type CorePhase3Capabilities } from '../../agent-runtime/runtime/core-capabilities'
import { readRuntimeHistory } from '../../agent-runtime/runtime/agent-runtime-history'
import { readDefinitionRun } from '../../loops/runtime/loop-runs-store'
import { humanOnlyRules } from '../../project-rules/domain'
import { readProjectRulesInventory } from '../../project-rules/runtime/rules-store'
import type { EvidenceHarvestIO } from './delivery-evidence'
import type { DeliveryBaselineCost } from './run-records'

export type Phase3HarvestOptions = Pick<EvidenceHarvestIO, 'specTrace' | 'baselineOnTouch' | 'humanRules' | 'baselineCost'>

/** Baseline spend recorded in the run's runtime history (null when unknown). */
export function runBaselineCost(db: DbInstance, runId: string): DeliveryBaselineCost | null {
  try {
    const contextPath = readDefinitionRun(db, runId)?.metadata.contextPath
    if (!contextPath) return null
    const baseline = readRuntimeHistory(contextPath)?.efficiencySummary?.baseline
    return baseline ? { invocations: baseline.invocations, costUsd: baseline.costUsd, inputTokens: baseline.inputTokens, outputTokens: baseline.outputTokens } : null
  } catch {
    return null
  }
}

export async function phase3HarvestOptions(input: {
  db: DbInstance
  project: { slug: string; path: string }
  capabilities?: () => Promise<CorePhase3Capabilities>
}): Promise<Phase3HarvestOptions> {
  const capabilities = await (input.capabilities ?? corePhase3Capabilities)()
  let humanRules: Phase3HarvestOptions['humanRules'] = null
  if (capabilities.rulesInventory) {
    try { humanRules = humanOnlyRules(readProjectRulesInventory(input.project)) } catch { humanRules = null }
  }
  return {
    specTrace: capabilities.specTrace,
    baselineOnTouch: capabilities.baselineOnTouch,
    humanRules,
    ...(capabilities.baselineOnTouch ? { baselineCost: (runId: string) => runBaselineCost(input.db, runId) } : {}),
  }
}
