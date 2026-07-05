/**
 * Pre-trust specrails-managed spawn directories in the user's `~/.claude.json`
 * so a HEADLESS claude rail/job spawn honours the `.claude/settings.json`
 * `permissions.allow` list the framework overlay places in the worktree.
 *
 * Why: claude ignores a workspace's `permissions.allow` entries until that
 * project directory has been "trusted" (the interactive trust dialog, or
 * `projects[<dir>].hasTrustDialogAccepted: true` in `~/.claude.json`). specrails
 * spawns claude headlessly in FRESH per-run worktrees / workspaces that were
 * never opened interactively, so every isolated rail run logged
 * "Ignoring N permissions.allow entries … this workspace has not been trusted"
 * and ran with its pre-approved permissions silently dropped. We manage those
 * directories, so pre-marking them trusted is correct and safe.
 *
 * Surgical + best-effort: read → set only `hasTrustDialogAccepted` on the
 * relevant `projects[<realpath>]` keys → atomic temp+rename. Never throws, never
 * touches any other field, and only writes when something actually changed.
 * claude-only (the trust/allow model is a claude concept). Memoized per path so
 * a multi-step run does the I/O once, before the first spawn in that dir.
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

// Per-path memo so a multi-step run writes at most once per unique dir.
const _trusted = new Set<string>()

/**
 * Ensure the claude spawn directories are trusted, once per process per dir.
 * No-op for non-claude providers and best-effort otherwise (a failure only
 * means the pre-approved permissions stay dropped — never blocks a spawn).
 */
export function ensureClaudeTrusted(provider: string, dirs: Array<string | undefined>, home?: string): void {
  if (provider !== 'claude') return
  const todo = dirs.filter((d): d is string => !!d && !_trusted.has(canonical(d)))
  if (todo.length === 0) return
  try {
    markProjectsTrusted(claudeConfigPath(home), todo)
  } catch {
    /* best-effort */
  }
  for (const d of todo) _trusted.add(canonical(d))
}

/** Test-only: clear the per-path memo. */
export function __resetClaudeTrustMemoForTest(): void {
  _trusted.clear()
}
