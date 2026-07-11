/**
 * Per-run worktree overlay — materializes a project's framework surface INTO an
 * isolated rail worktree.
 *
 * Why: `git worktree add` materializes only TRACKED files. A RELOCATED project's
 * framework surface (`.claude/commands/specrails/*.md`, the `sr-*` agents,
 * skills, rules, `.mcp.json`, the seeded instruction file) lives in
 * `~/.specrails/projects/<slug>/workspace/`, NOT the repo — so a worktree spawn
 * finds no `/specrails:*` commands and the claude CLI reports
 * `Unknown command: /specrails:implement` while the loop "succeeds" through
 * verify/fix without implementing (live evidence: run 01f41203). Legacy
 * (in-repo) projects have the sibling problem for their UNTRACKED `.claude`
 * entries: present on disk in the repo, absent from the checkout.
 *
 * Mechanics — a MERGE-overlay under `<worktree>/<providerDir>/`:
 *  - For each source entry missing in the worktree, SYMLINK it (dir symlink when
 *    the whole dir is absent, per-file/per-child when partially present). The
 *    checkout's own content is NEVER overwritten — tracked files always win.
 *  - `agent-memory` is linked like everything else: all runs SHARE agent memory,
 *    exactly matching the pre-isolation shared-cwd semantics (deliberate).
 *  - The providerDir ROOT itself is never linked (a real dir is created) so
 *    nested pipeline worktrees (`.claude/worktrees/**`) stay LOCAL to this
 *    worktree instead of colliding in the shared workspace. The source's
 *    `worktrees` entry is skipped for the same reason.
 *  - `.mcp.json` and the provider instruction file (CLAUDE.md / AGENTS.md /
 *    GEMINI.md) are COPIED (spawn-local), only when the checkout lacks them.
 *  - Windows: junction fallback for dirs, then a dereferencing copy (the
 *    explore-cwd precedent).
 *
 * Idempotent + resume-safe: every created entry is recorded in a manifest
 * (`.sr-rail-overlay.json`, itself overlay-owned) whose UNION across passes is
 * returned as `createdPaths` — the caller excludes those paths from
 * `commitWorktree`'s `git add -A` so overlay scaffolding NEVER lands on the
 * ticket branch / PR. Failures degrade per entry into `warnings` (the spawn
 * proceeds — a partial surface beats an aborted rail); this function never
 * throws.
 */
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'

export interface WorktreeOverlayInput {
  /** The isolated rail worktree (spawn cwd). */
  worktreePath: string
  /** Effective artifact root: the WORKSPACE for relocated projects, the repo
   *  path for legacy projects. */
  sourceRoot: string
  /** Provider dir name (`.claude` / `.codex` / `.gemini`). */
  providerDir: string
  /** Provider instruction filename (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`). */
  instructionsFilename: string
}

export interface WorktreeOverlayResult {
  /** Worktree-relative POSIX paths of every overlay-owned entry (links, copies,
   *  the manifest) — cumulative across passes on a resumed worktree. The caller
   *  MUST exclude these from any `git add` so they never reach the branch. */
  createdPaths: string[]
  /** Immutable cleanup proof for each returned path. Automatic worktree
   * removal must re-check these fingerprints before excluding overlay files
   * from its cleanliness inspection. */
  cleanupEvidence: OverlayCleanupEvidence[]
  /** Non-fatal, human-readable problems (entry-level failures). Non-empty means
   *  the run may be missing commands/agents — surface it to the user. */
  warnings: string[]
}

export interface OverlayCleanupEvidence {
  path: string
  kind: 'symlink' | 'file' | 'directory'
  digest: string
}

/** Overlay manifest filename (worktree root). Overlay-owned + git-excluded. */
export const OVERLAY_MANIFEST = '.sr-rail-overlay.json'

/** providerDir children that must NEVER be linked into a worktree: nested
 *  pipeline worktrees must stay local to THIS worktree (linking would share
 *  them across concurrent rails — collisions). */
