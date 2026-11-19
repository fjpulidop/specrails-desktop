import { withRuntimePackageLock } from './agent-runtime-package-lock'
import { recordSharedPackageReference } from './agent-runtime-package-refs'
export { collectUnreferencedRuntimePackages, collectSharedRuntimePackages, removeCollectedPackages } from './agent-runtime-package-gc'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createAsyncMemo } from '../../../util/async-memo'
import { createRequire } from 'node:module'
import path from 'node:path'

export interface RuntimePackagePin {
  schemaVersion: 1
  packageVersion: string
  integrity: string
  cli: string
  root: string
}
const SHIPPED = ['package.json', 'dist', 'bin', 'templates', 'schemas', 'commands', 'integration-contract.json', 'pinned-versions.json']
const SAFE_PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i

function packageRoot(file: string, name?: string): string {
  let directory = path.dirname(fs.realpathSync(file))
  for (;;) {
    const manifest = path.join(directory, 'package.json')
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (pkg.name === (name ?? 'specrails-core')) return directory
    }
    const parent = path.dirname(directory)
    if (directory === parent) throw new Error('Core runtime does not resolve to an identifiable package')
    directory = parent
  }
}

/** Content identity also detects same-size edits with preserved timestamps. */
export function runtimeEntryFingerprint(cli: string): string {
  let root: string
  try { root = packageRoot(cli) } catch { return createHash('sha256').update(fs.readFileSync(cli)).digest('hex') }
  return treeDigest(root, SHIPPED)
}

function treeDigest(root: string, entries = fs.readdirSync(root).sort()): string {
  const hash = createHash('sha256')
  let files = 0, bytes = 0
  const visit = (relative: string): void => {
    const file = path.join(root, relative), stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error('Retained Core package contains a symbolic link')
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.posix.join(relative, name))
    else if (stat.isFile()) {
      if (++files > 100_000 || (bytes += stat.size) > 1024 * 1024 * 1024) throw new Error('Core runtime package exceeds retention limits')
      hash.update(JSON.stringify([relative, stat.size])).update('\0').update(fs.readFileSync(file)).update('\0')
    } else throw new Error('Core runtime package contains a nonregular file')
  }
  for (const entry of entries) if (fs.existsSync(path.join(root, entry))) visit(entry)
  return hash.digest('hex')
}

/** Same digest as treeDigest, computed with async I/O so a 100 MB+ retained
 * package (its full production dependency closure) never blocks the event loop. */
