import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { withRuntimePackageLock } from './agent-runtime-package-lock'
import { sharedRuntimePackageCache } from './agent-runtime-package'
import { SHARED_REFS_DIRECTORY } from './agent-runtime-package-refs'

const DIGEST = /^[a-f0-9]{64}$/
const STAGED = /^\.staged-[a-f0-9-]{36}$/
const GARBAGE = /^\.garbage-[a-f0-9]{64}-[a-f0-9-]{36}$/
/** Collects only expired, unreferenced package directories. Every run pin is
 * inspected before the first mutation; an unknown pin protects the whole cache.
 * Callers must use the same package lock when publishing new retained pins. */
export function collectUnreferencedRuntimePackages(pipelineRoot: string, options: { dryRun: boolean; minimumAgeMs: number; now: number }): string[] {
  if (!Number.isSafeInteger(options.minimumAgeMs) || options.minimumAgeMs < 86_400_000 || !Number.isFinite(options.now)) throw new Error('Package retention requires an age of at least one day and a valid clock')
  if (!fs.existsSync(pipelineRoot)) return []
  if (fs.lstatSync(pipelineRoot).isSymbolicLink() || !fs.statSync(pipelineRoot).isDirectory()) throw new Error('Pipeline storage must be a real directory')
  const cache = path.join(pipelineRoot, 'runtime-packages')
  if (!fs.existsSync(cache)) return []
  return withRuntimePackageLock(cache, () => {
    const referenced = new Set<string>()
    for (const entry of fs.readdirSync(pipelineRoot, { withFileTypes: true })) {
      if (entry.name === 'runtime-packages') continue
      if (entry.isSymbolicLink()) throw new Error('Cannot collect packages across an unknown pipeline link')
      if (!entry.isDirectory()) continue
      const directory = path.join(pipelineRoot, entry.name)
      if (entry.name === '.retention') {
        if (fs.readdirSync(directory).length) throw new Error('Runtime quarantine must be recovered before package collection')
        continue
      }
      const pinFile = path.join(directory, 'desktop-runtime-package.json')
      if (!fs.existsSync(pinFile)) {
        if (fs.existsSync(path.join(directory, 'agent-runtime-request.json'))) throw new Error('A saved execution has no proven original package pin')
        continue
      }
      const stat = fs.lstatSync(pinFile)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('Invalid runtime package pin')
      const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'))
      // A pin into the shared launch cache does not reference this cache.
      const shared = sharedRuntimePackageCache()
      if (shared && typeof pin.integrity === 'string' && DIGEST.test(pin.integrity) && pin.root === path.join(shared, pin.integrity)) continue
      if (pin.schemaVersion !== 1 || typeof pin.integrity !== 'string' || !DIGEST.test(pin.integrity) ||
        pin.root !== path.join(cache, pin.integrity) || typeof pin.cli !== 'string' || !pin.cli || path.isAbsolute(pin.cli) || pin.cli.split(/[\\/]/).includes('..')) throw new Error('Runtime package pin scope is invalid')
      referenced.add(pin.integrity)
    }
    const eligible: string[] = []
    for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
      if (!DIGEST.test(entry.name) && !GARBAGE.test(entry.name) && !STAGED.test(entry.name)) continue
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Runtime package storage contains an invalid entry')
      if (referenced.has(entry.name)) continue
      const stat = fs.statSync(path.join(cache, entry.name))
      if (stat.mtimeMs > options.now || options.now - stat.mtimeMs < options.minimumAgeMs) continue
      eligible.push(entry.name)
    }
    for (const name of options.dryRun ? [] : eligible) {
      const original = path.join(cache, name)
      // A crashed deletion cannot leave a partially deleted digest available to
      // a future publisher. The private garbage name is safe to retry later.
      const garbage = GARBAGE.test(name) || STAGED.test(name) ? original : path.join(cache, `.garbage-${name}-${randomUUID()}`)
      if (garbage !== original) fs.renameSync(original, garbage)
      fs.rmSync(garbage, { recursive: true })
    }
    return eligible.sort()
  })
}

export interface SharedPackageCollection {
  /** Package digests moved out of the cache (their directories are deleted by `removeCollectedPackages`). */
  collected: string[]
  /** Private garbage directories to delete, off the package lock. */
  garbage: string[]
  /** Packages kept because a pin still names them. */
  referenced: string[]
}

/** Pipeline directories of a Specrails data home's projects: `<slug>/workspace` and `<slug>/worktrees/<run>/<ticket>`. */
function dataHomePipelines(projectsRoot: string): string[] {
  const pipelines: string[] = []
  const list = (directory: string): fs.Dirent[] => { try { return fs.readdirSync(directory, { withFileTypes: true }) } catch { return [] } }
  for (const project of list(projectsRoot)) {
    if (!project.isDirectory()) continue
    const base = path.join(projectsRoot, project.name)
    pipelines.push(path.join(base, 'workspace', '.specrails', 'pipeline'))
    for (const run of list(path.join(base, 'worktrees'))) {
      if (!run.isDirectory()) continue
      for (const checkout of list(path.join(base, 'worktrees', run.name))) {
        if (checkout.isDirectory()) pipelines.push(path.join(base, 'worktrees', run.name, checkout.name, '.specrails', 'pipeline'))
      }
    }
  }
  return pipelines
}