const SKIP_PROVIDER_ENTRIES = new Set(['worktrees'])

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** True when `p` resolves (following symlinks) to a directory. */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** lstat that returns null instead of throwing. */
function lstatSafe(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

/** Read a prior pass's manifest — tolerant of absence/corruption. */
function readManifest(manifestPath: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown
    const paths = Array.isArray(raw) ? raw : (raw as { paths?: unknown })?.paths
    return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function safeRelativePath(value: string): string | null {
  // `value` is already constructed with POSIX separators. Preserve whitespace
  // and, on POSIX, a literal backslash: both are valid filename characters.
  // On Windows a backslash is a separator and is rejected fail-closed.
  if (process.platform === 'win32' && value.includes('\\')) return null
  if (value.split('/').includes('..')) return null
  const normalized = path.posix.normalize(value)
  if (
    !normalized || normalized === '.' || normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized) || normalized.includes('\0')
  ) return null
  return normalized
}

function sourcePathForOverlayEntry(input: WorktreeOverlayInput, rel: string): string | null {
  if (rel === '.mcp.json' || rel === input.instructionsFilename) {
    return path.join(input.sourceRoot, rel)
  }
  const providerPrefix = `${input.providerDir}/`
  if (!rel.startsWith(providerPrefix)) return null
  const providerRel = rel.slice(providerPrefix.length)
  if (!providerRel || providerRel === 'worktrees' || providerRel.startsWith('worktrees/')) return null
  return path.join(input.sourceRoot, ...rel.split('/'))
}

function sha256(parts: readonly (string | Buffer)[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

/** Content fingerprint that follows nested links. This deliberately matches
 * the copy fallback's dereferencing semantics. */
function dereferencedDigest(target: string, ancestors = new Set<string>()): string | null {
  try {
    const stat = fs.statSync(target)
    if (stat.isFile()) return sha256(['file\0', fs.readFileSync(target)])
    if (!stat.isDirectory()) return null
    const real = fs.realpathSync(target)
    if (ancestors.has(real)) return null
    const nextAncestors = new Set(ancestors).add(real)
    const parts: Array<string | Buffer> = ['directory\0']
    for (const name of fs.readdirSync(target).sort()) {
      const childDigest = dereferencedDigest(path.join(target, name), nextAncestors)
      if (!childDigest) return null
      parts.push(name, '\0', childDigest, '\0')
    }
    return sha256(parts)
  } catch {
    return null
  }
}

export function fingerprintOverlayCleanupPath(
  target: string,
): Omit<OverlayCleanupEvidence, 'path'> | null {
  try {
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(target), fs.readlinkSync(target))
      return { kind: 'symlink', digest: sha256(['symlink\0', resolved]) }
    }
    if (stat.isFile()) return { kind: 'file', digest: sha256(['file\0', fs.readFileSync(target)]) }
    if (stat.isDirectory()) {
      const digest = dereferencedDigest(target)
      return digest ? { kind: 'directory', digest } : null
    }
    return null
  } catch {
    return null
  }
}

/** Authenticate candidate manifest entries against the configured overlay
 * source and capture immutable cleanup evidence. The writable manifest alone
 * never grants ownership of an arbitrary worktree path. */
export function captureOverlayCleanupEvidence(
  input: WorktreeOverlayInput,
  candidates: readonly string[],
  includeManifest = false,
): OverlayCleanupEvidence[] {
  const evidence: OverlayCleanupEvidence[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const rel = safeRelativePath(candidate)
    if (!rel || seen.has(rel)) continue
    const destination = path.join(input.worktreePath, ...rel.split('/'))
    if (rel === OVERLAY_MANIFEST) {
      if (!includeManifest) continue
      const fingerprint = fingerprintOverlayCleanupPath(destination)
      if (fingerprint) {
        evidence.push({ path: rel, ...fingerprint })
        seen.add(rel)
      }
      continue
    }
    const source = sourcePathForOverlayEntry(input, rel)
    if (!source) continue
    const destinationStat = lstatSafe(destination)
    if (!destinationStat) continue
    if (destinationStat.isSymbolicLink()) {
      try {
        if (path.resolve(path.dirname(destination), fs.readlinkSync(destination)) !== path.resolve(source)) continue
      } catch {
        continue
      }
    } else {
      const sourceDigest = dereferencedDigest(source)
      const destinationDigest = dereferencedDigest(destination)
      if (!sourceDigest || sourceDigest !== destinationDigest) continue
    }
    const fingerprint = fingerprintOverlayCleanupPath(destination)
    if (!fingerprint) continue
    evidence.push({ path: rel, ...fingerprint })
    seen.add(rel)
  }
  return evidence
}

/** Revalidate one persisted overlay proof against the live worktree. */
export function matchesOverlayCleanupEvidence(
  worktreePath: string,
  evidence: OverlayCleanupEvidence,
): boolean {
  const rel = safeRelativePath(evidence.path)
  if (!rel || !/^[0-9a-f]{64}$/.test(evidence.digest)) return false
  return matchesOverlayCleanupEvidenceAtPath(
    path.join(worktreePath, ...rel.split('/')),
    evidence,
  )
}

/** Revalidate persisted evidence against an explicit path. Cleanup uses this
 * for leaf-by-leaf deletion inside an authenticated copied directory. */
export function matchesOverlayCleanupEvidenceAtPath(
  target: string,
  evidence: Pick<OverlayCleanupEvidence, 'kind' | 'digest'>,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(evidence.digest)) return false
  const live = fingerprintOverlayCleanupPath(target)
  return live?.kind === evidence.kind && live.digest === evidence.digest
}