async function treeDigestAsync(root: string, entries: string[]): Promise<string> {
  // Same order and bytes as treeDigest. The walk lists directories one at a time; the
  // per-file stat and read run in bounded parallel batches (a sequential await per file
  // took ~1.5 min for the ~16k files of a Core package on a busy event loop).
  const files: string[] = []
  const walk = async (relative: string): Promise<void> => {
    const file = path.join(root, relative), stat = await fs.promises.lstat(file)
    if (stat.isSymbolicLink()) throw new Error('Retained Core package contains a symbolic link')
    if (stat.isDirectory()) {
      const children = (await fs.promises.readdir(file, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const child of children) {
        const childRelative = path.posix.join(relative, child.name)
        if (child.isDirectory() || child.isSymbolicLink()) await walk(childRelative)
        else if (child.isFile()) files.push(childRelative)
        else throw new Error('Core runtime package contains a nonregular file')
      }
    } else if (stat.isFile()) files.push(relative)
    else throw new Error('Core runtime package contains a nonregular file')
  }
  for (const entry of entries) if (fs.existsSync(path.join(root, entry))) await walk(entry)
  if (files.length > 100_000) throw new Error('Core runtime package exceeds retention limits')
  const hash = createHash('sha256')
  let bytes = 0
  for (let index = 0; index < files.length; index += IO_BATCH) {
    const batch = files.slice(index, index + IO_BATCH)
    const contents = await Promise.all(batch.map((relative) => fs.promises.readFile(path.join(root, relative))))
    batch.forEach((relative, offset) => {
      const content = contents[offset]
      if ((bytes += content.length) > 1024 * 1024 * 1024) throw new Error('Core runtime package exceeds retention limits')
      hash.update(JSON.stringify([relative, content.length])).update('\0').update(content).update('\0')
    })
  }
  return hash.digest('hex')
}

/** Files read or copied at once by the async package paths. */
const IO_BATCH = 64

/** Retained packages are content-addressed and written once. Read-only
 * inspection (status/evidence) reuses a successful verification of the same
 * root for a few minutes instead of re-hashing ~16k files on every request;
 * concurrent requests share one verification. Execution paths keep the
 * uncached check in resolveRetainedAgentRuntime. */
export const RETAINED_PACKAGE_VERIFY_TTL_MS = 5 * 60_000
const verifiedPackages = createAsyncMemo<string, string>({ ttlMs: RETAINED_PACKAGE_VERIFY_TTL_MS })
/** Test seam / retention hook: forget cached verifications. */
export function forgetRetainedPackageVerifications(root?: string): void { verifiedPackages.invalidate(root) }

function readRetainedPin(contextPath: string): { pin: RuntimePackagePin; expected: string } {
  const pinFile = path.join(path.dirname(contextPath), 'desktop-runtime-package.json')
  if (!fs.existsSync(pinFile)) throw new Error('Original runtime identity is unrecorded. Restore a proven original Core package before continuing this saved execution.')
  const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8')) as RuntimePackagePin
  const local = path.join(path.dirname(path.dirname(contextPath)), 'runtime-packages', pin.integrity)
  const shared = sharedPackageCache ? path.join(sharedPackageCache, pin.integrity) : null
  const expected = shared && pin.root === shared ? shared : local
  if (pin.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(pin.integrity) || pin.root !== expected || !fs.existsSync(expected) || fs.realpathSync(expected) !== path.resolve(expected)
    || typeof pin.cli !== 'string' || path.isAbsolute(pin.cli) || pin.cli.split(/[\\/]/).includes('..')) throw new Error('The original retained Core package is unavailable or invalid. Restore it before continuing.')
  return { pin, expected }
}

function retainedCli(expected: string, pin: RuntimePackagePin): string {
  const cli = path.join(expected, pin.cli)
  if (!fs.statSync(cli).isFile()) throw new Error('The original Core executable is unavailable')
  return cli
}

/** Read-only variant of resolveRetainedAgentRuntime: same pin and integrity
 * rules, verified off the event loop and memoized per retained root. */
export async function resolveRetainedAgentRuntimeForInspection(contextPath: string): Promise<string> {
  const { pin, expected } = readRetainedPin(contextPath)
  const digest = await verifiedPackages.get(expected, () => treeDigestAsync(expected, fs.readdirSync(expected).sort()))
  if (digest !== pin.integrity) {
    verifiedPackages.invalidate(expected)
    throw new Error('The original retained Core package failed its integrity check. Restore it before continuing.')
  }
  return retainedCli(expected, pin)
}

function resolveDependency(name: string, from: string): string {
  const require = createRequire(path.join(from, 'package.json'))
  try { return packageRoot(require.resolve(name + '/package.json'), name) }
  catch { return packageRoot(require.resolve(name), name) }
}

/** A cheap identity of the source package and every production dependency it
 * resolves: path, size, mtime, inode and mode of each file, without reading
 * contents. Any rebuild or reinstall changes it; it never replaces the content
 * digest of what is retained. */
function sourceStamp(source: string): string {
  const hash = createHash('sha256')
  const seen = new Set<string>()
  const files = (dir: string, entries?: string[]): void => {
    for (const name of entries ?? fs.readdirSync(dir).sort()) {
      if (!entries && ['node_modules', '.git', '.bin'].includes(name)) continue
      const file = path.join(dir, name)
      if (!fs.existsSync(file)) continue
      const stat = fs.statSync(file)
      if (stat.isDirectory()) files(file)
      else hash.update(JSON.stringify([file, stat.size, stat.mtimeMs, stat.ino, stat.mode])).update('\0')
    }
  }
  const visit = (root: string, top: boolean): void => {
    const real = fs.realpathSync(root)
    if (seen.has(real)) return
    seen.add(real)
    files(real, top ? SHIPPED : undefined)
    const pkg = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'))
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).sort()) {
      try { visit(resolveDependency(name, real), false) } catch { hash.update(`missing:${name}\0`) }
    }
  }
  visit(source, true)
  return hash.digest('hex')
}

