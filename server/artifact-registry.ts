/**
 * Shared artifact registry — the cross-tool contract that lets specrails-core
 * place, and specrails-desktop write/read, a repo's relocated artifacts OUTSIDE
 * the repo, under `$HOME/.specrails/projects/<slug>/workspace`.
 *
 * Single source of truth: `$HOME/.specrails/registry.json`, an inspectable,
 * schema-versioned JSON file keyed by the **canonical realpath of the repo**.
 * specrails-desktop is the PRIMARY writer (a projection of its `desktop.sqlite`);
 * specrails-core reads it and, when run standalone, allocates its own entry.
 *
 * This module is a port of specrails-core's `src/installer/util/registry.ts`.
 * The slug algorithm, canonical-key rule, atomic-write rule, lock protocol and
 * workspace layout here MUST stay byte-identical to core — the correctness of
 * the cross-tool contract depends on both tools resolving the same repo to the
 * same paths. Everything is synchronous to match the installer's sync flow and
 * to keep desktop's startup reconcile cheap.
 *
 * Beyond the ported core surface, this module adds the desktop-only writers that
 * project `desktop.sqlite` into the registry: `mirrorProjectEntry`,
 * `removeRegistryEntry`, and `reconcileFromProjects`.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import os from 'os'
import path from 'path'

/** Registry schema version. A reader that sees a higher value MUST treat all
 *  entries as absent (legacy fallback), never mis-parse. */
export const REGISTRY_SCHEMA_VERSION = 1

/** Who owns/allocated an entry. Encodes the single-writer-at-a-time rule. */
export type RegistrySource = 'desktop' | 'core-standalone'

/** One repo's relocated-artifact locations. All paths are absolute and in the
 *  host platform's native separator; consumers treat them as opaque. */
export interface ProjectEntry {
  /** The canonical realpath of the repo (mirror of the map key). */
  repoPath: string
  /** Shared slug — MUST equal desktop.sqlite `projects.slug` for the same repo. */
  slug: string
  /** `$HOME/.specrails/projects/<slug>/workspace` — root of all relocated artifacts. */
  workspaceDir: string
  /** The dir core treats as its `.specrails`/install root instead of repoRoot (= workspaceDir). */
  artifactRoot: string
  /** Always the repo (= repoPath); carries the `openspec/**` + worktree carve-outs. */
  codeRoot: string
  /** Runtime-state base (agent-memory, pipeline-state, …). Injected as SPECRAILS_STATE_DIR. */
  stateDir: string
  /** Absolute path to the relocated local-tickets.json. Injected as SPECRAILS_TICKETS_PATH. */
  ticketsPath: string
  /** Absolute path to backlog-config.json (Jira read-only switch). Injected as SPECRAILS_BACKLOG_CONFIG_PATH. */
  backlogConfigPath: string
  /** Relocated `.specrails/profiles/`. Injected as SPECRAILS_PROFILES_DIR. */
  profilesDir: string
  /** Relocated `.specrails/plugins/` (desktop-only; present for inspectability). */
  pluginsStateDir: string
  /** Relocated `.specrails/file-summaries/` (desktop-only). */
  fileSummariesDir: string
  /** Installed providers; mirror of desktop.sqlite `projects.providers`. */
  providers: string[]
  /** providers[0]; mirror of desktop.sqlite `projects.provider`. */
  primaryProvider: string
  /** The `specrails-version` pin (name/format frozen; only location moved). */
  coreVersion?: string
  createdAt?: string
  lastInstallAt?: string
  /** Last time this entry was written/updated by desktop. */
  updatedAt?: string
  /** Single-owner-at-a-time marker; governs reconciliation. */
  source: RegistrySource
  /** desktop.sqlite projects.id when source='desktop', for robust repo-move re-link. */
  desktopProjectId?: string
}

/** On-disk shape of `registry.json`. */
export interface RegistryFile {
  schemaVersion: number
  generator?: string
  updatedAt?: string
  /** Map: canonical-repo-key -> ProjectEntry. */
  projects: Record<string, ProjectEntry>
}

