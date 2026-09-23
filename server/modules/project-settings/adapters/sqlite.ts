import type { DbInstance } from '../../../db/types'
import { DEFAULT_FREESTYLE_PRE_PROMPT, normalizeWorktreeEnvPassthrough, type ProjectSettings } from '../domain'
import type { ProjectSettingsRepository } from '../ports'

function parseWorktreeEnvPassthrough(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    return normalizeWorktreeEnvPassthrough(JSON.parse(raw))
  } catch {
    return []
  }
}

export function getProjectSettings(db: DbInstance): ProjectSettings {
  // Read the settings as one snapshot instead of preparing six separate queries.
  const rows = db.prepare(`
    SELECT key, value FROM queue_state WHERE key IN (
      'config.pipeline_telemetry_enabled', 'config.orchestrator_model',
      'config.pre_prompt', 'config.freestyle_pre_prompt',
      'config.integration_branch', 'config.worktree_env_passthrough'
    )
  `).all() as Array<{ key: string; value: string }>
  const settings = new Map(rows.map(row => [row.key, row]))
  const telemetryRow = settings.get('config.pipeline_telemetry_enabled')
  const modelRow = settings.get('config.orchestrator_model')
  const prePromptRow = settings.get('config.pre_prompt')
  const freestylePrePromptRow = settings.get('config.freestyle_pre_prompt')
  const integrationBranchRow = settings.get('config.integration_branch')
  const worktreeEnvPassthroughRow = settings.get('config.worktree_env_passthrough')
  return {
    pipelineTelemetryEnabled: telemetryRow?.value !== 'false',
    orchestratorModel: modelRow?.value ?? 'sonnet',
    orchestratorModelExplicit: modelRow?.value !== undefined,
    prePrompt: prePromptRow?.value ?? '',
    freestylePrePrompt: freestylePrePromptRow?.value ?? '',
    integrationBranch: integrationBranchRow?.value ?? '',
    worktreeEnvPassthrough: parseWorktreeEnvPassthrough(worktreeEnvPassthroughRow?.value),
  }
}

/** Resolve the effective Freestyle pre-prompt: the per-project override when
 *  set, otherwise the built-in default. */
export function getFreestylePrePrompt(db: DbInstance): string {
  const override = getProjectSettings(db).freestylePrePrompt.trim()
  return override || DEFAULT_FREESTYLE_PRE_PROMPT
}

export function updateProjectSettings(db: DbInstance, patch: Partial<ProjectSettings>): void {
  if (patch.pipelineTelemetryEnabled !== undefined) {
    db.prepare(
      `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.pipeline_telemetry_enabled', ?)`
    ).run(patch.pipelineTelemetryEnabled ? 'true' : 'false')
  }
  if (patch.orchestratorModel !== undefined) {
    db.prepare(
      `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.orchestrator_model', ?)`
    ).run(patch.orchestratorModel)
  }
  if (patch.prePrompt !== undefined) {
    if (patch.prePrompt.trim() === '') {
      db.prepare(`DELETE FROM queue_state WHERE key = 'config.pre_prompt'`).run()
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.pre_prompt', ?)`
      ).run(patch.prePrompt)
    }
  }
  if (patch.freestylePrePrompt !== undefined) {
    if (patch.freestylePrePrompt.trim() === '') {
      db.prepare(`DELETE FROM queue_state WHERE key = 'config.freestyle_pre_prompt'`).run()
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.freestyle_pre_prompt', ?)`
      ).run(patch.freestylePrePrompt)
    }
  }
  if (patch.integrationBranch !== undefined) {
    if (patch.integrationBranch.trim() === '') {
      db.prepare(`DELETE FROM queue_state WHERE key = 'config.integration_branch'`).run()
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.integration_branch', ?)`
      ).run(patch.integrationBranch.trim())
    }
  }
  if (patch.worktreeEnvPassthrough !== undefined) {
    const names = normalizeWorktreeEnvPassthrough(patch.worktreeEnvPassthrough)
    if (names.length === 0) {
      db.prepare(`DELETE FROM queue_state WHERE key = 'config.worktree_env_passthrough'`).run()
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.worktree_env_passthrough', ?)`
      ).run(JSON.stringify(names))
    }
  }
}

// ─── Explore Spec acceleration ────────────────────────────────────────────────

/**
 * Per-project last-used value for the Quick mode Contract Refine toggle in
 * the Add Spec modal. Default `false` when never set.
 */
export function getQuickContractRefineLast(db: DbInstance): boolean {
  const row = db.prepare(
    `SELECT value FROM queue_state WHERE key = 'config.add_spec_quick_contract_refine_last'`
  ).get() as { value: string } | undefined
  return row?.value === 'true'
}

export function hasQuickContractRefineLast(db: DbInstance): boolean {
  const row = db.prepare(
    `SELECT 1 FROM queue_state WHERE key = 'config.add_spec_quick_contract_refine_last'`
  ).get() as { 1: number } | undefined
  return !!row
}

export function setQuickContractRefineLast(db: DbInstance, enabled: boolean): void {
  db.prepare(
    `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('config.add_spec_quick_contract_refine_last', ?)`
  ).run(enabled ? 'true' : 'false')
}

/** Bind one project's connection. No global registry or cross-project cache. */
export function createSqliteProjectSettingsRepository(db: DbInstance): ProjectSettingsRepository {
  const update = db.transaction((patch: Parameters<ProjectSettingsRepository['update']>[0]) => {
    updateProjectSettings(db, patch)
    return getProjectSettings(db)
  })
  return {
    read: () => getProjectSettings(db),
    update,
  }
}
