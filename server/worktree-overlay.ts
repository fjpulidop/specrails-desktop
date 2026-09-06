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
 * Sources are ORDERED roots: `sourceRoot` (the effective artifact root — the
 * workspace for relocated projects, the repo for legacy ones) plus optional
 * `fallbackSourceRoots`. Relocated launches pass the REPO as the fallback so
 * repo-resident untracked carve-outs (OpenSpec's `/opsx:*` command dirs,
 * `openspec-*` skills, user extras) reach the worktree exactly as they do for
 * legacy projects — a relocated workspace links the framework `commands/`
 * subtree, which ships only `specrails/`, so without the fallback the claude
 * CLI reports `Unknown command: /opsx:ff` inside isolated rails.
 *
 * Mechanics — a MERGE-overlay under `<worktree>/<providerDir>/`:
 *  - For each source entry missing in the worktree, SYMLINK it (dir symlink when
 *    the whole dir is absent, per-file/per-child when partially present). The
 *    checkout's own content is NEVER overwritten — tracked files always win.
 *  - Earlier roots win per entry. When SEVERAL roots contribute children to the
 *    same directory (workspace `commands/specrails` + repo `commands/opsx`),
 *    the dir is materialized as a REAL directory of per-child links — a
 *    whole-dir link to either root would hide the other's children. A prior
 *    pass's own whole-dir link is upgraded in place on resume.
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
 * returned as `createdPaths`. `commitWorktree` uses those paths for its index
 * audit/reset and authoritative `git commit --only` literal exclusions, so
 * overlay scaffolding NEVER lands on the ticket branch / PR. Failures degrade
 * per entry into `warnings` (the spawn proceeds — a partial surface beats an
 * aborted rail); this function never throws.
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
  /** Ordered LOWER-priority roots merged after `sourceRoot` (first match wins
   *  per entry). Relocated launches pass the repo here so its untracked
   *  provider-dir entries (OpenSpec's `/opsx:*` commands, user extras) reach
   *  the worktree. Legacy launches omit it — byte-identical behaviour. */
  fallbackSourceRoots?: string[]
  /** Provider dir name (`.claude` / `.codex` / `.gemini` / `.kimi-code`). */
  providerDir: string
  /** Provider instruction filename (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`). */
  instructionsFilename: string
}

export interface WorktreeOverlayResult {
  /** Worktree-relative POSIX paths of every overlay-owned entry (links, copies,
   *  the manifest) — cumulative across passes on a resumed worktree. The caller
   *  MUST enforce them as commit exclusions so they never reach the branch. */
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

/** The configured source roots in priority order, deduped, never the worktree
 *  itself (self-overlay paranoia extends to fallback roots). */
function overlayRootsOf(input: WorktreeOverlayInput): string[] {
  const worktree = path.resolve(input.worktreePath)
  const roots: string[] = []
  const seen = new Set<string>()
  for (const root of [input.sourceRoot, ...(input.fallbackSourceRoots ?? [])]) {
    if (!root) continue
    const resolved = path.resolve(root)
    if (resolved === worktree || seen.has(resolved)) continue
    seen.add(resolved)
    roots.push(root)
  }
  return roots
}

/** Candidate source paths (one per configured root, priority order) an overlay
 *  manifest entry may authenticate against. Empty for unauthorised rels. */
function sourceCandidatesForOverlayEntry(input: WorktreeOverlayInput, rel: string): string[] {
  const roots = overlayRootsOf(input)
  if (rel === '.mcp.json' || rel === input.instructionsFilename) {
    return roots.map((root) => path.join(root, rel))
  }
  const providerPrefix = `${input.providerDir}/`
  if (!rel.startsWith(providerPrefix)) return []
  const providerRel = rel.slice(providerPrefix.length)
  if (!providerRel || providerRel === 'worktrees' || providerRel.startsWith('worktrees/')) return []
  return roots.map((root) => path.join(root, ...rel.split('/')))
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
    const sources = sourceCandidatesForOverlayEntry(input, rel)
    if (sources.length === 0) continue
    const destinationStat = lstatSafe(destination)
    if (!destinationStat) continue
    if (destinationStat.isSymbolicLink()) {
      let target: string
      try {
        target = path.resolve(path.dirname(destination), fs.readlinkSync(destination))
      } catch {
        continue
      }
      if (!sources.some((source) => path.resolve(source) === target)) continue
    } else {
      const destinationDigest = dereferencedDigest(destination)
      if (!destinationDigest) continue
      if (!sources.some((source) => dereferencedDigest(source) === destinationDigest)) continue
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
      // A filter avoids Node 22's native Unicode directory-copy failure on
      // Windows (nodejs/node#61878). The caller admits only a missing destination.
      if (srcIsDir) fs.cpSync(src, dest, { recursive: true, dereference: true, filter: () => true, mode: fs.constants.COPYFILE_FICLONE })
      else fs.copyFileSync(src, dest)
      linked = true
    } catch (err) {
      warnings.push(`failed to link ${rel}: ${errMsg(err)}`)
      return
    }
  }
  created.push(rel)
}

