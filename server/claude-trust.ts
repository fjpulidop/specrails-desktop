/**
 * Pre-trust specrails-managed spawn directories in the user's `~/.claude.json`
 * so a HEADLESS claude rail/job spawn does NOT log the noisy
 * "Ignoring N permissions.allow entries … this workspace has not been trusted"
 * warning.
 *
 * IMPORTANT — this is cosmetic, not load-bearing. Every claude spawn already
 * carries `--dangerously-skip-permissions` (see `claude-adapter.ts` COMMON_FLAGS),
 * which bypasses the permission engine entirely — so a workspace's
 * `.claude/settings.json` `permissions.allow` list is moot on these spawns
 * whether the dir is trusted or not. Marking the dir trusted only silences the
 * warning. (It WOULD become functionally load-bearing if we ever dropped
 * `--dangerously-skip-permissions` and relied on the allow-list.)
 *
 * Why re-assert on EVERY spawn (no persistent memo): `~/.claude.json` is a
 * single ~200KB file holding ALL projects that many concurrent claude processes
 * rewrite wholesale (each carries its own in-memory snapshot). Our surgical
 * `true` for one dir is routinely clobbered by another process writing the whole
 * file back with a stale `false` — a lost update. A one-shot per-process memo
 * (the old design) therefore left the flag stuck `false` for the rest of the
 * process lifetime after the first clobber. Re-asserting immediately before each
 * spawn re-flips a clobbered `false → true` so this spawn reads `true` at
 * startup. It cannot fully win the race against concurrent whole-file writers,
 * but the failure mode is only a cosmetic warning, so best-effort is enough.
 *
 * Surgical + best-effort: read → set only `hasTrustDialogAccepted` on the
 * relevant `projects[<realpath>]` keys → atomic temp+rename. Never throws, never
 * touches any other field, and only writes when something actually changed.
 * claude-only (the trust/allow model is a claude concept).
 */
import * as fs from 'fs'
import * as path from 'path'
import { resolveHome } from './artifact-registry'

/** `~/.claude.json` — honours `resolveHome()` so tests (which pin
 *  `SPECRAILS_REGISTRY_HOME`) never touch the real user file, while production
 *  (env unset) resolves the true home. */
export function claudeConfigPath(home?: string): string {
  return path.join(resolveHome(home), '.claude.json')
}

/** Collapse symlinks so the key matches the path claude actually resolves; falls
 *  back to the raw path when it doesn't exist yet. */
function canonical(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Mark each of `dirs` trusted in the claude config at `configPath`. Returns the
 * number of project entries newly trusted (0 when all were already trusted or
 * on any failure). Pure w.r.t. inputs (explicit path) so it is unit-testable.
 */
export function markProjectsTrusted(configPath: string, dirs: string[]): number {
  // Filter empties BEFORE canonicalising — `path.resolve('')` is cwd, which
  // must never be trusted implicitly.
  const unique = [...new Set(dirs.filter((d) => d && d.length > 0).map(canonical))]
  if (unique.length === 0) return 0
  let config: Record<string, unknown> = {}
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8')
      config = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {}
    }
  } catch {
    // A corrupt/unreadable config is the user's — do NOT overwrite it blindly.
    return 0
  }
  const projects =
    config.projects && typeof config.projects === 'object'
      ? (config.projects as Record<string, Record<string, unknown>>)
      : {}
  let changed = 0
  for (const dir of unique) {
    const entry = projects[dir] && typeof projects[dir] === 'object' ? projects[dir] : {}
    if (entry.hasTrustDialogAccepted === true) continue
    projects[dir] = { ...entry, hasTrustDialogAccepted: true }
    changed += 1
  }
  if (changed === 0) return 0
  config.projects = projects
  try {
    const tmp = `${configPath}.sr-tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
    fs.renameSync(tmp, configPath)
  } catch {
    return 0
  }
  return changed
}

/**
 * Ensure the claude spawn directories are trusted, RE-ASSERTED on every call
 * (no persistent memo — see the module header for why: concurrent whole-file
 * writers clobber our flag back to `false`, and a one-shot memo would leave it
 * stuck). No-op for non-claude providers and best-effort otherwise (a failure
 * only leaves the cosmetic trust warning — never blocks a spawn).
 *
 * `markProjectsTrusted` reads the current on-disk value and writes ONLY when a
 * dir is missing / `false`, so a call where the flag is already `true` is a
 * cheap read with no write.
 */
export function ensureClaudeTrusted(provider: string, dirs: Array<string | undefined>, home?: string): void {
  if (provider !== 'claude') return
  const todo = dirs.filter((d): d is string => !!d)
  if (todo.length === 0) return
  try {
    markProjectsTrusted(claudeConfigPath(home), todo)
  } catch {
    /* best-effort */
  }
}
