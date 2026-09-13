import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
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
  const resolveDependency = (name: string, from: string): string => {
    const require = createRequire(path.join(from, 'package.json'))
    try { return packageRoot(require.resolve(name + '/package.json'), name) }
    catch { return packageRoot(require.resolve(name), name) }
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

export function retainAgentRuntime(cli: string, contextPath: string): string {
  const pinFile = path.join(path.dirname(contextPath), 'desktop-runtime-package.json')
  if (fs.existsSync(pinFile)) return resolveRetainedAgentRuntime(contextPath)
  const realCli = fs.realpathSync(cli)
  const root = packageRoot(realCli)
  const relativeCli = path.relative(root, realCli)
  if (relativeCli.startsWith('..') || path.isAbsolute(relativeCli)) throw new Error('Core CLI escapes its package')
  const cache = path.join(path.dirname(path.dirname(contextPath)), 'runtime-packages')
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 })
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
    const pin: RuntimePackagePin = { schemaVersion: 1, packageVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, integrity, root: retained, cli: relativeCli }
    try { fs.writeFileSync(pinFile, JSON.stringify(pin) + '\n', { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || resolveRetainedAgentRuntime(contextPath) !== path.join(retained, relativeCli)) throw error }
    return path.join(retained, relativeCli)
  } finally { fs.rmSync(staged, { recursive: true, force: true }) }
}

export function resolveRetainedAgentRuntime(contextPath: string): string {
  const pinFile = path.join(path.dirname(contextPath), 'desktop-runtime-package.json')
  if (!fs.existsSync(pinFile)) throw new Error('Original runtime identity is unrecorded. Restore a proven original Core package before continuing this saved execution.')
  const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8')) as RuntimePackagePin
  const expected = path.join(path.dirname(path.dirname(contextPath)), 'runtime-packages', pin.integrity)
  if (pin.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(pin.integrity) || pin.root !== expected || !fs.existsSync(expected) || fs.realpathSync(expected) !== path.resolve(expected)
    || typeof pin.cli !== 'string' || path.isAbsolute(pin.cli) || pin.cli.split(/[\\/]/).includes('..')) throw new Error('The original retained Core package is unavailable or invalid. Restore it before continuing.')
  if (treeDigest(expected) !== pin.integrity) throw new Error('The original retained Core package failed its integrity check. Restore it before continuing.')
  const cli = path.join(expected, pin.cli)
  if (!fs.statSync(cli).isFile()) throw new Error('The original Core executable is unavailable')
  return cli
}