/** Content-addressed packages this process already retained, by source stamp. */
const retainedBySource = new Map<string, { stamp: string; integrity: string }>()
let sharedPackageCache: string | null = null
/** Where launches retain Core packages: one content-addressed cache shared by every
 * run (each package is copied once per Core build instead of once per worktree).
 * Pins into it are accepted by resolution and left alone by per-pipeline collection. */
export function configureSharedRuntimePackageCache(directory: string | null): void { sharedPackageCache = directory ? path.resolve(directory) : null; retainedBySource.clear() }
export function sharedRuntimePackageCache(): string | null { return sharedPackageCache }

/** Copy only the selected package and its installed production dependency
 * closure. Resolution follows npm's actual nested versions, without downloads. */
function copyInstalledPackage(source: string, destination: string): void {
  const installed = new Map<string, string>()
  const copying = new Set<string>()
  let files = 0, bytes = 0, packages = 0
  const copy = (from: string, to: string, boundary: string): void => {
    const stat = fs.lstatSync(from)
    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(from), relative = path.relative(boundary, resolved)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Core package symlink escapes its package')
      copy(resolved, to, boundary)
    } else if (stat.isDirectory()) {
      const real = fs.realpathSync(from)
      if (copying.has(real)) throw new Error('Core package contains a cyclic symbolic link')
      copying.add(real)
      fs.mkdirSync(to, { recursive: true })
      try { for (const name of fs.readdirSync(from).sort()) if (!['node_modules', '.git', '.bin'].includes(name)) copy(path.join(from, name), path.join(to, name), boundary) }
      finally { copying.delete(real) }
    } else if (stat.isFile()) {
      if (++files > 100_000 || (bytes += stat.size) > 1024 * 1024 * 1024) throw new Error('Core runtime package exceeds retention limits')
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
      fs.chmodSync(to, stat.mode & 0o777)
    } else throw new Error('Core package contains a nonregular file')
  }
  const install = (from: string, to: string, root = false): void => {
    if (++packages > 2000) throw new Error('Core dependency closure exceeds retention limits')
    if (root) for (const entry of SHIPPED) { if (fs.existsSync(path.join(from, entry))) copy(path.join(from, entry), path.join(to, entry), from) }
    else copy(from, to, from)
    installed.set(fs.realpathSync(to), from)
    const pkg = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8'))
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).sort()) {
      if (!SAFE_PACKAGE.test(name)) throw new Error('Invalid Core package dependency')
      let dependency: string
      try { dependency = resolveDependency(name, from) }
      catch (error) { if (pkg.optionalDependencies?.[name]) continue; throw error }
      try {
        const present = resolveDependency(name, to)
        if (installed.get(present) === dependency) continue
      } catch { /* Not copied into this resolution scope yet. */ }
      install(dependency, path.join(to, 'node_modules', name))
    }
  }
  install(source, destination, true)
}

/** copyInstalledPackage with async I/O: the same selection, resolution and limits. The
 * closure is planned first (one directory listing at a time), then files are copied in
 * bounded parallel batches. */