/** Narrow allocation-time authority after a run. Revalidation may revoke an
 * entry but can never replace its original fingerprint with a newly modified
 * value (especially important for the source-less writable manifest). */
export function revalidateOverlayCleanupEvidence(
  input: WorktreeOverlayInput,
  original: readonly OverlayCleanupEvidence[],
): OverlayCleanupEvidence[] {
  const originalByPath = new Map(original.map((entry) => [entry.path, entry]))
  return captureOverlayCleanupEvidence(input, original.map((entry) => entry.path), true)
    .filter((live) => {
      const prior = originalByPath.get(live.path)
      return prior?.kind === live.kind && prior.digest === live.digest
    })
}

/**
 * Create `dest` as a link to `src` (symlink on POSIX; junction-then-symlink on
 * Windows for dirs), degrading to a dereferencing COPY when links fail.
 * Records `rel` on success; pushes a warning on total failure.
 */
function linkOrCopyEntry(src: string, dest: string, rel: string, created: string[], warnings: string[]): void {
  const srcIsDir = isDir(src)
  let linked = false
  if (process.platform === 'win32' && srcIsDir) {
    try {
      fs.symlinkSync(src, dest, 'junction')
      linked = true
    } catch {
      /* fall through */
    }
  }
  if (!linked) {
    try {
      fs.symlinkSync(src, dest)
      linked = true
    } catch {
      /* fall through to copy */
    }
  }
  if (!linked) {
    // Copy fallback (Windows without symlink rights, exotic filesystems).
    // Dereference so workspace-internal symlinks become real files.
    try {
      if (srcIsDir) fs.cpSync(src, dest, { recursive: true, dereference: true })
      else fs.copyFileSync(src, dest)
      linked = true
    } catch (err) {
      warnings.push(`failed to link ${rel}: ${errMsg(err)}`)
      return
    }
  }
  created.push(rel)
}

/**
 * Merge `src` into `dest` non-destructively:
 *  - dest missing            → link (whole entry).
 *  - dest is OUR prior link  → re-claim (record) without touching it.
 *  - dest is a real dir AND src is a dir → recurse per child (per-file links
 *    where the checkout is partially present).
 *  - anything else           → skip (the checkout's content always wins).
 */
function mergeLink(src: string, dest: string, rel: string, created: string[], warnings: string[]): void {
  const destSt = lstatSafe(dest)
  if (!destSt) {
    linkOrCopyEntry(src, dest, rel, created, warnings)
    return
  }
  if (destSt.isSymbolicLink()) {
    // Idempotent re-claim of a link a prior pass created; a foreign symlink
    // (brought by the checkout) is left alone and NOT claimed.
    try {
      if (path.resolve(path.dirname(dest), fs.readlinkSync(dest)) === path.resolve(src)) created.push(rel)
    } catch {
      /* unreadable link — leave it */
    }
    return
  }
  if (destSt.isDirectory() && isDir(src)) {
    let entries: string[]
    try {
      entries = fs.readdirSync(src)
    } catch (err) {
      warnings.push(`failed to read ${rel}: ${errMsg(err)}`)
      return
    }
    for (const name of entries) {
      mergeLink(path.join(src, name), path.join(dest, name), `${rel}/${name}`, created, warnings)
    }
    return
  }
  // dest exists as a file (or src is a file while dest is a dir) — never overwrite.
}