/** The digest a pin file names in this cache, or null when it names another one or is unreadable. */
function sharedPinIntegrity(pinFile: string, cache: string): string | null {
  try {
    const stat = fs.lstatSync(pinFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) return null
    const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8')) as { integrity?: unknown; root?: unknown }
    return typeof pin.integrity === 'string' && DIGEST.test(pin.integrity) && pin.root === path.join(cache, pin.integrity) ? pin.integrity : null
  } catch { return null }
}

/**
 * Bounded collection of the shared launch cache (one package per Core build). It keeps
 * the `keepRecent` most recently used packages (the current build is the one launches
 * just pinned), every package a pin file still names (a live run, a paused or retained
 * run that can still resume or continue, wherever its pin lives: recorded references and
 * the data home's pipelines), and anything younger than `minimumAgeMs`. The rest is moved
 * to private garbage names under the package lock; the caller deletes them off the lock.
 */
export function collectSharedRuntimePackages(options: { cache: string; projectsRoot?: string; pipelineRoots?: readonly string[]; keepRecent: number; minimumAgeMs: number; now: number; dryRun?: boolean }): SharedPackageCollection {
  const { cache } = options
  if (!Number.isSafeInteger(options.keepRecent) || options.keepRecent < 1) throw new Error('The shared package cache keeps at least the current build')
  if (!Number.isFinite(options.minimumAgeMs) || options.minimumAgeMs < 0 || !Number.isFinite(options.now)) throw new Error('Package retention requires a valid age and clock')
  if (!fs.existsSync(cache)) return { collected: [], garbage: [], referenced: [] }
  return withRuntimePackageLock(cache, () => {
    const referenced = new Set<string>()
    const refsRoot = path.join(cache, SHARED_REFS_DIRECTORY)
    for (const integrity of fs.existsSync(refsRoot) ? fs.readdirSync(refsRoot) : []) {
      const directory = path.join(refsRoot, integrity)
      if (!DIGEST.test(integrity) || !fs.statSync(directory).isDirectory()) continue
      for (const name of fs.readdirSync(directory)) {
        const record = path.join(directory, name)
        let pinFile: unknown
        try { pinFile = (JSON.parse(fs.readFileSync(record, 'utf8')) as { pinFile?: unknown }).pinFile } catch { pinFile = undefined }
        if (typeof pinFile === 'string' && sharedPinIntegrity(pinFile, cache) === integrity) referenced.add(integrity)
        else if (!options.dryRun) fs.rmSync(record, { force: true })
      }
    }
    // Pins written before references were recorded, and any a reference does not name.
    const pipelines = [...(options.projectsRoot ? dataHomePipelines(options.projectsRoot) : []), ...(options.pipelineRoots ?? [])]
    for (const pipeline of pipelines) {
      let runs: fs.Dirent[]
      try { runs = fs.readdirSync(pipeline, { withFileTypes: true }) } catch { continue }
      for (const run of runs) {
        if (!run.isDirectory() || run.name === 'runtime-packages') continue
        const integrity = sharedPinIntegrity(path.join(pipeline, run.name, 'desktop-runtime-package.json'), cache)
        if (integrity) referenced.add(integrity)
      }
    }
    const packages = fs.readdirSync(cache, { withFileTypes: true })
      .filter(entry => DIGEST.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => ({ name: entry.name, used: fs.statSync(path.join(cache, entry.name)).mtimeMs }))
      .sort((a, b) => b.used - a.used || a.name.localeCompare(b.name))
    const recent = new Set(packages.slice(0, options.keepRecent).map(entry => entry.name))
    const collected = packages.filter(entry => !recent.has(entry.name) && !referenced.has(entry.name) && options.now - entry.used >= options.minimumAgeMs).map(entry => entry.name)
    const garbage: string[] = []
    // Interrupted deletions from an earlier collection are finished too.
    for (const entry of fs.readdirSync(cache)) if (GARBAGE.test(entry) || STAGED.test(entry) && options.now - fs.statSync(path.join(cache, entry)).mtimeMs >= 86_400_000) garbage.push(path.join(cache, entry))
    if (!options.dryRun) {
      for (const name of collected) {
        const target = path.join(cache, `.garbage-${name}-${randomUUID()}`)
        fs.renameSync(path.join(cache, name), target)
        fs.rmSync(path.join(refsRoot, name), { recursive: true, force: true })
        garbage.push(target)
      }
    }
    return { collected: collected.sort(), garbage: options.dryRun ? [] : garbage, referenced: [...referenced].sort() }
  })
}

/** Delete collected packages without blocking the event loop (each is ~16k files). */
export async function removeCollectedPackages(garbage: readonly string[]): Promise<void> {
  for (const directory of garbage) await fs.promises.rm(directory, { recursive: true, force: true })
}