async function copyInstalledPackageAsync(source: string, destination: string): Promise<void> {
  const installed = new Map<string, string>()
  const copying = new Set<string>()
  const planned: Array<{ from: string; to: string; mode: number }> = []
  let bytes = 0, packages = 0
  const plan = async (from: string, to: string, boundary: string): Promise<void> => {
    const stat = await fs.promises.lstat(from)
    if (stat.isSymbolicLink()) {
      const resolved = await fs.promises.realpath(from), relative = path.relative(boundary, resolved)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Core package symlink escapes its package')
      await plan(resolved, to, boundary)
    } else if (stat.isDirectory()) {
      const real = await fs.promises.realpath(from)
      if (copying.has(real)) throw new Error('Core package contains a cyclic symbolic link')
      copying.add(real)
      try { for (const name of (await fs.promises.readdir(from)).sort()) if (!['node_modules', '.git', '.bin'].includes(name)) await plan(path.join(from, name), path.join(to, name), boundary) }
      finally { copying.delete(real) }
    } else if (stat.isFile()) {
      if (planned.length >= 100_000 || (bytes += stat.size) > 1024 * 1024 * 1024) throw new Error('Core runtime package exceeds retention limits')
      planned.push({ from, to, mode: stat.mode & 0o777 })
    } else throw new Error('Core package contains a nonregular file')
  }
  const install = async (from: string, to: string, root = false): Promise<void> => {
    if (++packages > 2000) throw new Error('Core dependency closure exceeds retention limits')
    if (root) { for (const entry of SHIPPED) if (fs.existsSync(path.join(from, entry))) await plan(path.join(from, entry), path.join(to, entry), from) }
    else await plan(from, to, from)
    // Resolution below reads `to`: its package.json must exist before nested lookups.
    await fs.promises.mkdir(to, { recursive: true })
    const manifest = path.join(from, 'package.json')
    if (fs.existsSync(manifest)) await fs.promises.copyFile(manifest, path.join(to, 'package.json'))
    installed.set(await fs.promises.realpath(to), from)
    const pkg = JSON.parse(await fs.promises.readFile(manifest, 'utf8'))
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).sort()) {
      if (!SAFE_PACKAGE.test(name)) throw new Error('Invalid Core package dependency')
      let dependency: string
      try { dependency = resolveDependency(name, from) }
      catch (error) { if (pkg.optionalDependencies?.[name]) continue; throw error }
      try {
        const present = resolveDependency(name, to)
        if (installed.get(present) === dependency) continue
      } catch { /* Not copied into this resolution scope yet. */ }
      await install(dependency, path.join(to, 'node_modules', name))
    }
  }
  await install(source, destination, true)
  for (let index = 0; index < planned.length; index += IO_BATCH) {
    await Promise.all(planned.slice(index, index + IO_BATCH).map(async ({ from, to, mode }) => {
      await fs.promises.mkdir(path.dirname(to), { recursive: true })
      await fs.promises.copyFile(from, to)
      await fs.promises.chmod(to, mode)
    }))
  }
}

const preparing = new Map<string, Promise<void>>()

/**
 * Materialize the Core package a launch is about to retain into the shared cache with async
 * I/O, before the launch's synchronous retention. The first launch after every Core build
 * (each app update) copied and hashed ~16k files on the event loop, freezing the app for
 * 7–8 s; concurrent launches now share one preparation and only publish under the lock.
 * Best effort: on any failure the synchronous path still retains the package itself.
 */
export async function prepareRetainedAgentRuntime(cli: string): Promise<void> {
  const cache = sharedPackageCache
  if (!cache) return
  let root: string
  try { root = packageRoot(await fs.promises.realpath(cli)) } catch { return }
  const stamp = sourceStamp(root)
  const known = retainedBySource.get(root)
  if (known && known.stamp === stamp && fs.existsSync(path.join(cache, known.integrity))) return
  const key = root + '\0' + stamp
  const running = preparing.get(key)
  if (running) return running
  const task = (async () => {
    await fs.promises.mkdir(cache, { recursive: true, mode: 0o700 })
    const staged = path.join(cache, '.staged-' + randomUUID())
    try {
      await copyInstalledPackageAsync(root, staged)
      const integrity = await treeDigestAsync(staged, (await fs.promises.readdir(staged)).sort())
      const retained = path.join(cache, integrity)
      const existing = fs.existsSync(retained) ? await treeDigestAsync(retained, (await fs.promises.readdir(retained)).sort()) : null
      if (existing !== null && existing !== integrity) return
      withRuntimePackageLock(cache, () => {
        if (!fs.existsSync(retained)) fs.renameSync(staged, retained)
      })
      retainedBySource.set(root, { stamp, integrity })
    } catch {
      // The synchronous retention reports the real problem.
    } finally {
      await fs.promises.rm(staged, { recursive: true, force: true }).catch(() => {})
      preparing.delete(key)
    }
  })()
  preparing.set(key, task)
  return task
}

