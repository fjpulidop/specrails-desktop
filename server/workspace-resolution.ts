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
  /** Env vars to MERGE into the spawn env. Empty `{}` in legacy mode. */
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
    return legacyExecution(repoDir)
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
