// Agent-profile and model resolution for a queue job spawn (stage of
// QueueManager._startJob). Resolves the per-job profile snapshot, the single
// authoritative model for both transports and the pipeline reasoning effort.
import type { ProviderAdapter, ReasoningEffort } from '../../../providers'
import { isReasoningEffortValidForModel } from '../../../providers/runtime'
import {
  GLOBAL_DEFAULTS_PROFILE_NAME,
  mergeProfileWithAgentDefaults,
  synthesizeProfileFromDefaults,
  type ResolvedProviderAgentDefaults,
} from '../../agents/runtime/agent-defaults'
import type { DbInstance } from '../../../db'
import { getProjectSettings } from '../../../db'
import type { ProjectExecution } from '../../../workspace-resolution'
import { projectSupportsProfiles } from '../../../project-profile-support'

export interface JobProfileResolution {
  profileSnapshotPath: string | null
  profileName: string | null
  profileOrchestratorModel: string | null
}

export interface JobProfileInput {
  adapter: ProviderAdapter
  execution: ProjectExecution
  jobId: string
  projectId: string | null
  projectSlug: string | null
  cwd: string | undefined
  db: DbInstance | null
  /** Per-job selection: undefined = default resolution, null = legacy (none). */
  selection: string | null | undefined
  globalAgentDefaults: ResolvedProviderAgentDefaults | null
}

/**
 * Resolve agent profile (if any) and snapshot per-job before spawn.
 * Super mode only (projectId + projectSlug + cwd all present).
 * Skipped when the adapter does not honour `SPECRAILS_PROFILE_PATH` AND
 * when the project's installed specrails-core is older than the
 * provider's minimum core version (legacy fallback). Codex skill rails
 * ship in specrails-core 4.6.0+; the projectSupportsProfiles probe today
 * checks the claude minimum (4.1.0) — extending it per-provider is
 * tracked in OpenSpec change task §13.
 */
export function resolveJobProfile(input: JobProfileInput): JobProfileResolution {
  const { adapter, execution, jobId, globalAgentDefaults } = input
  let profileSnapshotPath: string | null = null
  let profileName: string | null = null
  let profileOrchestratorModel: string | null = null
  if (adapter.capabilities.profileEnvSupport && input.projectId && input.projectSlug && input.cwd) {
    try {
      const selection = input.selection // undefined|null|string
      // When relocated, core + `.specrails/profiles` live in the workspace
      // (execution.cwd); legacy reads from the repo (execution.cwd === repo).
      const coreSupports = projectSupportsProfiles(execution.cwd)
      if (selection !== null && coreSupports) {
        // selection is string (explicit) or undefined (default resolution)
        const {
          resolveProfile,
          snapshotForJob,
          persistJobProfile,
        } = require('../../agents/runtime/profile-manager') as typeof import('../../agents/runtime/profile-manager')
        let resolved = resolveProfile(execution.cwd, selection ?? undefined, adapter.id)
        // Global agent defaults: fill per-agent model gaps in the resolved
        // profile, or synthesize a baseline profile when the project has
        // none. Explicit profile choices always win; inert when the global
        // layer is off (byte-identical legacy behaviour).
        if (globalAgentDefaults && adapter.capabilities.profiles === true) {
          if (resolved) {
            const merged = mergeProfileWithAgentDefaults(resolved.profile, globalAgentDefaults)
            if (merged.changed) resolved = { name: resolved.name, profile: merged.profile }
          } else if (Object.keys(globalAgentDefaults.agentModels).length > 0) {
            resolved = {
              name: GLOBAL_DEFAULTS_PROFILE_NAME,
              profile: synthesizeProfileFromDefaults(adapter, globalAgentDefaults),
            }
          }
        }
        if (resolved) {
          profileSnapshotPath = snapshotForJob(input.projectSlug, jobId, resolved)
          profileName = resolved.name
          profileOrchestratorModel = resolved.profile.orchestrator.model
          if (input.db) {
            persistJobProfile(input.db, jobId, resolved)
          }
        }
      }
    } catch (err) {
      // Profile resolution failures are non-fatal — rail falls back to
      // legacy behavior. The error is visible in logs for debugging.
      console.warn(`[queue-manager] profile resolution failed for job ${jobId}: ${(err as Error).message}`)
    }
  }
  return { profileSnapshotPath, profileName, profileOrchestratorModel }
}

/**
 * The project/default rail model below the per-job override and the profile
 * orchestrator: claude reads the project orchestrator model (explicit choice
 * wins over the global layer); other providers use the resolved project model,
 * then the global pipeline model, then the adapter default.
 */
export function resolveFallbackRailModel(
  adapter: ProviderAdapter,
  db: DbInstance | null,
  resolvedModel: string | null,
  globalAgentDefaults: ResolvedProviderAgentDefaults | null,
): string {
  const claudeProjectSettings = adapter.id === 'claude' && db ? getProjectSettings(db) : null
  return claudeProjectSettings
    ? (claudeProjectSettings.orchestratorModelExplicit
      ? claudeProjectSettings.orchestratorModel
      : globalAgentDefaults?.pipelineModel ?? claudeProjectSettings.orchestratorModel)
    : (resolvedModel ?? globalAgentDefaults?.pipelineModel ?? adapter.defaultModel())
}

/**
 * Pipeline-level reasoning effort from the global layer (rails never had a
 * per-job effort knob, so this is purely additive). Validated against the
 * FINAL model — claude/codex sub-agents inherit the process-level effort,
 * kimi rides its env knob via buildProviderEnv, gemini has no effort.
 */
export function resolveGlobalRailEffort(
  adapter: ProviderAdapter,
  railModel: string,
  globalAgentDefaults: ResolvedProviderAgentDefaults | null,
): ReasoningEffort | undefined {
  return globalAgentDefaults?.pipelineEffort
    && isReasoningEffortValidForModel(adapter, railModel, globalAgentDefaults.pipelineEffort)
    ? globalAgentDefaults.pipelineEffort
    : undefined
}
