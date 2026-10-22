// Public application API. Infrastructure adapters are wired only at composition roots.
export { createProjectSettingsService, type ProjectSettingsService } from './application'
export {
  DEFAULT_FREESTYLE_PRE_PROMPT,
  WORKTREE_ENV_NAME_RE,
  normalizeWorktreeEnvPassthrough,
  parseAgentEnvMode,
  parseSubagentRuntimeSetting,
  parseReviewWipLimit,
  REVIEW_WIP_LIMIT_MAX,
  SettingsValidationError,
  type AgentEnvMode,
  type ProjectSettings,
  type ProjectSettingsPatch,
  type SubagentRuntimeSetting,
} from './domain'
export type { ProjectSettingsRepository } from './ports'
