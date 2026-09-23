// Public application API. Infrastructure adapters are wired only at composition roots.
export { createProjectSettingsService, type ProjectSettingsService } from './application'
export {
  DEFAULT_FREESTYLE_PRE_PROMPT,
  WORKTREE_ENV_NAME_RE,
  normalizeWorktreeEnvPassthrough,
  SettingsValidationError,
  type ProjectSettings,
  type ProjectSettingsPatch,
} from './domain'
export type { ProjectSettingsRepository } from './ports'
