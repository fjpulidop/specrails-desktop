/**
 * workspace-resolution — the SINGLE gate for the relocate-artifacts-to-home
 * feature (DESKTOP STAGE 2). Every spawner cwd/env decision and every relocated
 * artifact-read site funnels through `resolveProjectExecution(...)`.
 *
 * THE GATE — a project is "relocated" iff BOTH hold:
 *   1. a registry entry exists for the repo (`resolveArtifacts(...).isLegacy ===
 *      false`), AND
 *   2. the workspace is actually populated by core — detected by the presence of
 *      `<workspace>/.specrails/specrails-version` (core installed there).
 *
 * When NOT relocated (every existing in-repo project, or a relocated registry
 * entry whose workspace core has not yet populated) the resolution is
 * BYTE-IDENTICAL to pre-stage-2 behaviour: cwd = project.path, repo-relative
 * artifact paths, empty env. This is what keeps stage 2 regression-safe for
 * existing users — only relocated projects diverge.
 *
 * When relocated:
 *   - cwd        = the workspace dir (core discovers sr-* agents there),
 *   - repoDir    = project.path (the user's repo; source/git/openspec stay here),
 *   - env        = { SPECRAILS_REPO_DIR: project.path, ... } so stage-3
 *                  `${SPECRAILS_REPO_DIR:-.}` re-pointing drives source/openspec/
 *                  git I/O back into the repo,
 *   - artifact paths point at the workspace (from the registry entry),
 *   - the `<workspace>/project` symlink is (re)created before returning so tools
 *     spawned from the workspace can still reach the repo by relative path.
 *
 * The workspace path is ALWAYS read from the registry entry (an adopted repo's
 * registry slug may differ from the desktop.sqlite slug); never recompute it
 * from a desktop slug.
 */

import fs from 'fs'
import path from 'path'
import { resolveArtifacts, type ResolvedArtifacts } from './artifact-registry'
import { ensureWorkspace } from './workspace-manager'
import { resolveTicketStoragePath } from './modules/specs/runtime/ticket-store'

/** Minimal project shape this module needs (a subset of `ProjectRow`). */
export interface ResolvableProject {
  /** desktop.sqlite slug. Optional: only a fallback for the workspace symlink
   *  when the registry entry (the authoritative slug) is somehow missing one. */
  slug?: string
  /** The user's repo path — the canonical key into the registry. */
  path: string
}

/** Resolved execution context for a project's AI-CLI spawns + artifact reads. */
export interface ProjectExecution {
  /** True when the project's artifacts are relocated AND the workspace is
   *  populated by core. False ⇒ legacy in-repo behaviour. */
  relocated: boolean
  /** Working directory to spawn the AI CLI from. workspace when relocated,
   *  else project.path. */
  cwd: string
  /** The user's repo. ALWAYS project.path — provenance/git/source reads use this,
   *  NEVER the workspace. */
  repoDir: string
  /** The workspace dir when relocated, else null. */
  workspaceDir: string | null
  /** Relocated artifact paths (workspace) when relocated; repo-relative legacy
   *  paths otherwise. */
  ticketsPath: string
  backlogConfigPath: string
  profilesDir: string
  pluginsStateDir: string
  fileSummariesDir: string
  /** `.specrails` root for the resolved layout. */
  specrailsDir: string
  stateDir: string
  /** Env vars to MERGE into the spawn env. Empty `{}` in legacy mode, except
   *  `SPECRAILS_TICKETS_PATH` for a new project Core is still assembling (its
   *  `ticketsPath` is then already the workspace store). */
  env: Record<string, string>
}

/** Marker file core writes into the workspace once it has installed there. The
 *  presence of this file is the "populated" half of the gate. */
const WORKSPACE_VERSION_MARKER = path.join('.specrails', 'specrails-version')

