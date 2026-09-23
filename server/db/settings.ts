import type { DbInstance } from './types'

// ─── Project settings ─────────────────────────────────────────────────────────

/**
 * Default pre-prompt used by provider-capable Freestyle rails when the project
 * has no per-project override. Freestyle skips the OpenSpec pipeline entirely:
 * it hands the selected autonomous provider the spec text plus this instruction and lets it work
 * autonomously end-to-end.
 */
export const DEFAULT_FREESTYLE_PRE_PROMPT = [
  'You are operating in FREESTYLE: fully autonomous, end-to-end implementation.',
  'Implement the following spec COMPLETELY in this repository. You have full access to the codebase and tools.',
  'Work independently until the feature is done: write the code, the tests, update docs as needed, and make sure everything builds and the test suite passes.',
  'Do NOT follow any structured architect/developer/reviewer pipeline — use your own judgement and the repo conventions.',
  'Never ask for confirmation; there is no human to answer. Choose the recommended option and proceed.',
  'Run every command in the FOREGROUND and wait for it to finish — never background a command (no run_in_background, no trailing `&`): your reply ends the step and anything still running is killed with its output lost.',
].join('\n')

export interface ProjectSettings {
  pipelineTelemetryEnabled: boolean
  orchestratorModel: string
  /** True when the project stored an explicit orchestrator model (vs the
   *  built-in 'sonnet' fallback) — lets the global Specrails Agents defaults
   *  layer slot in below a real user choice but above the hardcoded default. */
  orchestratorModelExplicit: boolean
  prePrompt: string
  /** Per-project Freestyle pre-prompt override. Empty string = use
   *  DEFAULT_FREESTYLE_PRE_PROMPT at spawn time. */
  freestylePrePrompt: string
  /** Designated integration branch that mutating loops branch worktrees from and
   *  target draft PRs at. Empty string = auto-resolve (repo default → HEAD) via
   *  `resolveIntegrationBranch`. */
  integrationBranch: string
  /** Environment variable names to explicitly pass through to project jobs and
   *  isolated loop worktrees. Values are read from the server process env at
   *  spawn time and are never stored in SQLite. */
  worktreeEnvPassthrough: string[]
}

export const WORKTREE_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const WORKTREE_ENV_MAX_NAMES = 64
const WORKTREE_ENV_MAX_NAME_LENGTH = 128

export function normalizeWorktreeEnvPassthrough(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('worktreeEnvPassthrough must be an array of environment variable names')
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') throw new Error('worktreeEnvPassthrough entries must be strings')
    const name = raw.trim()
    if (!name) continue
    if (name.length > WORKTREE_ENV_MAX_NAME_LENGTH) throw new Error(`environment variable name is too long: ${name.slice(0, 24)}...`)
    if (!WORKTREE_ENV_NAME_RE.test(name)) throw new Error(`invalid environment variable name: ${name}`)
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length > WORKTREE_ENV_MAX_NAMES) throw new Error(`worktreeEnvPassthrough can contain at most ${WORKTREE_ENV_MAX_NAMES} names`)
  }
  return out
}

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
