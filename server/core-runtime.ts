import fs from 'fs'
import path from 'path'
import { resolveHome } from './artifact-registry'
import { getBundledCoreRoot } from './bundled-core'
import { compareVersions } from './semver-lite'

export type CoreRuntimeSource = 'override' | 'managed' | 'bundled' | 'local' | 'global'
export interface CoreRuntime { root: string; cli: string; version: string; source: CoreRuntimeSource }
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function managedCoreRoot(home?: string): string {
  return path.join(resolveHome(home), '.specrails', 'core')
}

export function frameworkRoot(home?: string): string {
  return path.join(resolveHome(home), '.specrails', 'framework')
}

export function readCurrentFrameworkVersion(home?: string): string | null {
  const current = path.join(frameworkRoot(home), 'current')
  try {
    // realpath also rejects dangling pointers; a pathname alone is not an install.
    const link = fs.lstatSync(current)
    const target = link.isSymbolicLink() ? fs.readlinkSync(current) : current
    const resolved = fs.realpathSync(path.isAbsolute(target) ? target : path.resolve(frameworkRoot(home), target))
    const name = path.basename(resolved)
    if (VERSION.test(name)) return name
    const versions = new Set<string>()
    for (const file of fs.readdirSync(resolved)) {
      if (!/^\.framework-stamp.*\.json$/.test(file)) continue
      const value = JSON.parse(fs.readFileSync(path.join(resolved, file), 'utf8')).version
      if (typeof value === 'string' && VERSION.test(value)) versions.add(value)
    }
    return versions.size === 1 ? [...versions][0]! : null
  } catch { return null }
}

export function readCoreRuntime(root: string, source: CoreRuntimeSource): CoreRuntime | null {
  try {
    const realRoot = fs.realpathSync(root)
    const pkg = JSON.parse(fs.readFileSync(path.join(realRoot, 'package.json'), 'utf8'))
    if (pkg.name && pkg.name !== 'specrails-core') return null
    if (typeof pkg.version !== 'string' || !VERSION.test(pkg.version)) return null
    const cli = fs.realpathSync(path.join(realRoot, 'dist', 'installer', 'cli.js'))
    if (!fs.statSync(cli).isFile()) return null
    return { root: realRoot, cli, version: pkg.version, source }
  } catch { return null }
}

function packageForBinary(binary: string, source: CoreRuntimeSource): CoreRuntime | null {
  const candidates = path.isAbsolute(binary) || /[/\\]/.test(binary)
    ? [path.resolve(binary)]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(dir =>
      process.platform === 'win32'
        ? ['', '.cmd', '.exe', '.bat'].map(ext => path.join(dir, binary + ext))
        : [path.join(dir, binary)])
  for (const candidate of candidates) {
    try {
      let directory = path.dirname(fs.realpathSync(candidate))
      // npm's Windows shim is beside node_modules, not inside the package.
      const adjacent = readCoreRuntime(path.join(directory, 'node_modules', 'specrails-core'), source)
      if (adjacent) return adjacent
      for (let depth = 0; depth < 6; depth++) {
        const runtime = readCoreRuntime(directory, source)
        if (runtime) return runtime
        const parent = path.dirname(directory)
        if (directory === parent) break
        directory = parent
      }
    } catch { /* missing PATH entry */ }
  }
  return null
}

/** Read-only package discovery. No npm downloads and no execution of a PATH shim. */
export function discoverExternalCoreRuntimes(): CoreRuntime[] {
  const result: CoreRuntime[] = []
  try {
    const pkg = require.resolve('specrails-core/package.json')
    const local = readCoreRuntime(path.dirname(pkg), 'local')
    if (local) result.push(local)
  } catch { /* not a local dependency */ }
  const global = packageForBinary('specrails-core', 'global')
  if (global) result.push(global)
  return result
}