/** True when `<workspaceDir>/.specrails/specrails-version` exists (core has
 *  installed into the workspace). The legacy `.specrails-version` location is
 *  NOT a workspace marker (a bare workspace dir never has the dot-file form).
 *
 *  Bundled-framework layout: `assemble` SYMLINKS the providerDir subtrees
 *  (`agents/` per-file, `commands/`/`skills/`/`rules/` whole-dir) into the
 *  workspace but writes the `.specrails/specrails-version` marker as a REAL file
 *  (via core's `writeManifestFiles`). So "populated" depends only on the real
 *  marker — it is agnostic to whether the providerDir is a real dir or a tree of
 *  symlinks into `framework/current/<provider>/`. `fs.existsSync` resolves the
 *  marker (and would also resolve it through a symlinked `.specrails`, though the
 *  manifest layer is never linked). */
export function isWorkspacePopulated(workspaceDir: string): boolean {
  try {
    return fs.existsSync(path.join(workspaceDir, WORKSPACE_VERSION_MARKER))
  } catch {
    return false
  }
}

/**
 * THE GATE. Resolve how a project's AI CLIs should be spawned and where its
 * relocated artifacts live. Read-only with respect to the registry; the only
 * side effect (when relocated) is (re)creating the workspace `./project` symlink
 * via `ensureWorkspace`.
 */
export function resolveProjectExecution(
  project: ResolvableProject,
  home?: string,
): ProjectExecution {
  const repoDir = project.path
  let art: ResolvedArtifacts
  try {
    art = resolveArtifacts(project.path, { allocate: false }, home)
  } catch {
    // A registry read failure must never break a spawn — fall back to legacy.
    return legacyExecution(repoDir)
  }

  // Gate part 1: no registry entry ⇒ legacy.
  if (art.isLegacy) {
    return legacyExecution(repoDir)
  }

  // Gate part 2: registry entry exists but the workspace is NOT yet populated by
  // core ⇒ stay legacy (existing project that has a registry entry but whose
  // core install still lives in-repo). This is what keeps every existing
  // assertion valid: a registry entry alone never flips a project to relocated.
  if (!isWorkspacePopulated(art.workspaceDir)) {
    // A new project still being assembled already owns its workspace spec
    // store (see `resolveProjectTicketsPath`); everything else stays in-repo.
    const pending = pendingWorkspaceTicketsPath(project, art)
    return pending
      ? { ...legacyExecution(repoDir), ticketsPath: pending, env: { SPECRAILS_TICKETS_PATH: pending } }
      : legacyExecution(repoDir)
  }

  // Relocated. (Re)create the workspace `./project` symlink so tools spawned from
  // the workspace can still reach the repo. ALWAYS use the REGISTRY entry's slug
  // (an adopted repo's registry slug may differ from the desktop slug) so the
  // symlink lands in the same workspace dir core populated. Best-effort — a
  // symlink failure must not abort the spawn (ensureWorkspace falls back to
  // project-path.txt internally).
  const workspaceSlug = art.entry?.slug ?? project.slug
  try {
    if (workspaceSlug) ensureWorkspace(workspaceSlug, repoDir, home)
  } catch {
    /* non-fatal — ensureWorkspace already has its own fallbacks */
  }

  const env: Record<string, string> = {
    SPECRAILS_REPO_DIR: repoDir,
    SPECRAILS_WORKSPACE_DIR: art.workspaceDir,
    SPECRAILS_TICKETS_PATH: art.ticketsPath,
    SPECRAILS_STATE_DIR: art.stateDir,
    SPECRAILS_BACKLOG_CONFIG_PATH: art.backlogConfigPath,
    SPECRAILS_PROFILES_DIR: art.profilesDir,
  }

  return {
    relocated: true,
    cwd: art.workspaceDir,
    repoDir,
    workspaceDir: art.workspaceDir,
    ticketsPath: art.ticketsPath,
    backlogConfigPath: art.backlogConfigPath,
    profilesDir: art.profilesDir,
    pluginsStateDir: art.pluginsStateDir,
    fileSummariesDir: art.fileSummariesDir,
    specrailsDir: art.specrailsDir,
    stateDir: art.stateDir,
    env,
  }
}

