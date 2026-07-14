import fs from 'fs'
import path from 'path'

import { FrameworkManager, frameworkRoot } from './framework-manager'
import { migrateWorkspaceToSymlinks } from './framework-migration'
import { resolveHome } from './artifact-registry'
import { mergeSpecrailsIntoWorkspaceMcp } from './agent-mcp-config'

/** Highest-first semver-ish sort for framework version dir names. */
function compareFrameworkVersionDesc(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10))
  const pb = b.split('.').map((n) => parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return y - x
  }
  return 0
}

/**
 * Windows repair: ensure the workspace's `<providerDir>/agents` holds the
 * framework's `sr-*` agent definitions, copied from the REAL versioned framework
 * dir (`~/.specrails/framework/<version>/<providerDir>/agents`).
 *
 * Why: on Windows the `framework/current` JUNCTION can be untraversable by Node's
 * `fs` ("UNKNOWN: scandir" / "untrusted mount point"); the bundled core's
 * `assemble` sources the agents THROUGH `current`, so `linkAgentFiles` reads
 * nothing and the workspace ends up with NO `sr-*` agents — the implement
 * pipeline then has no sub-agents to delegate to (architect/developer/reviewer)
 * and silently runs everything inline. The versioned dir is a real, traversable
 * directory, so we read it directly. (The proper fix lives in core's `assemble`;
 * this repairs already-broken installs without waiting for a core republish, and
 * mirrors exactly what the fixed core does on Windows — copy from the version
 * dir.) `assemble` never re-runs on a rail spawn, so a workspace broken at setup
 * stays broken; this runs per rail spawn to self-heal it.
 *
 * NO-OP on POSIX (per-file symlinks already populate the workspace correctly;
 * byte-identical). Additive (never touches user `custom-*.md`) + idempotent.
 * Returns the number of agents copied.
 */
/** Newest REAL framework version dir under the root — resolved by LISTING (not
 *  via the `current` junction, which is the very thing that may be untraversable
 *  on Windows). Null when the framework isn't materialized. */
function newestFrameworkVersion(root: string): string | null {
  try {
    return fs
      .readdirSync(root)
      .filter((n) => /^\d+\.\d+\.\d+$/.test(n))
      .sort(compareFrameworkVersionDesc)[0] ?? null
  } catch {
    return null
  }
}

export function ensureFrameworkAgents(workspaceDir: string, providerDir: string, home?: string): number {
  if (process.platform !== 'win32') return 0
  const root = frameworkRoot(home)
  const version = newestFrameworkVersion(root)
  if (!version) return 0
  const src = path.join(root, version, providerDir, 'agents')
  let entries: string[]
  try {
    entries = fs.readdirSync(src)
  } catch {
    return 0 // framework agents not materialized for this provider
  }
  const dest = path.join(workspaceDir, providerDir, 'agents')
  let copied = 0
  for (const name of entries) {
    // Framework agents only; never clobber a user/plugin `custom-*.md`.
    if (!name.endsWith('.md') || name.startsWith('custom-')) continue
    const destFile = path.join(dest, name)
    if (fs.existsSync(destFile)) continue
    try {
      fs.mkdirSync(dest, { recursive: true })
      fs.copyFileSync(path.join(src, name), destFile)
      copied += 1
    } catch {
      /* best-effort per file — one failure must never abort the rail spawn */
    }
  }
  return copied
}

/** The framework subtrees `assemble` installs as a single DIR-symlink into
 *  `current/<provider>/` (unlike agents, which are per-file). `/specrails:*`
 *  slash commands live under `commands/`. (`/opsx:*` is NOT framework — the
 *  external OpenSpec binary installs it into the REPO's provider dir; isolated
 *  rails receive it via the worktree overlay's repo fallback root.) */
const DIR_LINKED_SUBTREES = ['commands', 'skills', 'rules'] as const

