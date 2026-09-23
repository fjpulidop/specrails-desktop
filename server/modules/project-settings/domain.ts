import { isValidBranchName } from '../../shared/git-branch-name'

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

/** Only user-editable settings may cross the application's write boundary. */
export type ProjectSettingsPatch = Partial<Omit<ProjectSettings, 'orchestratorModelExplicit'>>

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsValidationError'
  }
}

/** Preserve the existing PATCH contract, including boolean coercion and ignored
 * unknown fields. Validate the whole input before the repository can write. */
export function parseProjectSettingsPatch(input: unknown): ProjectSettingsPatch {
  const values = (input ?? {}) as Record<string, unknown>
  const patch: ProjectSettingsPatch = {}
  if (values.pipelineTelemetryEnabled !== undefined) {
    patch.pipelineTelemetryEnabled = Boolean(values.pipelineTelemetryEnabled)
  }
  const validModels = ['sonnet', 'opus', 'haiku']
  if (values.orchestratorModel !== undefined) {
    if (typeof values.orchestratorModel !== 'string' || !validModels.includes(values.orchestratorModel)) {
      throw new SettingsValidationError(`orchestratorModel must be one of: ${validModels.join(', ')}`)
    }
    patch.orchestratorModel = values.orchestratorModel
  }
  for (const key of ['prePrompt', 'freestylePrePrompt'] as const) {
    if (values[key] !== undefined) {
      if (typeof values[key] !== 'string') throw new SettingsValidationError(`${key} must be a string`)
      patch[key] = values[key]
    }
  }
  if (values.worktreeEnvPassthrough !== undefined) {
    try {
      patch.worktreeEnvPassthrough = normalizeWorktreeEnvPassthrough(values.worktreeEnvPassthrough)
    } catch (error) {
      throw new SettingsValidationError(error instanceof Error ? error.message : 'invalid worktreeEnvPassthrough')
    }
  }
  if (values.integrationBranch !== undefined) {
    const branch = values.integrationBranch
    if (typeof branch !== 'string') throw new SettingsValidationError('integrationBranch must be a string')
    if (branch.trim() !== '' && !isValidBranchName(branch)) {
      throw new SettingsValidationError('integrationBranch is not a valid branch name')
    }
    patch.integrationBranch = branch
  }
  return patch
}