/**
 * Slug derivation — byte-identical to `slugify` in `server/desktop-router.ts`
 * (and to specrails-core's port). Do NOT "improve" it; parity is the contract.
 */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** `$HOME` for the registry, overridable for tests. Honors the
 *  `SPECRAILS_REGISTRY_HOME` env var (mirrors core) when no explicit override
 *  is passed, so the desktop-side wiring can be redirected in tests without
 *  threading a `home` argument through every call site. */
export function resolveHome(home?: string): string {
  return home ?? process.env.SPECRAILS_REGISTRY_HOME ?? os.homedir()
}

/** Absolute path to `registry.json`. */
export function registryPath(home?: string): string {
  return path.join(resolveHome(home), '.specrails', 'registry.json')
}

/** Absolute path to the advisory lock file. */
export function lockPath(home?: string): string {
  return registryPath(home) + '.lock'
}

/** `fs.realpathSync` that falls back to the resolved-but-unreal path on error
 *  (the path may not exist yet, or be on a volume that rejects realpath). */
export function realpathSafe(abs: string): string {
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** Case-fold the key on case-insensitive platforms (macOS, Windows) so two
 *  spellings of the same path map to one entry. The stored `repoPath` keeps
 *  its canonical case; only the index key is folded. */
export function normalizeKey(canon: string): string {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return canon.toLowerCase()
  }
  return canon
}

/** Canonical repo path: resolve to absolute, then realpath (collapses symlinks). */
export function canonicalizeRepoPath(repoPathInput: string): string {
  return realpathSafe(path.resolve(repoPathInput))
}

/** The per-project sub-path layout under a workspace dir. Single source of the
 *  layout so writer and (allocation) reader never disagree. */
export function workspaceLayout(
  home: string,
  slug: string,
  canon: string,
): Omit<
  ProjectEntry,
  | 'providers'
  | 'primaryProvider'
  | 'coreVersion'
  | 'createdAt'
  | 'lastInstallAt'
  | 'updatedAt'
  | 'source'
  | 'desktopProjectId'
> {
  const workspaceDir = path.join(resolveHome(home), '.specrails', 'projects', slug, 'workspace')
  const specrailsDir = path.join(workspaceDir, '.specrails')
  return {
    repoPath: canon,
    slug,
    workspaceDir,
    artifactRoot: workspaceDir,
    codeRoot: canon,
    stateDir: path.join(workspaceDir, '.claude'),
    ticketsPath: path.join(specrailsDir, 'local-tickets.json'),
    backlogConfigPath: path.join(specrailsDir, 'backlog-config.json'),
    profilesDir: path.join(specrailsDir, 'profiles'),
    pluginsStateDir: path.join(specrailsDir, 'plugins'),
    fileSummariesDir: path.join(specrailsDir, 'file-summaries'),
  }
}

/** The path/identity fields a usable entry MUST carry. A hand-edited or
 *  partially-written entry missing ANY of these is treated as ABSENT (legacy
 *  fallback) rather than returned with `undefined` path fields that would crash
 *  a downstream `fs` call or silently point at `undefined/...`. */
const REQUIRED_ENTRY_FIELDS: Array<keyof ProjectEntry> = [
  'repoPath',
  'slug',
  'workspaceDir',
  'artifactRoot',
  'codeRoot',
  'stateDir',
  'ticketsPath',
  'backlogConfigPath',
  'profilesDir',
  'pluginsStateDir',
  'fileSummariesDir',
]

/**
 * True only when `entry` carries every required path/identity field as a
 * non-empty string. Guards against a hand-edited registry.json with a missing
 * key (which would otherwise surface as `ticketsPath: undefined`).
 */
export function isCompleteEntry(entry: unknown): entry is ProjectEntry {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  for (const f of REQUIRED_ENTRY_FIELDS) {
    const v = e[f as string]
    if (typeof v !== 'string' || v.length === 0) return false
  }
  return true
}

/**
 * Total, fail-open read. A missing file, a parse error, or a `schemaVersion`
 * greater than we understand all yield an empty registry, so a caller treats
 * it as "no entry" and (if writing) writes a fresh, understood entry rather
 * than crashing. Biases toward availability over strict consistency — correct
 * for a local, inspectable file.
 */