/** True when `secondary` contributes any entry name (recursively, by tree
 *  shape) that is not reachable through `primary`. Drives the resume-time
 *  upgrade of a prior whole-dir link into a merged real dir. Follows dir
 *  symlinks with a realpath ancestor guard (framework subtrees are links). */
function contributesExtraEntries(secondary: string, primary: string, ancestors = new Set<string>()): boolean {
  let names: string[]
  try {
    names = fs.readdirSync(secondary)
  } catch {
    return false
  }
  let real: string
  try {
    real = fs.realpathSync(secondary)
  } catch {
    return false
  }
  if (ancestors.has(real)) return false
  const nextAncestors = new Set(ancestors).add(real)
  for (const name of names) {
    const primaryChild = path.join(primary, name)
    if (!lstatSafe(primaryChild)) return true
    const secondaryChild = path.join(secondary, name)
    if (isDir(secondaryChild) && isDir(primaryChild) &&
        contributesExtraEntries(secondaryChild, primaryChild, nextAncestors)) {
      return true
    }
  }
  return false
}

/**
 * Merge the ordered existing sources for ONE entry into `dest`
 * non-destructively (`srcs` = the roots' paths that exist for this rel,
 * priority order — earlier roots win):
 *  - dest missing, one contributing dir (or a file first) → link whole entry.
 *  - dest missing, several contributing dirs → REAL dir + per-child recursion
 *    (a whole-dir link to either root would hide the other's children).
 *  - dest is OUR prior link/copy → re-claim; rebuild from the current ordered
 *    sources when a higher-priority winner appears or another root contributes
 *    extra directory entries (resume path).
 *  - dest is a real dir AND the highest-priority src is a dir → recurse per
 *    child over the union (per-file links where checkout is partially present).
 *  - anything else → skip (the checkout's content always wins).
 */
