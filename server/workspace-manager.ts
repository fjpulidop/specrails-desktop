import fs from 'fs'
import path from 'path'

import { FrameworkManager } from './framework-manager'
import { migrateWorkspaceToSymlinks } from './framework-migration'
import { resolveHome } from './artifact-registry'

/**
 * WorkspaceManager — a reusable materializer for the per-project workspace dir
 * under `~/.specrails/projects/<slug>/workspace`. This is the relocation target
 * for a repo's artifacts (see `server/artifact-registry.ts` + the global-
 * artifacts-alignment contract): the workspace holds the `./project` link back
 * to the user's repo so tools spawned with the workspace as cwd can still reach
 * the source.
 *
 * This generalizes the materialization logic of `explore-cwd-manager.ts`
 * (the `ensureProjectLink` symlink/junction/fallback dance) without coupling to
 * the Explore-specific embedded instructions file. Explore-cwd is intentionally
 * left UNCHANGED (it keeps its own parallel copy); this module is the forward-
 * looking home for workspace materialization.
 *
 * NOTE (this stage): nothing yet spawns from the workspace dir. This is the
 * additive foundation — wiring spawn cwd/env to the workspace is a later stage.
 */

/** Base dir holding all per-project app data. Overridable for tests.
 *  Resolves `$HOME` through `artifact-registry.resolveHome()` so this module and
 *  the registry NEVER diverge — both honour `SPECRAILS_REGISTRY_HOME` when no
 *  explicit home is threaded. Diverging here would create the `./project` symlink
 *  in a different tree than the registry's `workspaceDir` (BUG-ARTREG-01). */
function projectsBaseDir(home?: string): string {
  return path.join(resolveHome(home), '.specrails', 'projects')
}

/**
 * Compute the workspace path for a project without touching the filesystem.
 * Mirrors `artifact-registry.workspaceLayout(...).workspaceDir`.
 */
export function workspacePathFor(slug: string, home?: string): string {
  return path.join(projectsBaseDir(home), slug, 'workspace')
}

/**
 * Create or refresh the workspace dir for a project. Idempotent and cheap when
 * already up-to-date. Creates the workspace directory and a `./project`
 * symlink (junction on Windows) pointing at `projectPath`, with a
 * `project-path.txt` fallback when symlink/junction creation fails. Returns the
 * absolute workspace path.
 */
export function ensureWorkspace(slug: string, projectPath: string, home?: string): string {
  const ws = workspacePathFor(slug, home)
  fs.mkdirSync(ws, { recursive: true })
  ensureProjectLink(ws, projectPath)
  return ws
}

export interface AssembleFrameworkResult {
  /** True when the bundled-core assemble ran (false ⇒ no bundled core / no-op). */
  assembled: boolean
  /** The workspace path (always returned, even on no-op). */
  workspace: string
  /** Error message from the bundled-core assemble, if any. */
  error?: string
}

/**
 * Ensure the workspace exists (with the `./project` link) AND assemble the
 * framework into it by SYMLINK (offline) via the bundled specrails-core
 * `assemble` subcommand. The providerDir static subtrees
 * (`agents/`/`commands/`/`skills/`/`rules/`) become symlinks into
 * `~/.specrails/framework/current/<provider>/`; `agent-memory/` stays a real
 * writable dir (core's assemble handles that distinction).
 *
 * EXISTENCE-GATED: when no bundled core is present, `assembled` is false and the
 * caller must fall back to the legacy `npx specrails-core init` assembly. The
 * workspace + `./project` link are still ensured so the legacy path has a cwd.
 */