/**
 * Base spawn env for a project's LOOP executors (rails / custom loops).
 *
 * Relocated projects need core's env-first artifact indirection
 * (`SPECRAILS_TICKETS_PATH` / `SPECRAILS_BACKLOG_CONFIG_PATH` /
 * `SPECRAILS_PROFILES_DIR` / `SPECRAILS_STATE_DIR` / `SPECRAILS_WORKSPACE_DIR`
 * → the workspace) even when the spawn cwd is NOT the workspace: an ISOLATED
 * rail spawns from its git WORKTREE, where the cwd-relative `${ENV:-legacy}`
 * defaults would resolve to nothing (`git worktree add` materializes only
 * tracked files). In particular `SPECRAILS_BACKLOG_CONFIG_PATH` MUST reach core
 * so it never falls through to its default `write_access:true` branch.
 *
 * `SPECRAILS_REPO_DIR` is intentionally OMITTED: it is PER-RUN (the worktree
 * for isolated runs — writes/git must land there — vs the repo for shared
 * runs) and is injected by the executors from each run's `repoDir`. Leaving it
 * here would leak the LIVE repo path into isolated shell steps.
 *
 * Legacy projects return `process.env` untouched — byte-identical behaviour.
 */
export function resolveLoopBaseEnv(
  project: ResolvableProject,
  home?: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const exec = resolveProjectExecution(project, home)
  if (!exec.relocated) return baseEnv
  const { SPECRAILS_REPO_DIR: _perRun, ...projectEnv } = exec.env
  return { ...baseEnv, ...projectEnv }
}

/**
 * The spec store a project reads and writes right now. Every ticket read and
 * write funnels through here so the board, the routes and the run settlement
 * agree on ONE file.
 *
 * A relocated project uses its workspace store. A project that is NOT yet
 * relocated normally uses its in-repo store, with one exception: a new project
 * whose workspace Core is still assembling (registry entry, no in-repo install,
 * no in-repo store yet) writes the workspace store from the start. Its gate
 * flips the moment Core writes the workspace marker, mid-assembly; a store
 * chosen by that gate split the specs created in the first minute across two
 * files, and the in-repo ones vanished from the board (their ids reused).
 * Writing the store the project ends up with removes the split, whatever the
 * timing. An in-repo store written before this rule is adopted by
 * `adoptPreAssemblySpecs` once the workspace is populated.
 */
export function resolveProjectTicketsPath(project: ResolvableProject, home?: string): string {
  const exec = resolveProjectExecution(project, home)
  // Relocated, or a new project still being assembled: the workspace store.
  if (exec.relocated || exec.env.SPECRAILS_TICKETS_PATH) return exec.ticketsPath
  return resolveTicketStoragePath(project.path)
}

/** The workspace store of a registered project Core has not populated yet;
 *  null when the project keeps (or will keep) its in-repo store. */
function pendingWorkspaceTicketsPath(project: ResolvableProject, art: ResolvedArtifacts): string | null {
  if (art.isLegacy || !art.ticketsPath) return null
  // A repository with its own in-repo install (or an integration contract that
  // may name its store) keeps the in-repo store on purpose.
  if (fs.existsSync(path.join(project.path, '.specrails', 'specrails-version')) || fs.existsSync(path.join(project.path, '.specrails-version'))) return null
  if (fs.existsSync(path.join(project.path, '.claude', 'integration-contract.json'))) return null
  // Specs already live in the repository (written before this rule): keep them
  // there until assembly adopts them, never split them.
  if (fs.existsSync(resolveTicketStoragePath(project.path))) return null
  return art.ticketsPath
}

/** Build the legacy (in-repo, byte-identical-to-today) execution. */
function legacyExecution(repoDir: string): ProjectExecution {
  const specrailsDir = path.join(repoDir, '.specrails')
  return {
    relocated: false,
    cwd: repoDir,
    repoDir,
    workspaceDir: null,
    ticketsPath: path.join(specrailsDir, 'local-tickets.json'),
    backlogConfigPath: path.join(specrailsDir, 'backlog-config.json'),
    profilesDir: path.join(specrailsDir, 'profiles'),
    pluginsStateDir: path.join(specrailsDir, 'plugins'),
    fileSummariesDir: path.join(specrailsDir, 'file-summaries'),
    specrailsDir,
    stateDir: path.join(repoDir, '.claude'),
    env: {},
  }
}
