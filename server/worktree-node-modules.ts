/**
 * Reuse installed packages without sharing tool caches with the base checkout.
 * Each worktree owns its node_modules directory; package entries remain links,
 * while .vite, .vite-temp and .cache are local writable directories. No install,
 * dependency copy or permission broadening is performed. Legacy whole-directory
 * links are migrated only after their exact source has been authenticated.
 *
 * Cleanup authority covers individual source-anchored links, never the entire
 * writable directory. Replaced packages and newly created files therefore keep
 * the existing ignored-artifact / recoverable-work settlement guarantees.
 *
 * Freshness guard: a package directory is linked only when its dependency inputs
 * (nearest lockfile up to the Git top level + the manifest's dependency fields)
 * match between the base checkout and the worktree. Otherwise the directory is
 * left without node_modules so the runtime installs it cold from the worktree's
 * own lockfile. The base checkout is only ever read.
 */
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { fingerprintOverlayCleanupPath, type OverlayCleanupEvidence } from './worktree-overlay'
import { checkoutSubdirectory } from './util/checkout-path'

export interface NodeModulesLinkResult {
  /** Worktree-relative dependency directories prepared by THIS call. */
  linked: string[]
  /** Worktree-relative POSIX paths of every warm link PROVEN to point at the
   *  registered source's corresponding dependency entry — created by this call OR
   *  by an earlier pass. This is the set callers must exclude and authorize. */
  authenticated: string[]
  /** Cleanup fingerprints for `authenticated`, in overlay-evidence shape so the
   *  existing exclusion + atomic-quarantine machinery handles them unchanged. */
  evidence: OverlayCleanupEvidence[]
  /** Non-fatal degradation notes (link failures, unreadable dirs). */
  warnings: string[]
}

/** Package-dir discovery depth: 0 = repo root, 1 = `client/`-style children. */
const MAX_DEPTH = 2

/** Name of the dependency directory this module links. */
const DEPS_DIR = 'node_modules'
export const WORKTREE_DEPENDENCY_CACHES = ['.vite', '.vite-temp', '.cache'] as const