/** A caller supplying an isolated home can also supply its isolated external inventory. */
export function resolveCoreRuntime(home?: string, external?: CoreRuntime[]): CoreRuntime | null {
  const current = readCurrentFrameworkVersion(home)
  const override = process.env.SPECRAILS_CORE_BIN
  if (override) {
    const runtime = packageForBinary(override, 'override')
    if (!runtime) throw new Error('SPECRAILS_CORE_BIN does not resolve to a usable specrails-core package.')
    if (![4, 5].includes(Number(runtime.version.split('.')[0]))) throw new Error('The explicit Core package is not compatible with this Desktop. Supported Core majors: 4 and 5.')
    if (current && compareVersions(runtime.version, current) < 0) throw new Error(`The explicit Core ${runtime.version} is older than active framework ${current}; Desktop will not downgrade it.`)
    return runtime
  }
  const candidates: CoreRuntime[] = []
  const bundled = getBundledCoreRoot()
  if (bundled) {
    const runtime = readCoreRuntime(bundled, 'bundled')
    if (runtime) candidates.push(runtime)
  }
  // Only activated managed packages are candidates. Failed staged updates must
  // not become active simply because their directory exists after a restart.
  if (current) {
    const managed = readCoreRuntime(path.join(managedCoreRoot(home), current, 'node_modules', 'specrails-core'), 'managed')
    if (managed && managed.version === current) candidates.push(managed)
  }
  candidates.push(...(external ?? (home === undefined ? discoverExternalCoreRuntimes() : [])))
  const compatible = candidates.filter(candidate => {
    const major = Number(candidate.version.split('.')[0])
    return major >= 4 && major <= 5
  }).sort((a, b) => compareVersions(b.version, a.version))
  const selected = compatible[0] ?? null
  if (current && (!selected || compareVersions(selected.version, current) < 0)) {
    throw new Error(`Core framework ${current} is installed, but its runtime package is unavailable. Reinstall Core ${current} or a newer compatible version; Desktop will not downgrade it.`)
  }
  return selected
}

export function getCoreRuntimeStatus(home?: string): { runtime: CoreRuntime | null; error: string | null } {
  try { return { runtime: resolveCoreRuntime(home), error: null } }
  catch (error) { return { runtime: null, error: error instanceof Error ? error.message : String(error) } }
}

/** Actual provider links outrank an old workspace seed marker. Never attribute
 * global current to a copied or deliberately pinned project. */
export function readProjectCoreVersion(root: string, repoPath: string, home?: string): { version: string | null; providerVersions: Record<string, string>; recordedVersion: string | null; mixed: boolean } {
  const providerVersions: Record<string, string> = {}
  let recordedVersion: string | null = null
  for (const marker of [path.join(root, '.specrails', 'specrails-version'), path.join(repoPath, '.specrails-version')]) {
    try {
      const value = fs.readFileSync(marker, 'utf8').trim()
      if (VERSION.test(value)) { recordedVersion = value; break }
    } catch { /* no legacy marker */ }
  }
  let framework = frameworkRoot(home)
  try { framework = fs.realpathSync(framework) } catch { /* no managed framework */ }
  for (const [provider, directory] of Object.entries({ claude: '.claude', codex: '.codex', gemini: '.gemini', kimi: '.kimi-code' })) {
    const versions = new Set<string>()
    const inspect = (entry: string, depth: number): void => {
      try {
        const resolved = fs.realpathSync(entry)
        const relative = path.relative(framework, resolved)
        const version = relative.split(path.sep)[0]!
        if (!path.isAbsolute(relative) && !relative.startsWith('..') && VERSION.test(version)) {
          versions.add(version)
          return
        }
        if (depth > 0 && fs.statSync(entry).isDirectory()) {
          for (const child of fs.readdirSync(entry)) inspect(path.join(entry, child), depth - 1)
        }
      } catch { /* provider absent or dangling */ }
    }
    inspect(path.join(root, directory), 2)
    if (versions.size === 1) providerVersions[provider] = [...versions][0]!
  }
  const versions = new Set(Object.values(providerVersions))
  const linked = versions.size === 1 ? [...versions][0]! : null
  const mixed = fs.existsSync(path.join(root, '.specrails', 'core-update-pending.json')) || versions.size > 1 || Boolean(linked && recordedVersion && linked !== recordedVersion)
  return { version: mixed ? null : linked ?? recordedVersion, providerVersions, recordedVersion, mixed }
}