function mergeLink(
  srcs: string[],
  dest: string,
  rel: string,
  created: string[],
  warnings: string[],
  priorOwned: ReadonlySet<string>,
  converted: Set<string>,
): void {
  if (srcs.length === 0) return
  const primary = srcs[0]
  const primaryIsDir = isDir(primary)
  // A highest-priority FILE shadows every lower-priority entry, including
  // directories. Only collect mergeable dirs when the primary itself is one.
  const dirSrcs = primaryIsDir ? srcs.filter((src) => isDir(src)) : []
  const destSt = lstatSafe(dest)

  if (!destSt) {
    if (!primaryIsDir || dirSrcs.length <= 1) {
      // A file in the highest-priority root shadows lower roots entirely; a
      // dir contributed by a single root keeps the whole-dir link (status quo).
      linkOrCopyEntry(primary, dest, rel, created, warnings)
      return
    }
    try {
      fs.mkdirSync(dest, { recursive: true })
    } catch (err) {
      warnings.push(`failed to create ${rel}: ${errMsg(err)}`)
      return
    }
    // The merged real dir itself is NOT recorded (precedent: the providerDir
    // root); only its leaf links carry manifest entries + cleanup evidence.
    mergeChildren(dirSrcs, dest, rel, created, warnings, priorOwned, converted)
    return
  }

  if (destSt.isSymbolicLink()) {
    // Idempotent re-claim of a link a prior pass created; a foreign symlink
    // (brought by the checkout) is left alone and NOT claimed.
    let target: string
    try {
      target = path.resolve(path.dirname(dest), fs.readlinkSync(dest))
    } catch {
      return /* unreadable link — leave it */
    }
    const owned = srcs.find((src) => path.resolve(src) === target)
    // Target equality authenticates WHAT the link points at, but not WHO made
    // it. Destructive resume conversion additionally requires authenticated
    // prior-manifest ownership; a checkout/foreign link may legitimately point
    // at the same configured source and must never be replaced or claimed.
    if (!owned || !priorOwned.has(rel)) return
    const winnerChanged = path.resolve(owned) !== path.resolve(primary)
    const needsDirectoryMerge =
      isDir(owned) && primaryIsDir && dirSrcs.length > 1 &&
      dirSrcs.some((src) => src !== owned && contributesExtraEntries(src, owned))
    if (winnerChanged || needsDirectoryMerge) {
      // Resume upgrade: rebuild OUR authenticated entry when a higher-priority
      // source appeared or another dir now contributes children. Re-entering
      // mergeLink with a missing destination selects the current winner and
      // materializes a merged REAL dir when required.
      try {
        fs.unlinkSync(dest)
      } catch (err) {
        warnings.push(`failed to upgrade ${rel}: ${errMsg(err)}`)
        created.push(rel) // still ours — keep it commit-excluded
        return
      }
      converted.add(rel)
      mergeLink(srcs, dest, rel, created, warnings, priorOwned, converted)
      return
    }
    created.push(rel)
    return
  }

  if ((destSt.isDirectory() || destSt.isFile()) && priorOwned.has(rel)) {
    // Windows may have materialized a prior overlay as a COPY when link
    // creation was unavailable. Rebuild an authenticated source-identical copy
    // when a higher-priority source appeared or a directory needs children
    // from another root. Merely recursing into a prior dir copy would leave its
    // old children unrecorded after the parent digest stops matching.
    const destinationDigest = dereferencedDigest(dest)
    const owned = destinationDigest
      ? srcs.find((src) => dereferencedDigest(src) === destinationDigest)
      : undefined
    const winnerChanged = !!owned && path.resolve(owned) !== path.resolve(primary)
    const needsDirectoryMerge =
      !!owned && isDir(owned) && primaryIsDir && dirSrcs.length > 1 &&
      dirSrcs.some((src) => src !== owned && contributesExtraEntries(src, owned))
    if (owned && (winnerChanged || needsDirectoryMerge)) {
      try {
        // Recompute immediately before removal so a user modification between
        // manifest authentication and conversion revokes destructive authority.
        if (dereferencedDigest(dest) !== destinationDigest) return
        fs.rmSync(dest, { recursive: destSt.isDirectory() })
      } catch (err) {
        warnings.push(`failed to upgrade ${rel}: ${errMsg(err)}`)
        return
      }
      converted.add(rel)
      mergeLink(srcs, dest, rel, created, warnings, priorOwned, converted)
      return
    }
  }

  if (destSt.isDirectory() && primaryIsDir && dirSrcs.length > 0) {
    mergeChildren(dirSrcs, dest, rel, created, warnings, priorOwned, converted)
    return
  }
  // dest exists as a file (or src is a file while dest is a dir) — never overwrite.
}

/** Recurse `mergeLink` per child over the UNION of children across the
 *  contributing dirs, preserving root priority order. */
function mergeChildren(
  dirSrcs: string[],
  dest: string,
  rel: string,
  created: string[],
  warnings: string[],
  priorOwned: ReadonlySet<string>,
  converted: Set<string>,
): void {
  const names = new Set<string>()
  for (const dir of dirSrcs) {
    try {
      for (const name of fs.readdirSync(dir)) names.add(name)
    } catch (err) {
      warnings.push(`failed to read ${rel}: ${errMsg(err)}`)
    }
  }
  for (const name of [...names].sort()) {
    const childSrcs = dirSrcs.map((dir) => path.join(dir, name)).filter((p) => lstatSafe(p) !== null)
    mergeLink(
      childSrcs,
      path.join(dest, name),
      `${rel}/${name}`,
      created,
      warnings,
      priorOwned,
      converted,
    )
  }
}