export function assembleWorkspaceFramework(
  slug: string,
  projectPath: string,
  provider: string,
  opts: {
    home?: string
    version?: string
    framework?: FrameworkManager
    /** App-level WS broadcast (no projectId) threaded into the lazy migration. */
    broadcast?: (msg: { type: string; [k: string]: unknown }) => void
    /** Internal: set by the migration's own re-link call to avoid re-entrancy. */
    _skipMigrate?: boolean
  } = {},
): AssembleFrameworkResult {
  const ws = ensureWorkspace(slug, projectPath, opts.home)
  const fm = opts.framework ?? new FrameworkManager({ home: opts.home })
  if (!fm.isAvailable()) {
    return { assembled: false, workspace: ws }
  }

  // Lazy-on-first-touch migration: if this workspace still holds a per-workspace
  // framework COPY (the pre-bundled relocate-core layout), convert it to symlinks
  // into `framework/current` non-destructively BEFORE assembling. Idempotent +
  // safe to run repeatedly; it no-ops once the workspace is symlinked. The
  // migration re-enters this function with `_skipMigrate` to do the actual
  // re-link, so we guard against infinite recursion here.
  if (!opts._skipMigrate) {
    try {
      migrateWorkspaceToSymlinks(slug, projectPath, provider, {
        home: opts.home,
        framework: fm,
        broadcast: opts.broadcast,
      })
    } catch {
      /* migration is best-effort; assemble below still produces a usable layout */
    }
  }

  const res = fm.assembleWorkspace({
    workspace: ws,
    provider,
    version: opts.version,
    codeRoot: projectPath,
  })
  if (!res.ran) return { assembled: false, workspace: ws }
  return { assembled: true, workspace: ws, error: res.error }
}

/**
 * Recursively remove the workspace dir for a project. The `project`
 * symlink/junction is unlinked explicitly (never followed) so the user's repo
 * is never touched. No-op when the dir does not exist.
 */
export function removeWorkspace(slug: string, home?: string): void {
  const ws = workspacePathFor(slug, home)
  if (!fs.existsSync(ws)) return

  const linkPath = path.join(ws, 'project')
  try {
    const st = fs.lstatSync(linkPath)
    if (st.isSymbolicLink() || (process.platform === 'win32' && st.isDirectory())) {
      // unlink works on POSIX symlinks; rmdir on Windows junctions
      try { fs.unlinkSync(linkPath) } catch {
        try { fs.rmdirSync(linkPath) } catch { /* best-effort */ }
      }
    }
  } catch {
    /* link may not exist */
  }

  fs.rmSync(ws, { recursive: true, force: true })
}

/**
 * Ensure `<ws>/project` resolves to `<projectPath>` (symlink on POSIX, junction
 * on Windows). Recreated when the existing target differs. On both symlink and
 * junction failure, writes a `project-path.txt` fallback. This is the EXACT
 * logic from `explore-cwd-manager.ts`'s private `ensureProjectLink`.
 */
function ensureProjectLink(cwd: string, projectPath: string): void {
  const linkPath = path.join(cwd, 'project')
  const fallbackPath = path.join(cwd, 'project-path.txt')

  let needsCreate = true
  try {
    const st = fs.lstatSync(linkPath)
    if (st.isSymbolicLink()) {
      const current = fs.readlinkSync(linkPath)
      if (path.resolve(cwd, current) === path.resolve(projectPath)) {
        needsCreate = false
      } else {
        fs.unlinkSync(linkPath)
      }
    } else {
      // existing non-symlink (e.g. Windows junction or stale dir) — replace
      try { fs.unlinkSync(linkPath) } catch {
        try { fs.rmdirSync(linkPath) } catch { /* best-effort */ }
      }
    }
  } catch {
    /* link does not exist — fall through to create */
  }

  if (needsCreate) {
    let created = false
    if (process.platform === 'win32') {
      try {
        fs.symlinkSync(projectPath, linkPath, 'junction')
        created = true
      } catch { /* fall through to plain symlink */ }
    }
    if (!created) {
      try {
        fs.symlinkSync(projectPath, linkPath)
        created = true
      } catch { /* fall through to text fallback */ }
    }
    if (!created) {
      // Final fallback: write the absolute path so the model can use it.
      fs.writeFileSync(fallbackPath, projectPath, 'utf-8')
      return
    }
  }

  // If we successfully created/verified the symlink, clean up any stale
  // fallback file from a prior failed attempt.
  if (fs.existsSync(fallbackPath)) {
    try { fs.unlinkSync(fallbackPath) } catch { /* ignore */ }
  }
}