export function retainAgentRuntime(cli: string, contextPath: string): string {
  const pinFile = path.join(path.dirname(contextPath), 'desktop-runtime-package.json')
  if (fs.existsSync(pinFile)) return resolveRetainedAgentRuntimeSync(contextPath)
  const realCli = fs.realpathSync(cli)
  const root = packageRoot(realCli)
  const relativeCli = path.relative(root, realCli)
  if (relativeCli.startsWith('..') || path.isAbsolute(relativeCli)) throw new Error('Core CLI escapes its package')
  const cache = sharedPackageCache ?? path.join(path.dirname(path.dirname(contextPath)), 'runtime-packages')
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 })
  const shared = sharedPackageCache !== null && cache === sharedPackageCache
  const writePin = (integrity: string, retained: string): string => {
    const pin: RuntimePackagePin = { schemaVersion: 1, packageVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, integrity, root: retained, cli: relativeCli }
    try { fs.writeFileSync(pinFile, JSON.stringify(pin) + '\n', { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || resolveRetainedAgentRuntimeSync(contextPath) !== path.join(retained, relativeCli)) throw error }
    // The shared cache's collection keeps every package a pin still names, wherever the pin lives.
    if (shared) recordSharedPackageReference(cache, integrity, pinFile)
    return path.join(retained, relativeCli)
  }
  // The same unchanged source was already retained into this shared cache by this
  // process: pin it again instead of copying and hashing ~16k files per launch.
  // Under the package lock, so a collection can never remove it between check and pin.
  const stamp = sharedPackageCache ? sourceStamp(root) : null
  const known = stamp ? retainedBySource.get(root) : undefined
  if (stamp && known && known.stamp === stamp) {
    const pinned = withRuntimePackageLock(cache, () => fs.existsSync(path.join(cache, known.integrity)) ? writePin(known.integrity, path.join(cache, known.integrity)) : null)
    if (pinned) return pinned
  }
  return withRuntimePackageLock(cache, () => {
    const staged = path.join(cache, '.staged-' + randomUUID())
    try {
      copyInstalledPackage(root, staged)
      const integrity = treeDigest(staged)
      const retained = path.join(cache, integrity)
      if (fs.existsSync(retained)) {
        if (treeDigest(retained) !== integrity) throw new Error('Retained Core runtime integrity changed')
      } else {
        try { fs.renameSync(staged, retained) }
        catch (error) { if (!fs.existsSync(retained) || treeDigest(retained) !== integrity) throw error }
      }
      if (stamp) retainedBySource.set(root, { stamp, integrity })
      return writePin(integrity, retained)
    } finally { fs.rmSync(staged, { recursive: true, force: true }) }
  })
}

/** Execution-gate digests in flight, per retained root. */
const executionChecks = new Map<string, { running: Promise<string>; queued?: Promise<string> }>()

/**
 * A full content digest of `root` whose every read starts after this call. A burst of
 * resumes on one shared package shares work without weakening that rule: a caller never
 * joins a digest that has already started reading (a file it read before the caller asked
 * could have changed since); it joins the single digest queued behind it, which starts
 * when the running one ends. A burst therefore costs at most two digests, not one each.
 */
function freshRetainedDigest(root: string): Promise<string> {
  const digest = async () => treeDigestAsync(root, (await fs.promises.readdir(root)).sort())
  const state = executionChecks.get(root)
  if (!state) {
    const running = digest()
    const entry: { running: Promise<string>; queued?: Promise<string> } = { running }
    executionChecks.set(root, entry)
    void running.catch(() => {}).finally(() => { if (executionChecks.get(root) === entry && !entry.queued) executionChecks.delete(root) })
    return running
  }
  if (state.queued) return state.queued
  const queued = state.running.catch(() => {}).then(() => {
    // Promote: later callers queue behind this digest, which has now started.
    state.running = queued
    state.queued = undefined
    return digest()
  })
  state.queued = queued
  void queued.catch(() => {}).finally(() => { if (executionChecks.get(root) === state && state.running === queued && !state.queued) executionChecks.delete(root) })
  return queued
}

/**
 * The gate before anything executes a retained Core package (resume, controls, recovery):
 * the pin rules plus a full, uncached content digest that must equal the pinned
 * integrity. The digest runs with async I/O, so a burst of resumes no longer freezes the
 * app for ~0.8 s per resume (16k files hashed on the event loop).
 */
export async function resolveRetainedAgentRuntime(contextPath: string): Promise<string> {
  const { pin, expected } = readRetainedPin(contextPath)
  if (await freshRetainedDigest(expected) !== pin.integrity) throw new Error('The original retained Core package failed its integrity check. Restore it before continuing.')
  return retainedCli(expected, pin)
}

/** Synchronous gate for the retention path that is itself synchronous (an existing pin). */
function resolveRetainedAgentRuntimeSync(contextPath: string): string {
  const { pin, expected } = readRetainedPin(contextPath)
  if (treeDigest(expected) !== pin.integrity) throw new Error('The original retained Core package failed its integrity check. Restore it before continuing.')
  return retainedCli(expected, pin)
}
