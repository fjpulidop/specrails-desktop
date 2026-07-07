import type { DbInstance } from './db'
import { getProjectSettings } from './db'
import { augmentEnvFromLoginShellSync } from './path-resolver'

/** Resolve the per-project env passthrough overlay for a spawn.
 *
 * The project setting stores names only. Values are read from `sourceEnv` at
 * spawn time so credentials can rotate without touching SQLite. When the
 * source is `process.env`, missing configured names get one bounded login-shell
 * recovery attempt first; unresolved names are still ignored instead of
 * blocking the run.
 */
export function resolveWorktreeEnvPassthrough(
  db: DbInstance,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  const names = getProjectSettings(db).worktreeEnvPassthrough
  if (sourceEnv === process.env) augmentEnvFromLoginShellSync(names)
  for (const name of names) {
    const value = sourceEnv[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

export function applyWorktreeEnvPassthrough(
  db: DbInstance,
  env: NodeJS.ProcessEnv,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const passthrough = resolveWorktreeEnvPassthrough(db, sourceEnv)
  return Object.keys(passthrough).length === 0 ? env : { ...env, ...passthrough }
}