export function isWorktreeNodeModulesEnabled(): boolean {
  return (process.env.SPECRAILS_WORKTREE_NODE_MODULES ?? '').toLowerCase() !== 'false'
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Relative POSIX paths of package dirs (containing package.json) at depth ≤ MAX_DEPTH. */
export function discoverPackageDirs(baseRepo: string): string[] {
  const found: string[] = []
  const walk = (rel: string, depth: number): void => {
    const abs = rel === '' ? baseRepo : path.join(baseRepo, rel)
    if (exists(path.join(abs, 'package.json'))) found.push(rel)
    if (depth >= MAX_DEPTH) return
    let names: string[]
    try {
      names = fs.readdirSync(abs)
    } catch {
      return
    }
    for (const name of names) {
      // Dot-dirs (.git, .specrails, provider dirs) and dependency trees never
      // hold linkable first-party packages.
      if (name.startsWith('.') || name === 'node_modules') continue
      const childAbs = path.join(abs, name)
      // A first-party symlink can escape the checkout or form a discovery cycle.
      if (!fs.lstatSync(childAbs).isDirectory()) continue
      walk(rel === '' ? name : `${rel}/${name}`, depth + 1)
    }
  }
  walk('', 0)
  return found
}

/** Lockfiles in lookup priority order; the first one found in a directory wins. */
export const DEPENDENCY_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock'] as const
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

export interface DependencyInputs {
  /** Nearest lockfile between the package directory and the Git top level.
   *  `location` is its directory relative to the package directory, so both
   *  checkouts must find it at the same relative position. `digest` is null
   *  when the file exists but cannot be read. */
  lockfile: { name: string; location: string; digest: string | null } | null
  /** Digest of the canonical dependency fields; null when package.json is
   *  missing or unreadable (null never compares equal). */
  manifestDigest: string | null
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Git top level of a checkout: nearest ancestor holding a `.git` entry (dir
 *  for a clone, file for a linked worktree). Outside Git, the checkout itself
 *  bounds the lockfile search so it never escapes into unrelated parents. */
function gitTopLevel(checkoutRoot: string): string {
  const start = path.resolve(checkoutRoot)
  for (let current = start; ; current = path.dirname(current)) {
    if (exists(path.join(current, '.git'))) return current
    if (path.dirname(current) === current) return start
  }
}

/**
 * Fingerprint the inputs that decide what a package directory installs. Never
 * throws: unreadable inputs yield null digests, which compare as different.
 */
export function dependencyInputs(checkoutRoot: string, pkgRel: string): DependencyInputs {
  const top = gitTopLevel(checkoutRoot)
  const pkgDir = pkgRel === '' ? path.resolve(checkoutRoot) : path.resolve(checkoutRoot, ...pkgRel.split('/'))
  let lockfile: DependencyInputs['lockfile'] = null
  for (let current = pkgDir; lockfile === null; current = path.dirname(current)) {
    for (const name of DEPENDENCY_LOCKFILES) {
      const file = path.join(current, name)
      if (!exists(file)) continue
      let digest: string | null = null
      try { digest = sha256(fs.readFileSync(file)) } catch { /* unreadable: never equal */ }
      lockfile = { name, location: path.relative(pkgDir, current).split(path.sep).join('/'), digest }
      break
    }
    if (current === top || path.dirname(current) === current) break
  }
  let manifestDigest: string | null = null
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>
    const fields: Record<string, unknown> = {}
    for (const field of DEPENDENCY_FIELDS) if (manifest?.[field] !== undefined) fields[field] = manifest[field]
    manifestDigest = sha256(canonicalJson(fields))
  } catch { /* missing or unparsable manifest: never equal */ }
  return { lockfile, manifestDigest }
}

/** Name of the first dependency input that differs, or null when warm reuse is safe. */
export function differingDependencyInput(base: DependencyInputs, worktree: DependencyInputs): string | null {
  const a = base.lockfile, b = worktree.lockfile
  if (a || b) {
    if (!a || !b || a.name !== b.name || a.location !== b.location || a.digest === null || a.digest !== b.digest) {
      return (a ?? b)!.name
    }
  }
  if (base.manifestDigest === null || base.manifestDigest !== worktree.manifestDigest) return 'package.json'
  return null
}

/** Resolve a path through symlinks when possible; the literal path otherwise
 *  (a nonexistent target must still compare, and must still compare EQUAL to an
 *  equally-nonexistent expectation rather than silently authorizing). */
function resolveRealPath(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/** Destination ancestors must be local directories, never links into another
 * checkout. Missing directories can be created during preparation. */
function hasLocalParents(worktreePath: string, rel: string): boolean {
  let parent = worktreePath
  for (const segment of rel.split('/').slice(0, -1)) {
    parent = path.join(parent, segment)
    try {
      if (!fs.lstatSync(parent).isDirectory()) return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    }
  }
  return true
}

/**
 * Prove one worktree-relative path is an app-created warm-dependency link and
 * fingerprint it. Returns null for anything that is not EXACTLY a symlink whose
 * target resolves to the registered source's corresponding entry — a real
 * directory, a dereferencing copy, a dangling link, or a link into some other
 * tree are all unauthorized and must keep preserving the worktree.
 */
function authenticateWarmLink(
  baseRepo: string,
  worktreePath: string,
  rel: string,
  sourceRel = rel,
): OverlayCleanupEvidence | null {
  if (!hasLocalParents(worktreePath, rel)) return null
  const dest = path.join(worktreePath, ...rel.split('/'))
  try {
    if (!fs.lstatSync(dest).isSymbolicLink()) return null
    const target = path.resolve(path.dirname(dest), fs.readlinkSync(dest))
    const expected = path.join(baseRepo, ...sourceRel.split('/'))
    if (resolveRealPath(target) !== resolveRealPath(expected)) return null
    // A dangling link proves nothing about the source dependency tree (entries
    // include both package directories and files such as Yarn's install state).
    if (!exists(target)) return null
  } catch {
    return null
  }
  const fingerprint = fingerprintOverlayCleanupPath(dest)
  return fingerprint ? { path: rel, ...fingerprint } : null
}

/** Worktree-relative POSIX paths of every `node_modules` entry the worktree
 *  holds at depth ≤ MAX_DEPTH. Mirrors the linker's own discovery depth, so it
 *  can only ever see paths this module could have created. Recursion uses lstat
 *  so a symlinked directory is never walked into. */
function discoverWorktreeDependencyPaths(worktreePath: string): string[] {
  const found: string[] = []
  const walk = (rel: string, depth: number): void => {
    const abs = rel === '' ? worktreePath : path.join(worktreePath, rel)
    let names: string[]
    try {
      names = fs.readdirSync(abs)
    } catch {
      return
    }
    for (const name of names) {
      const childRel = rel === '' ? name : `${rel}/${name}`
      if (name === DEPS_DIR) {
        found.push(childRel)
        continue
      }
      if (depth >= MAX_DEPTH || name.startsWith('.')) continue
      try {
        if (!fs.lstatSync(path.join(abs, name)).isDirectory()) continue
      } catch {
        continue
      }
      walk(childRel, depth + 1)
    }
  }
  walk('', 0)
  return found
}

/**
 * Live authentication of the warm-dependency links a worktree currently holds.
 *
 * Deriving this from the filesystem (instead of only from persisted evidence)
 * is what heals worktrees that settled BEFORE the links carried evidence: they
 * are stuck at `needs-review` with the link as their only "dirt", and a
 * persisted-only fix would never reach them. The proof is identical either way
 * — the link target anchored to a directory the app controls.
 */
export function authenticateWarmNodeModulesLinks(
  baseRepo: string,
  worktreePath: string,
): OverlayCleanupEvidence[] {
  const evidence = new Map<string, OverlayCleanupEvidence>()
  const prefix = checkoutSubdirectory(baseRepo)
  // Retained mounts may still contain the former misplaced layout. Keep its
  // exact source proof, without moving it or broadening cleanup to directories.
  for (const destinationPrefix of prefix ? [prefix, ''] : ['']) {
    const project = (rel: string): string => destinationPrefix ? `${destinationPrefix}/${rel}` : rel
    if (!hasLocalParents(worktreePath, project(DEPS_DIR))) continue
    const destinationRoot = path.join(worktreePath, destinationPrefix)
    const authenticate = (sourceRel: string): OverlayCleanupEvidence | null =>
      authenticateWarmLink(baseRepo, worktreePath, project(sourceRel), sourceRel)
    for (const rel of discoverWorktreeDependencyPaths(destinationRoot)) {
      const legacy = authenticate(rel)
      if (legacy) { evidence.set(legacy.path, legacy); continue }
      const dest = path.join(destinationRoot, rel)
      try {
        if (!fs.lstatSync(dest).isDirectory()) continue
        for (const name of fs.readdirSync(dest)) {
          if ((WORKTREE_DEPENDENCY_CACHES as readonly string[]).includes(name)) continue
          const entryRel = `${rel}/${name}`
          const entry = authenticate(entryRel)
          if (entry) { evidence.set(entry.path, entry); continue }
          // Scoped package parents are local too; never follow foreign symlinks.
          if (name.startsWith('@') && fs.lstatSync(path.join(dest, name)).isDirectory()) {
            for (const scoped of fs.readdirSync(path.join(dest, name))) {
              const child = authenticate(`${entryRel}/${scoped}`)
              if (child) evidence.set(child.path, child)
            }
          }
        }
      } catch { /* Unreadable or concurrently removed entries confer no authority. */ }
    }
  }
  return [...evidence.values()]
}

function linkDependencyEntry(source: string, destination: string): void {
  fs.symlinkSync(source, destination, process.platform === 'win32'
    ? (isDir(source) ? 'junction' : 'file') : undefined)
}

function createLocalDependencyTree(source: string, destination: string): void {
  fs.mkdirSync(destination)
  for (const name of fs.readdirSync(source)) {
    if ((WORKTREE_DEPENDENCY_CACHES as readonly string[]).includes(name)) continue
    const src = path.join(source, name)
    const dest = path.join(destination, name)
    if (name.startsWith('@') && isDir(src)) {
      fs.mkdirSync(dest)
      for (const scoped of fs.readdirSync(src)) linkDependencyEntry(path.join(src, scoped), path.join(dest, scoped))
    } else linkDependencyEntry(src, dest)
  }
  for (const cache of WORKTREE_DEPENDENCY_CACHES) fs.mkdirSync(path.join(destination, cache))
}

/**
 * Link the base checkout's installed `node_modules` trees into a fresh
 * worktree. Best-effort and side-effect-transparent: never throws, never
 * overwrites, and returns both what it created and what it can PROVE is a warm
 * link (including links a previous pass created), so the caller can exclude
 * those paths from commits and authorize them for release.
 */
export function linkNodeModulesIntoWorktree(baseRepo: string, worktreePath: string): NodeModulesLinkResult {
  const result: NodeModulesLinkResult = { linked: [], authenticated: [], evidence: [], warnings: [] }
  if (!isWorktreeNodeModulesEnabled()) return result
  const prefix = checkoutSubdirectory(baseRepo)
  for (const pkgRel of discoverPackageDirs(baseRepo)) {
    const sourceRel = pkgRel === '' ? DEPS_DIR : `${pkgRel}/${DEPS_DIR}`
    const rel = prefix ? `${prefix}/${sourceRel}` : sourceRel
    const src = path.join(baseRepo, ...sourceRel.split('/'))
    if (!isDir(src)) continue
    if (!hasLocalParents(worktreePath, rel)) {
      result.warnings.push(`failed to prepare ${rel}: destination parent is not a local directory`)
      continue
    }
    const dest = path.join(worktreePath, ...rel.split('/'))
    const legacy = authenticateWarmLink(baseRepo, worktreePath, rel, sourceRel)
    if (!exists(dest)) {
      // Freshness guard, only when a NEW link would be prepared: an existing
      // (resumed or legacy) link keeps its authentication below.
      const differing = differingDependencyInput(
        dependencyInputs(baseRepo, pkgRel),
        dependencyInputs(prefix ? path.join(worktreePath, ...prefix.split('/')) : worktreePath, pkgRel),
      )
      if (differing) {
        const pkgDir = [prefix, pkgRel].filter(Boolean).join('/') || '.'
        result.warnings.push(`${pkgDir}: ${differing} differs from the base checkout; dependencies will be installed in the worktree`)
        continue
      }
    }
    if (!exists(dest) || legacy) {
      let staging: string | undefined
      let removedLegacy = false
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        staging = fs.mkdtempSync(path.join(path.dirname(dest), '.specrails-dependencies-'))
        const prepared = path.join(staging, DEPS_DIR)
        createLocalDependencyTree(src, prepared)
        if (legacy) {
          // Recheck immediately before removing the old link. Never unlink a
          // directory or a replacement another actor installed in the meantime.
          const current = authenticateWarmLink(baseRepo, worktreePath, rel, sourceRel)
          if (!current || current.digest !== legacy.digest) throw new Error('dependency link changed during preparation')
          fs.unlinkSync(dest)
          removedLegacy = true
        }
        fs.renameSync(prepared, dest)
        result.linked.push(rel)
      } catch (err) {
        if (removedLegacy && !exists(dest)) {
          try { linkDependencyEntry(src, dest) }
          catch (restoreError) { result.warnings.push(`failed to restore ${rel}: ${errMsg(restoreError)}`) }
        }
        result.warnings.push(`failed to prepare ${rel}: ${errMsg(err)}`)
      } finally {
        if (staging) fs.rmSync(staging, { recursive: true, force: true })
      }
    }
  }
  result.evidence = authenticateWarmNodeModulesLinks(baseRepo, worktreePath)
  result.authenticated = result.evidence.map(entry => entry.path)
  return result
}