/** Copy `src` → `dest` only when `dest` does not exist. Records `rel`. */
function copyIfAbsent(src: string, dest: string, rel: string, created: string[], warnings: string[]): void {
  if (!fs.existsSync(src)) return
  if (lstatSafe(dest)) return // checkout (or a prior pass, re-claimed via manifest) wins
  try {
    fs.copyFileSync(src, dest)
    created.push(rel)
  } catch (err) {
    warnings.push(`failed to copy ${rel}: ${errMsg(err)}`)
  }
}

/**
 * Apply the overlay. Never throws; see the module header for semantics.
 */
export function applyWorktreeOverlay(input: WorktreeOverlayInput): WorktreeOverlayResult {
  const { worktreePath, sourceRoot, providerDir, instructionsFilename } = input
  const warnings: string[] = []
  const created: string[] = []
  const manifestPath = path.join(worktreePath, OVERLAY_MANIFEST)
  const prior = captureOverlayCleanupEvidence(input, readManifest(manifestPath)).map((entry) => entry.path)

  try {
    if (!isDir(worktreePath)) {
      warnings.push(`worktree dir missing: ${worktreePath}`)
      return { createdPaths: [], cleanupEvidence: [], warnings }
    }
    if (path.resolve(sourceRoot) === path.resolve(worktreePath)) {
      // Paranoia: never overlay a worktree onto itself.
      return { createdPaths: [], cleanupEvidence: [], warnings }
    }

    // 1. providerDir merge-overlay (commands/agents/skills/rules/settings/…).
    const srcProvider = path.join(sourceRoot, providerDir)
    if (isDir(srcProvider)) {
      const destProvider = path.join(worktreePath, providerDir)
      // The providerDir root is ALWAYS a real local dir (never a link) so
      // nested `.claude/worktrees/**` stay local — see the module header.
      let providerReady = true
      const destSt = lstatSafe(destProvider)
      if (!destSt) {
        try {
          fs.mkdirSync(destProvider, { recursive: true })
        } catch (err) {
          warnings.push(`failed to create ${providerDir}: ${errMsg(err)}`)
          providerReady = false
        }
      } else if (!destSt.isDirectory()) {
        warnings.push(`${providerDir} exists in the checkout but is not a directory — skipping the framework overlay`)
        providerReady = false
      }
      if (providerReady) {
        let entries: string[] = []
        try {
          entries = fs.readdirSync(srcProvider)
        } catch (err) {
          warnings.push(`failed to read source ${providerDir}: ${errMsg(err)}`)
        }
        for (const name of entries) {
          if (SKIP_PROVIDER_ENTRIES.has(name)) continue
          mergeLink(path.join(srcProvider, name), path.join(destProvider, name), `${providerDir}/${name}`, created, warnings)
        }
      }
    }

    // 2. `.mcp.json` — COPY (spawn-local), only when the checkout lacks one.
    copyIfAbsent(path.join(sourceRoot, '.mcp.json'), path.join(worktreePath, '.mcp.json'), '.mcp.json', created, warnings)

    // 3. Provider instruction file — COPY when the source has one and the
    //    checkout doesn't (a repo-tracked CLAUDE.md always wins).
    copyIfAbsent(
      path.join(sourceRoot, instructionsFilename),
      path.join(worktreePath, instructionsFilename),
      instructionsFilename,
      created,
      warnings,
    )
  } catch (err) {
    warnings.push(`overlay failed: ${errMsg(err)}`)
  }

  // Union with the prior manifest so a RESUMED worktree keeps every overlay
  // entry excluded from commits, then persist (the manifest is overlay-owned).
  const all = [...new Set([...prior, ...created])]
  if (all.length > 0) {
    try {
      fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, paths: all }, null, 2))
      if (!all.includes(OVERLAY_MANIFEST)) all.push(OVERLAY_MANIFEST)
    } catch (err) {
      warnings.push(`failed to write overlay manifest: ${errMsg(err)}`)
    }
  }
  const cleanupEvidence = captureOverlayCleanupEvidence(input, all, true)
  return { createdPaths: cleanupEvidence.map((entry) => entry.path), cleanupEvidence, warnings }
}
