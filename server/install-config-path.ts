// install-config-path — the SINGLE resolver for `install-config.yaml`.
//
// PRIMARY relocation fix: the install config is core's INPUT at project-creation
// time (the desktop-written YAML that core reads via `--from-config`). It used to
// be written into `<project.path>/.specrails/install-config.yaml`, which created
// a `.specrails/` directory inside the user's repo BEFORE relocation could flip
// on — the very leak the relocate-artifacts feature exists to prevent.
//
// It now lives in the per-project app-managed HOME dir
// `$HOME/.specrails/projects/<slug>/install-config.yaml`. That directory:
//   - always exists / can always be created (independent of whether the
//     workspace subdir has been populated by core yet), and
//   - is NEVER inside the user's repo, so a fresh setup creates ZERO `.specrails`
//     in the repo.
//
// This is deliberately NOT the workspace (`resolveProjectExecution`): the config
// is read at INSTALL time, before core populates the workspace and before the
// relocation gate flips. The HOME per-project dir is the one location guaranteed
// to be available across both the relocated and the non-bundled flows.
//
// The slug is allocated by `addProject` (desktop.sqlite) BEFORE any setup runs,
// so every install-config reader/writer has it. When a slug is somehow absent
// (defensive — e.g. a synthetic call path), we fall back to a deterministic tmp
// STAGING path keyed off the repo path — never the repo itself.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'

/** Minimal project shape the resolver needs. */
export interface InstallConfigProject {
  /** desktop.sqlite slug — present for every project registered via addProject. */
  slug?: string
  /** The user's repo path (only used to derive the tmp-staging fallback name). */
  path: string
}

/** `$HOME` override (mirrors `resolveHome` in artifact-registry / tests). */
function resolveHome(home?: string): string {
  return home ?? process.env.SPECRAILS_REGISTRY_HOME ?? os.homedir()
}

/** True when a slug is a safe single path segment (no separators / traversal). */
function isSafeSlug(slug: string | undefined): slug is string {
  return (
    typeof slug === 'string' &&
    slug.trim().length > 0 &&
    !slug.includes('/') &&
    !slug.includes('\\') &&
    !slug.includes('..')
  )
}

/** True when a provider id is a safe filename segment (registry ids are
 *  lowercase-kebab — `claude` / `codex` / `gemini`). */
function isSafeProvider(provider: string | undefined): provider is string {
  return typeof provider === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(provider)
}

/** The per-project app-managed HOME dir: `$HOME/.specrails/projects/<slug>`. */
export function projectHomeDir(slug: string, home?: string): string {
  return path.join(resolveHome(home), '.specrails', 'projects', slug)
}

/**
 * Resolve the install-config.yaml path for a project — the per-project HOME dir
 * when the slug is available (the normal case), else a deterministic tmp-staging
 * path keyed off the repo path. NEVER returns a path inside the user's repo.
 */
export function installConfigPath(project: InstallConfigProject, home?: string): string {
  if (isSafeSlug(project.slug)) {
    return path.join(projectHomeDir(project.slug, home), 'install-config.yaml')
  }
  // Defensive fallback: a stable tmp staging dir (NOT the repo) so a slug-less
  // call still never leaks into the user's tree. The hash keeps it per-repo; the
  // file keeps the canonical `install-config.yaml` basename.
  const hash = createHash('sha256').update(path.resolve(project.path)).digest('hex').slice(0, 16)
  return path.join(os.tmpdir(), `specrails-desktop-install-config-${hash}`, 'install-config.yaml')
}

/**
 * Resolve the PER-PROVIDER install-config path
 * (`<projectHome>/install-config.<provider>.yaml`).
 *
 * specrails-core's `install-config.yaml` carries exactly one `provider:` field
 * (it installs one provider per `init`), so a multi-provider project that ran
 * each provider's install in turn would clobber a single shared file down to the
 * last provider only. Writing one config per provider keeps every provider's
 * config — the install for provider X reads `install-config.<X>.yaml`.
 *
 * Falls back to the shared `installConfigPath` when `provider` is missing or not
 * a safe filename segment (so single-provider / legacy callers are unchanged).
 */
export function installConfigPathForProvider(
  project: InstallConfigProject,
  provider: string | undefined,
  home?: string,
): string {
  if (!isSafeProvider(provider)) return installConfigPath(project, home)
  const dir = isSafeSlug(project.slug)
    ? projectHomeDir(project.slug, home)
    : path.join(
        os.tmpdir(),
        `specrails-desktop-install-config-${createHash('sha256').update(path.resolve(project.path)).digest('hex').slice(0, 16)}`,
      )
  return path.join(dir, `install-config.${provider}.yaml`)
}

/** Ensure the parent directory of the install-config exists (idempotent). */
export function ensureInstallConfigDir(project: InstallConfigProject, home?: string): string {
  const file = installConfigPath(project, home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return file
}