export function readRegistryOrEmpty(home?: string): RegistryFile {
  const empty: RegistryFile = { schemaVersion: REGISTRY_SCHEMA_VERSION, projects: {} }
  const p = registryPath(home)
  if (!existsSync(p)) return empty
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as RegistryFile
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.schemaVersion !== 'number' ||
      parsed.schemaVersion > REGISTRY_SCHEMA_VERSION ||
      typeof parsed.projects !== 'object' ||
      parsed.projects === null
    ) {
      return empty
    }
    return parsed
  } catch {
    return empty
  }
}

/** Write `data` to `filePath` atomically: temp file in the same dir, fsync,
 *  rename. A reader (even without the lock) only ever sees a complete old or
 *  new file — the lock serialises writers, the rename protects readers. */
export function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath)
  mkdirSync(dir, { recursive: true })
  // Deterministic-but-unique temp name (no Math.random/Date dependency for the
  // name itself); collisions are impossible because the lock serialises writers.
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`)
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // Windows: renaming over an EXISTING destination held open by a reader (the
  // bundled core reads registry.json WITHOUT the lock by contract), an AV
  // scanner, or a concurrent reader fails transiently with EPERM/EACCES/EBUSY.
  // POSIX rename-over is atomic and never hits this. Bounded retry on Windows
  // only; rethrow the last error so the caller's try/catch still surfaces it.
  let lastErr: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmp, filePath)
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException).code
      const retryable = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
      if (!retryable) throw err
      syncSleep(20 * (attempt + 1))
    }
  }
  try { unlinkSync(tmp) } catch { /* best-effort temp cleanup */ }
  throw lastErr
}

/** Synchronous sleep without busy-spinning the CPU. */
function syncSleep(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, ms)
}

const LOCK_STALE_MS = 30_000
const LOCK_SPIN_MS = 50
const LOCK_MAX_WAIT_MS = 2_000

/**
 * Run `fn` while holding an advisory lock over the registry. Mutual exclusion
 * is an exclusive-create lock file (`open(..., 'wx')`) with bounded spin-retry
 * and stale-lock breaking (a lock whose mtime exceeds the TTL is reclaimed —
 * covers a crashed writer). Read-only callers never take the lock.
 */
export function withFileLock<T>(home: string | undefined, fn: () => T): T {
  const lp = lockPath(home)
  mkdirSync(path.dirname(lp), { recursive: true })
  let fd: number | undefined
  // Unique per-acquisition token written INTO the lock file. On release we
  // re-read the file and only unlink it when the token still matches OURS — so a
  // writer whose lock was stale-broken (TTL-reclaimed) by another writer never
  // deletes the NEW owner's lock out from under it (which would let a third
  // writer acquire concurrently and race the read-modify-write).
  const ourToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + LOCK_MAX_WAIT_MS
  for (;;) {
    try {
      fd = openSync(lp, 'wx')
      // Write our token + fsync so a concurrent reader sees a complete token.
      try {
        writeFileSync(fd, ourToken)
        fsyncSync(fd)
      } catch {
        /* best-effort — the lock still serialises via exclusive-create */
      }
      break
    } catch {
      // Lock held — break it if stale, otherwise spin until the deadline.
      try {
        const age = Date.now() - statSync(lp).mtimeMs
        if (age > LOCK_STALE_MS) {
          unlinkSync(lp)
          continue
        }
      } catch {
        // lock vanished between open and stat — retry immediately
        continue
      }
      if (Date.now() >= deadline) {
        // FAIL-CLOSED (parity with specrails-core): rather than proceed WITHOUT
        // the lock — which would let two writers race a read-modify-write and
        // clobber each other's entries — throw. Every caller wraps this in a
        // non-fatal try/catch (a missing/un-updated entry is recreated on the
        // next reconcile), so failing closed loses nothing while preserving the
        // single-writer invariant.
        throw new Error(
          `artifact-registry: could not acquire lock ${lp} within ${LOCK_MAX_WAIT_MS}ms`,
        )
      }
      syncSleep(LOCK_SPIN_MS)
    }
  }
  try {
    return fn()
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
      // Only unlink the lock when it still carries OUR token. If we were
      // stale-broken and another writer now owns the file, its token differs and
      // we leave it alone (a missing/unreadable file ⇒ already gone ⇒ no-op).
      try {
        const onDisk = readFileSync(lp, 'utf8')
        if (onDisk === ourToken) {
          unlinkSync(lp)
        }
      } catch {
        /* already removed / unreadable — nothing to clean up */
      }
    }
  }
}

// ─── Desktop-only writers (the projection of desktop.sqlite into the registry) ──

export interface MirrorProjectInput {
  /** The user's repo path (may be a symlink / relative; canonicalized here). */
  repoPath: string
  /** Shared slug — MUST equal desktop.sqlite `projects.slug`. */
  slug: string
  /** Installed providers (mirror of `projects.providers`). */
  providers?: string[]
  /** Primary provider (mirror of `projects.provider`). Defaults to providers[0]. */
  primaryProvider?: string
  coreVersion?: string
  /** desktop.sqlite `projects.id` (for robust repo-move re-link). */
  desktopProjectId?: string
}

function normalizeProviders(
  providers: string[] | undefined,
  primary: string | undefined,
): { providers: string[]; primaryProvider: string } {
  let list = providers && providers.length > 0 ? providers.slice() : undefined
  if (!list || list.length === 0) {
    list = [primary && primary.length > 0 ? primary : 'claude']
  }
  const primaryProvider = primary && primary.length > 0 ? primary : list[0]!
  return { providers: list, primaryProvider }
}

/**
 * Build (or refresh) a desktop-owned entry for a repo, preserving artifact-
 * location identity.
 *
 * INVARIANT: a `slug` + `workspaceDir` are **immutable once an entry exists**
 * (the contract's "el slug queda congelado para siempre"). When ANY entry
 * already exists for this repo — whether a prior desktop entry OR a
 * `core-standalone` entry being adopted (possibly under a core-allocated slug
 * that differs from desktop's) — we preserve EVERY path field verbatim and
 * refresh only the mutable projection fields (providers, coreVersion, source,
 * timestamps, desktopProjectId). Re-deriving the layout from `desiredSlug`
 * would re-home an adopted/renamed entry and STRAND its on-disk artifacts.
 *
 * Only when no entry exists do we allocate fresh paths from `desiredSlug`.
 *
 * `touchInstall` = true for an install event (addProject) ⇒ bump
 * `lastInstallAt`; false for a startup reconcile ⇒ leave it.
 */
function buildMirroredEntry(
  existing: ProjectEntry | undefined,
  canon: string,
  desiredSlug: string,
  input: { providers: string[]; primaryProvider: string; coreVersion?: string; desktopProjectId?: string },
  now: string,
  touchInstall: boolean,
  home?: string,
): ProjectEntry {
  let entry: ProjectEntry
  if (existing) {
    entry = {
      ...existing,
      providers: input.providers,
      primaryProvider: input.primaryProvider,
      coreVersion: input.coreVersion ?? existing.coreVersion,
      source: 'desktop',
      createdAt: existing.createdAt ?? now,
      lastInstallAt: touchInstall ? now : (existing.lastInstallAt ?? now),
      updatedAt: now,
    }
  } else {
    const layout = workspaceLayout(home ?? resolveHome(home), desiredSlug, canon)
    entry = {
      ...layout,
      providers: input.providers,
      primaryProvider: input.primaryProvider,
      coreVersion: input.coreVersion,
      source: 'desktop',
      createdAt: now,
      lastInstallAt: now,
      updatedAt: now,
    }
  }
  if (input.desktopProjectId) entry.desktopProjectId = input.desktopProjectId
  return entry
}

/**
 * Upsert a desktop-owned entry for a repo, keyed by the canonical repo path.
 *
 * Behaviour:
 *  - new key ⇒ insert a fresh `source:'desktop'` entry, computing every sub-path
 *    from `workspaceLayout` with the desktop slug.
 *  - existing `source:'desktop'` entry ⇒ update providers/coreVersion/paths,
 *    preserve `createdAt`, refresh `lastInstallAt`/`updatedAt`.
 *  - existing `source:'core-standalone'` entry ⇒ ADOPT it: keep its slug +
 *    workspaceDir (core already materialised artifacts there), flip
 *    `source:'desktop'`, attach `desktopProjectId`. The workspace location is
 *    immutable post-adoption so we never strand on-disk artifacts.
 *
 * Runs under the file lock with a re-read so concurrent writers serialise.
 */
export function mirrorProjectEntry(input: MirrorProjectInput, home?: string): ProjectEntry {
  const canon = canonicalizeRepoPath(input.repoPath)
  const key = normalizeKey(canon)
  const { providers, primaryProvider } = normalizeProviders(input.providers, input.primaryProvider)

  return withFileLock(home, () => {
    const reg = readRegistryOrEmpty(home)
    const now = new Date().toISOString()
    const existing = reg.projects[key]

    const entry = buildMirroredEntry(
      existing,
      canon,
      input.slug,
      { providers, primaryProvider, coreVersion: input.coreVersion, desktopProjectId: input.desktopProjectId },
      now,
      true,
      home,
    )

    reg.projects[key] = entry
    reg.schemaVersion = REGISTRY_SCHEMA_VERSION
    reg.generator = 'specrails-desktop'
    reg.updatedAt = now
    atomicWrite(registryPath(home), JSON.stringify(reg, null, 2) + '\n')
    return entry
  })
}

// ─── Read-side resolution (the gate primitive for spawn/artifact routing) ──────

/**
 * Resolved artifact locations for a repo. `isLegacy` is the GATE that the whole
 * relocation feature pivots on:
 *  - `isLegacy: true`  ⇒ NO registry entry exists for this repo. Every path is
 *    repo-relative (`<repoPath>/.specrails/...`) — byte-identical to pre-
 *    relocation behaviour. This is the default for every existing in-repo
 *    project and the safe fallback when the registry is unreadable.
 *  - `isLegacy: false` ⇒ a registry entry exists. `workspaceDir` and the
 *    artifact sub-paths point OUTSIDE the repo (under
 *    `~/.specrails/projects/<slug>/workspace`). `codeRoot`/`repoPath` still
 *    point at the user's repo (source + git + openspec stay in-tree).
 *
 * IMPORTANT: paths are ALWAYS read from the registry entry (the slug a repo was
 * adopted/allocated under may differ from desktop's slug). Never recompute the
 * workspace path from a desktop slug — go through this function.
 */
export interface ResolvedArtifacts {
  /** True when no registry entry exists ⇒ repo-relative legacy layout. */
  isLegacy: boolean
  /** The user's repo (canonical realpath). Source/git/openspec root. */
  repoPath: string
  /** Relocation target (registry entry) or `<repoPath>` in legacy mode. */
  workspaceDir: string
  /** `.specrails` root: `<workspaceDir>/.specrails`. */
  specrailsDir: string
  ticketsPath: string
  backlogConfigPath: string
  profilesDir: string
  pluginsStateDir: string
  fileSummariesDir: string
  /** Runtime-state base (agent-memory etc.); `<workspaceDir>/.claude` relocated. */
  stateDir: string
  /** The matched registry entry, present only when `isLegacy === false`. */
  entry?: ProjectEntry
}

export interface ResolveArtifactsOptions {
  /** Reserved for future allocate-on-read behaviour; currently READ-ONLY.
   *  When false (default) a missing entry yields a legacy resolution — it never
   *  writes the registry. Allocation stays an explicit `mirrorProjectEntry`. */
  allocate?: boolean
}

/**
 * Resolve a repo's artifact locations from the registry (read-only). Returns a
 * legacy (repo-relative) resolution when no entry exists, so callers can treat
 * the result uniformly. NEVER mutates the registry.
 */
export function resolveArtifacts(
  repoPath: string,
  _options?: ResolveArtifactsOptions,
  home?: string,
): ResolvedArtifacts {
  const canon = canonicalizeRepoPath(repoPath)
  const key = normalizeKey(canon)
  const reg = readRegistryOrEmpty(home)
  const rawEntry = reg.projects[key]
  // A hand-edited / partially-written entry missing a path field must fall back
  // to legacy (repo-relative) — never return `ticketsPath: undefined`.
  const entry = isCompleteEntry(rawEntry) ? rawEntry : undefined

  if (!entry) {
    // Legacy: every artifact lives under the repo's own `.specrails`.
    const specrailsDir = path.join(canon, '.specrails')
    return {
      isLegacy: true,
      repoPath: canon,
      workspaceDir: canon,
      specrailsDir,
      ticketsPath: path.join(specrailsDir, 'local-tickets.json'),
      backlogConfigPath: path.join(specrailsDir, 'backlog-config.json'),
      profilesDir: path.join(specrailsDir, 'profiles'),
      pluginsStateDir: path.join(specrailsDir, 'plugins'),
      fileSummariesDir: path.join(specrailsDir, 'file-summaries'),
      stateDir: path.join(canon, '.claude'),
    }
  }

  return {
    isLegacy: false,
    repoPath: entry.codeRoot || canon,
    workspaceDir: entry.workspaceDir,
    specrailsDir: path.join(entry.workspaceDir, '.specrails'),
    ticketsPath: entry.ticketsPath,
    backlogConfigPath: entry.backlogConfigPath,
    profilesDir: entry.profilesDir,
    pluginsStateDir: entry.pluginsStateDir,
    fileSummariesDir: entry.fileSummariesDir,
    stateDir: entry.stateDir,
    entry,
  }
}

/** Delete a repo's registry entry (no-op if absent). Keyed by canonical path. */
export function removeRegistryEntry(repoPath: string, home?: string): void {
  const canon = canonicalizeRepoPath(repoPath)
  const key = normalizeKey(canon)
  withFileLock(home, () => {
    const reg = readRegistryOrEmpty(home)
    if (!reg.projects[key]) return
    delete reg.projects[key]
    reg.schemaVersion = REGISTRY_SCHEMA_VERSION
    reg.generator = 'specrails-desktop'
    reg.updatedAt = new Date().toISOString()
    atomicWrite(registryPath(home), JSON.stringify(reg, null, 2) + '\n')
  })
}

export interface ReconcileProjectInput {
  repoPath: string
  slug: string
  providers?: string[]
  primaryProvider?: string
  coreVersion?: string
  desktopProjectId?: string
}

/**
 * MERGE-upsert one entry per desktop project, leaving entries NOT owned by
 * desktop (`source:'core-standalone'` for repos desktop doesn't track)
 * UNTOUCHED. Never wholesale-wipes the registry. Run once at startup to
 * self-heal a hand-edited / partially-written registry, and to backfill
 * entries for projects added before the mirror existed.
 *
 * Adoption of a core-standalone entry happens exactly as in `mirrorProjectEntry`
 * when a desktop project's canonical repo path matches a core-standalone key.
 *
 * All upserts happen under a single lock so the file is read + rewritten once.
 */
export function reconcileFromProjects(projects: ReconcileProjectInput[], home?: string): void {
  if (projects.length === 0) return
  withFileLock(home, () => {
    const reg = readRegistryOrEmpty(home)
    const now = new Date().toISOString()
    let changed = false

    for (const p of projects) {
      const canon = canonicalizeRepoPath(p.repoPath)
      const key = normalizeKey(canon)
      const { providers, primaryProvider } = normalizeProviders(p.providers, p.primaryProvider)
      const existing = reg.projects[key]

      // Startup reconcile (touchInstall=false): preserve the immutable
      // slug/workspace of any existing entry — never re-home an adopted or
      // prior-desktop entry (that would strand on-disk artifacts every boot).
      const entry = buildMirroredEntry(
        existing,
        canon,
        p.slug,
        { providers, primaryProvider, coreVersion: p.coreVersion, desktopProjectId: p.desktopProjectId },
        now,
        false,
        home,
      )

      reg.projects[key] = entry
      changed = true
    }

    if (!changed) return
    reg.schemaVersion = REGISTRY_SCHEMA_VERSION
    reg.generator = 'specrails-desktop'
    reg.updatedAt = now
    atomicWrite(registryPath(home), JSON.stringify(reg, null, 2) + '\n')
  })
}
