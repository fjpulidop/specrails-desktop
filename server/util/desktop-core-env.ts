/**
 * How THIS Desktop picks its Core (a local checkout during development; see
 * `core-runtime.ts`). Nothing Desktop launches for a project reads them — Core,
 * provider CLIs, their agents and verification commands — but inherited they
 * would steer that project instead: a Desktop checkout's own tests resolve Core
 * through them and fail.
 */
export const DESKTOP_CORE_SELECTION_ENV_KEYS = ['SPECRAILS_CORE_BIN', 'SPECRAILS_CORE_RUNTIME_PATH', 'SPECRAILS_FRAMEWORK_AUTOSWAP'] as const

/** `env` without Desktop's Core selection (case-insensitively, for Windows). Never mutates `env`. */
export function withoutDesktopCoreSelection(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const folded = new Set<string>(DESKTOP_CORE_SELECTION_ENV_KEYS.map(key => key.toLowerCase()))
  const inherited = Object.keys(env).filter(key => folded.has(key.toLowerCase()))
  if (!inherited.length) return env
  const scoped = { ...env }
  for (const key of inherited) delete scoped[key]
  return scoped
}
