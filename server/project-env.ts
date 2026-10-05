import type { DbInstance } from './db'
import { getProjectSettings } from './db'
import { readEnvFromLoginShellSync } from './path-resolver'

// Values stay in the owning project's memory, never process.env or SQLite.
// Both successful and missing lookups expire so profiles can recover/rotate.
const LOGIN_SHELL_CACHE_MS = 30_000
const shellValues = new WeakMap<DbInstance, { identity: string; expiresAt: number; env: NodeJS.ProcessEnv }>()

function recoverProjectEnv(db: DbInstance, names: string[]): NodeJS.ProcessEnv {
  const missing = names.filter(name => !process.env[name])
  if (!missing.length) { shellValues.delete(db); return {} }
  const identity = JSON.stringify([names, missing, process.env.SHELL, process.env.HOME, process.env.ZDOTDIR])
  const cached = shellValues.get(db)
  if (cached?.identity === identity && Date.now() < cached.expiresAt) return cached.env
  const env = readEnvFromLoginShellSync(missing)
  shellValues.set(db, { identity, expiresAt: Date.now() + LOGIN_SHELL_CACHE_MS, env })
  return env
}

/** Resolve the per-project env passthrough overlay for a spawn.
 *
 * The project setting stores names only. Values are read from `sourceEnv` at
 * spawn time so credentials can rotate without touching SQLite. When the
 * source is `process.env`, missing configured names get bounded login-shell
 * recovery with a short, project-owned cache. Unresolved names remain absent.
 */
export function resolveWorktreeEnvPassthrough(
  db: DbInstance,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  const names = getProjectSettings(db).worktreeEnvPassthrough
  const recovered = sourceEnv === process.env ? recoverProjectEnv(db, names) : {}
  for (const name of names) {
    const value = sourceEnv[name] || recovered[name] || sourceEnv[name]
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
