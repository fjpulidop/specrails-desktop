/** Compatibility facade for existing persistence consumers. */
export {
  DEFAULT_FREESTYLE_PRE_PROMPT,
  WORKTREE_ENV_NAME_RE,
  normalizeWorktreeEnvPassthrough,
  type ProjectSettings,
} from '../modules/project-settings'
export {
  getProjectSettings,
  getFreestylePrePrompt,
  updateProjectSettings,
  getQuickContractRefineLast,
  hasQuickContractRefineLast,
  setQuickContractRefineLast,
} from '../modules/project-settings/adapters/sqlite'