/** Copy `src` → `dest` only when `dest` does not exist. Records `rel`. */
function copyIfAbsent(src: string, dest: string, rel: string, created: string[], warnings: string[]): void {
  if (!fs.existsSync(src)) return
  if (lstatSafe(dest)) return // checkout (or a prior pass, re-claimed via manifest) wins
  try {
    // Adapter instruction paths may be nested (Kimi uses
    // `.kimi-code/AGENTS.md`), unlike the historical root-level CLAUDE.md.
    fs.mkdirSync(path.dirname(dest), { recursive: true })
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
  const priorOwned = new Set(prior)
  const converted = new Set<string>()

  try {
    if (!isDir(worktreePath)) {
      warnings.push(`worktree dir missing: ${worktreePath}`)
      return { createdPaths: [], cleanupEvidence: [], warnings }
    }
    if (path.resolve(sourceRoot) === path.resolve(worktreePath)) {
      // Paranoia: never overlay a worktree onto itself.
      return { createdPaths: [], cleanupEvidence: [], warnings }
    }
    const roots = overlayRootsOf(input)

    // 1. providerDir merge-overlay (commands/agents/skills/rules/settings/…),
    //    over the UNION of entries across the configured roots (earlier wins).
    const srcProviders = roots.map((root) => path.join(root, providerDir)).filter((p) => isDir(p))
    const nestedInstructionsEntry =
      path.normalize(path.dirname(instructionsFilename)) === path.normalize(providerDir)
        ? path.basename(instructionsFilename)
        : null
    if (srcProviders.length > 0) {
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
        const names = new Set<string>()
        for (const srcProvider of srcProviders) {
          try {
            for (const name of fs.readdirSync(srcProvider)) names.add(name)
          } catch (err) {
            warnings.push(`failed to read source ${providerDir}: ${errMsg(err)}`)
          }
        }
        for (const name of [...names].sort()) {
          // A nested provider instruction (Kimi's `.kimi-code/AGENTS.md`) must
          // follow the spawn-local COPY semantics in step 3, not become a link
          // merely because it also lives directly under providerDir.
          if (SKIP_PROVIDER_ENTRIES.has(name) || name === nestedInstructionsEntry) continue
          const childSrcs = srcProviders.map((srcProvider) => path.join(srcProvider, name)).filter((p) => lstatSafe(p) !== null)
          mergeLink(
            childSrcs,
            path.join(destProvider, name),
            `${providerDir}/${name}`,
            created,
            warnings,
            priorOwned,
            converted,
          )
        }
      }
    }

    // 2. `.mcp.json` — COPY (spawn-local), only when the checkout lacks one.
    //    First root that has one wins.
    const mcpSrc = roots.map((root) => path.join(root, '.mcp.json')).find((p) => fs.existsSync(p))
    if (mcpSrc) copyIfAbsent(mcpSrc, path.join(worktreePath, '.mcp.json'), '.mcp.json', created, warnings)

    // 3. Provider instruction path — COPY when a source has one and the
    //    checkout doesn't (a repo-tracked provider instruction always wins).
    const instructionsSrc = roots.map((root) => path.join(root, instructionsFilename)).find((p) => fs.existsSync(p))
    if (instructionsSrc) {
      copyIfAbsent(
        instructionsSrc,
        path.join(worktreePath, instructionsFilename),
        instructionsFilename,
        created,
        warnings,
      )
    }
  } catch (err) {
    warnings.push(`overlay failed: ${errMsg(err)}`)
  }

  // Union with the prior manifest so a RESUMED worktree keeps every overlay
  // entry excluded from commits, then persist (the manifest is overlay-owned).
  // A converted whole-dir link is no longer an overlay leaf. Drop it even if
  // the merged real directory happens to have the same dereferenced digest as
  // one source root (e.g. a fallback root already contains the full superset).
  const all = [...new Set([...prior.filter((rel) => !converted.has(rel)), ...created])]
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