/**
 * Windows repair for the DIR-symlinked framework subtrees (`commands`, `skills`,
 * `rules`) — the sibling of `ensureFrameworkAgents` for the whole-directory links.
 *
 * Why a SEPARATE repair: agents are linked per-file, so a broken `current`
 * junction leaves an EMPTY-but-real `agents/` dir that `ensureFrameworkAgents`
 * refills file-by-file. `commands`/`skills`/`rules` are instead a single
 * dir-symlink INTO `current/<provider>/<subtree>`; when the `current` junction is
 * untraversable by the sidecar (the documented Windows failure), that link is
 * unreadable and the workspace has NO `/specrails:*` commands at all — the claude
 * CLI then reports `Unknown command: /specrails:implement`. This replaces an
 * unreadable/missing link with a REAL recursively-copied directory read straight
 * from the versioned framework dir (never through `current`).
 *
 * SAFETY: only heals when the dest is missing OR unreadable OR empty — a dest
 * that lists content is a working link/dir and is left untouched, so a working
 * symlink's real target is NEVER deleted through. NO-OP on POSIX (per-provider
 * symlinks resolve normally). Best-effort + idempotent. Returns the count healed.
 */
export function ensureFrameworkCommandSubtrees(workspaceDir: string, providerDir: string, home?: string): number {
  if (process.platform !== 'win32') return 0
  const root = frameworkRoot(home)
  const version = newestFrameworkVersion(root)
  if (!version) return 0
  let healed = 0
  for (const subtree of DIR_LINKED_SUBTREES) {
    const src = path.join(root, version, providerDir, subtree)
    // The versioned source must be a real, readable, non-empty dir to heal from.
    let srcEntries: string[]
    try {
      srcEntries = fs.readdirSync(src)
    } catch {
      continue // this provider/version ships no such subtree
    }
    if (srcEntries.length === 0) continue

    const dest = path.join(workspaceDir, providerDir, subtree)
    // A dest that lists entries is a working link/dir → leave it (never risk
    // deleting through a live symlink). Heal only when unreadable / empty.
    try {
      if (fs.readdirSync(dest).length > 0) continue
    } catch {
      /* unreadable (broken/untraversable link, or missing) → heal below */
    }

    // Remove the broken link / empty dir. We only reach here when there is no
    // traversable content, so no real framework files can be destroyed. Layered
    // removal because a Windows dir-junction resists unlink/rmdir differently.
    try {
      const st = fs.lstatSync(dest)
      if (st.isSymbolicLink()) {
        fs.unlinkSync(dest)
      } else {
        fs.rmSync(dest, { recursive: true, force: true })
      }
    } catch {
      try { fs.rmdirSync(dest) } catch {
        try { fs.rmSync(dest, { recursive: true, force: true }) } catch { /* dest may be absent — fine */ }
      }
    }

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.cpSync(src, dest, { recursive: true })
      healed += 1
    } catch {
      /* best-effort per subtree — a copy failure must never abort the spawn */
    }
  }
  return healed
}

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
  ensureOpenspecLink(ws, projectPath)
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

  // Part A: make the Specrails MCP available to this project's own AI spawns by
  // merging a `specrails` server into the workspace .mcp.json (app-managed, never
  // the repo). Best-effort: a failure here must not break workspace assembly.
  try {
    const port = Number(process.env.SPECRAILS_MCP_PORT || process.env.SPECRAILS_PORT || 4200)
    mergeSpecrailsIntoWorkspaceMcp(ws, port)
  } catch {
    /* non-fatal */
  }

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

  // Unlink the carve-out links BEFORE the recursive remove so the user's repo is
  // never followed/deleted: `project` → the repo, and `openspec` → the repo's
  // openspec carve-out. (POSIX symlinks unlink; Windows junctions rmdir.)
  for (const name of ['project', 'openspec']) {
    const linkPath = path.join(ws, name)
    try {
      const st = fs.lstatSync(linkPath)
      if (st.isSymbolicLink() || (process.platform === 'win32' && st.isDirectory())) {
        try { fs.unlinkSync(linkPath) } catch {
          try { fs.rmdirSync(linkPath) } catch { /* best-effort */ }
        }
      }
    } catch {
      /* link may not exist */
    }
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

/**
 * Ensure `<ws>/openspec` is a LINK to `<repo>/openspec` — the openspec carve-out.
 *
 * openspec is a repo-resident deliverable (CLAUDE.md: "openspec/** … the versioned
 * spec deliverable … repo-relative by design"). For specrails-core's own slash
 * commands the `${SPECRAILS_REPO_DIR:-.}` indirection re-points openspec I/O to the
 * repo — but the EXTERNAL `openspec` binary (invoked as `openspec new change` /
 * `openspec archive` by the opsx lifecycle) does NOT read that env var; it writes
 * relative to its cwd. Since relocated rails/loops spawn with cwd = the WORKSPACE,
 * without this link every `openspec` write would strand the change under
 * `~/.specrails/projects/<slug>/workspace/openspec` instead of the user's repo.
 *
 * Mirrors `ensureProjectLink` (symlink on POSIX, junction on Windows) and adds a
 * one-time, NON-DESTRUCTIVE migration: a pre-carve-out workspace that already holds
 * a REAL `openspec/` dir (created by the binary writing to the workspace cwd) has
 * its contents rescued into the repo — never clobbering the repo's own files —
 * before the dir is replaced by the link. Idempotent: a no-op once the correct
 * link exists. Best-effort throughout — a link failure must never abort a spawn.
 */
function ensureOpenspecLink(cwd: string, projectPath: string): void {
  const linkPath = path.join(cwd, 'openspec')
  const repoOpenspec = path.join(projectPath, 'openspec')

  try {
    const st = fs.lstatSync(linkPath)
    if (st.isSymbolicLink()) {
      const current = fs.readlinkSync(linkPath)
      if (path.resolve(cwd, current) === path.resolve(repoOpenspec)) return // already correct
      try { fs.unlinkSync(linkPath) } catch { /* replaced below */ }
    } else if (st.isDirectory()) {
      // Pre-carve-out workspace: a real openspec/ dir the binary wrote to the
      // workspace cwd. Rescue its contents into the repo, then replace with a link.
      mergeDirInto(linkPath, repoOpenspec)
      try { fs.rmSync(linkPath, { recursive: true, force: true }) } catch { return }
    } else {
      try { fs.unlinkSync(linkPath) } catch { return }
    }
  } catch {
    /* does not exist — create below */
  }

  // The carve-out target must exist for the link to resolve (the binary expects to
  // write under it). openspec/** is an intentional repo carve-out, so creating it
  // does not violate the pristine-repo guarantee.
  try { fs.mkdirSync(repoOpenspec, { recursive: true }) } catch { /* best-effort */ }

  if (process.platform === 'win32') {
    try { fs.symlinkSync(repoOpenspec, linkPath, 'junction'); return } catch { /* fall through to POSIX symlink */ }
  }
  try { fs.symlinkSync(repoOpenspec, linkPath) } catch { /* best-effort: a failed link just means the binary writes a fresh workspace dir next run */ }
}

/**
 * Recursively copy `src` into `dest`, creating directories and copying only files
 * that do NOT already exist in `dest` (the repo's own copy always wins). Used by
 * the openspec carve-out migration to rescue workspace-stranded artifacts into the
 * repo without overwriting committed content. Best-effort per entry.
 */
function mergeDirInto(src: string, dest: string): void {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(src, { withFileTypes: true }) } catch { return }
  try { fs.mkdirSync(dest, { recursive: true }) } catch { /* best-effort */ }
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) {
      mergeDirInto(s, d)
    } else if (e.isSymbolicLink()) {
      if (!fs.existsSync(d)) { try { fs.symlinkSync(fs.readlinkSync(s), d) } catch { /* skip */ } }
    } else if (!fs.existsSync(d)) {
      try { fs.copyFileSync(s, d) } catch { /* skip */ }
    }
  }
}
