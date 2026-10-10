import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'node:child_process'
import {
  linkNodeModulesIntoWorktree,
  isWorktreeNodeModulesEnabled,
  authenticateWarmNodeModulesLinks,
  dependencyInputs,
  differingDependencyInput,
  WORKTREE_DEPENDENCY_CACHES,
} from './worktree-node-modules'

let baseRepo: string
let worktree: string

/** Build the base checkout. Tracked-looking files (outside dependency trees and
 *  dot-dirs) are mirrored into the worktree, as `git worktree add` would, so the
 *  freshness guard sees matching dependency inputs by default. */
function mkRepo(structure: string[]): void {
  for (const rel of structure) {
    const segments = rel.split('/').filter(Boolean)
    const tracked = !segments.some(segment => segment === 'node_modules' || segment.startsWith('.'))
    for (const root of tracked ? [baseRepo, worktree] : [baseRepo]) {
      const abs = path.join(root, ...rel.split('/'))
      if (rel.endsWith('/')) fs.mkdirSync(abs, { recursive: true })
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, '{}')
      }
    }
  }
}

beforeEach(() => {
  baseRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-nm-base-'))
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-nm-wt-'))
  delete process.env.SPECRAILS_WORKTREE_NODE_MODULES
})

afterEach(() => {
  fs.rmSync(baseRepo, { recursive: true, force: true })
  fs.rmSync(worktree, { recursive: true, force: true })
  delete process.env.SPECRAILS_WORKTREE_NODE_MODULES
})

describe('linkNodeModulesIntoWorktree', () => {
  it('prepares a worktree-owned node_modules directory whose package entries link into the base checkout', () => {
    mkRepo(['package.json', 'node_modules/left-pad/index.js'])
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res.linked).toEqual(['node_modules'])
    expect(res.warnings).toEqual([])
    const dest = path.join(worktree, 'node_modules')
    // The directory itself is REAL (tool caches such as .vite stay local); each package is a link.
    expect(fs.lstatSync(dest).isDirectory()).toBe(true)
    expect(fs.lstatSync(path.join(dest, 'left-pad')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(dest, 'left-pad', 'index.js'))).toBe(true)
  })

  it('links nested package installs (client/node_modules) at the same relative path', () => {
    mkRepo([
      'package.json',
      'node_modules/a.js',
      'client/package.json',
      'client/node_modules/b.js',
    ])
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res.linked.sort()).toEqual(['client/node_modules', 'node_modules'])
    expect(fs.lstatSync(path.join(worktree, 'client', 'node_modules')).isDirectory()).toBe(true)
    expect(fs.lstatSync(path.join(worktree, 'client', 'node_modules', 'b.js')).isSymbolicLink()).toBe(true)
  })

  it('skips package dirs whose base checkout has no install', () => {
    mkRepo(['package.json', 'client/package.json', 'client/node_modules/x.js'])
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res.linked).toEqual(['client/node_modules'])
  })

  it('never overwrites an existing destination (real dir or prior link)', () => {
    mkRepo(['package.json', 'node_modules/fresh.js'])
    fs.mkdirSync(path.join(worktree, 'node_modules'))
    fs.writeFileSync(path.join(worktree, 'node_modules', 'agent-made.js'), 'x')
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res.linked).toEqual([])
    expect(fs.lstatSync(path.join(worktree, 'node_modules')).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(worktree, 'node_modules', 'agent-made.js'))).toBe(true)
  })

  it('ignores dot-dirs and packages inside node_modules trees', () => {
    mkRepo([
      'package.json',
      'node_modules/dep/package.json',
      'node_modules/dep/node_modules/inner.js',
      '.specrails/package.json',
      '.specrails/node_modules/tool.js',
    ])
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res.linked).toEqual(['node_modules'])
    expect(fs.existsSync(path.join(worktree, '.specrails'))).toBe(false)
  })

  it('is depth-bounded: a package three levels down is not discovered', () => {
    mkRepo([
      'package.json',
      'node_modules/a.js',
      'a/b/c/package.json',
      'a/b/c/node_modules/deep.js',
    ])
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res.linked).toEqual(['node_modules'])
  })

  it('reports a warning (not a throw) when the link cannot be created', () => {
    mkRepo(['client/package.json', 'client/node_modules/x.js'])
    // Occupy the parent path with a FILE so mkdir/symlink of client/... fails.
    fs.rmSync(path.join(worktree, 'client'), { recursive: true, force: true })
    fs.writeFileSync(path.join(worktree, 'client'), 'not a dir')
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res.linked).toEqual([])
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0]).toContain('client/node_modules')
  })

  it('kill switch SPECRAILS_WORKTREE_NODE_MODULES=false restores the cold start', () => {
    mkRepo(['package.json', 'node_modules/a.js'])
    process.env.SPECRAILS_WORKTREE_NODE_MODULES = 'false'
    expect(isWorktreeNodeModulesEnabled()).toBe(false)
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res.linked).toEqual([])
    expect(fs.existsSync(path.join(worktree, 'node_modules'))).toBe(false)
  })

  it('a repo with no package.json anywhere is a clean no-op', () => {
    mkRepo(['src/main.rs'])
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res).toEqual({ linked: [], authenticated: [], evidence: [], warnings: [] })
  })

  it('authenticates and fingerprints the links it creates', () => {
    mkRepo(['package.json', 'node_modules/a.js', 'client/package.json', 'client/node_modules/b.js'])
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    // Authentication is per package ENTRY: the links, never the worktree-owned directory around them.
    expect(res.authenticated.sort()).toEqual(['client/node_modules/b.js', 'node_modules/a.js'])
    expect(res.evidence.map((e) => e.path).sort()).toEqual(['client/node_modules/b.js', 'node_modules/a.js'])
    for (const entry of res.evidence) {
      expect(entry.kind).toBe('symlink')
      expect(entry.digest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('re-authenticates a link a previous pass created (resume keeps the exclusion)', () => {
    mkRepo(['package.json', 'node_modules/a.js'])
    const first = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(first.linked).toEqual(['node_modules'])
    const second = linkNodeModulesIntoWorktree(baseRepo, worktree)
    // Nothing new is created, but the pre-existing link stays authorized.
    expect(second.linked).toEqual([])
    expect(second.authenticated).toEqual(['node_modules/a.js'])
    expect(second.evidence).toEqual(first.evidence)
  })

  it('does not authenticate a destination that is a real directory', () => {
    mkRepo(['package.json', 'node_modules/a.js'])
    fs.mkdirSync(path.join(worktree, 'node_modules'))
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res.authenticated).toEqual([])
    expect(res.evidence).toEqual([])
  })
})

describe('authenticateWarmNodeModulesLinks', () => {
  it('authenticates root and nested links pointing at the base checkout', () => {
    mkRepo(['package.json', 'node_modules/a.js', 'client/package.json', 'client/node_modules/b.js'])
    linkNodeModulesIntoWorktree(baseRepo, worktree)
    const evidence = authenticateWarmNodeModulesLinks(baseRepo, worktree)
    expect(evidence.map((e) => e.path).sort()).toEqual(['client/node_modules/b.js', 'node_modules/a.js'])
  })

  it('refuses a real directory, a copy, and a foreign link target', () => {
    mkRepo(['package.json', 'node_modules/a.js'])
    // real dir
    fs.mkdirSync(path.join(worktree, 'node_modules'))
    expect(authenticateWarmNodeModulesLinks(baseRepo, worktree)).toEqual([])
    fs.rmSync(path.join(worktree, 'node_modules'), { recursive: true, force: true })
    // link pointing somewhere else entirely
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-nm-foreign-'))
    fs.symlinkSync(foreign, path.join(worktree, 'node_modules'))
    expect(authenticateWarmNodeModulesLinks(baseRepo, worktree)).toEqual([])
    fs.rmSync(foreign, { recursive: true, force: true })
  })

  it('refuses a dangling link even when the name and relative path match', () => {
    mkRepo(['package.json', 'node_modules/a.js'])
    linkNodeModulesIntoWorktree(baseRepo, worktree)
    fs.rmSync(path.join(baseRepo, 'node_modules'), { recursive: true, force: true })
    expect(authenticateWarmNodeModulesLinks(baseRepo, worktree)).toEqual([])
  })

  it('is depth-bounded like the linker and never walks into a linked tree', () => {
    mkRepo(['a/b/c/package.json', 'a/b/c/node_modules/deep.js'])
    fs.mkdirSync(path.join(worktree, 'a', 'b', 'c'), { recursive: true })
    fs.symlinkSync(path.join(baseRepo, 'a/b/c/node_modules'), path.join(worktree, 'a/b/c/node_modules'))
    expect(authenticateWarmNodeModulesLinks(baseRepo, worktree)).toEqual([])
  })

  it('returns nothing for a worktree with no dependency entries', () => {
    expect(authenticateWarmNodeModulesLinks(baseRepo, worktree)).toEqual([])
  })
})

describe('warm dependencies for a registered Git subdirectory', () => {
  const registration = 'apps/catalog'
  function write(root: string, relative: string, content: string): void {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  function git(...args: string[]): void {
    const child = spawnSync('git', args, { encoding: 'utf8', timeout: 10_000 })
    expect(child.status, child.stderr).toBe(0)
  }
  function fixture(linkedSource = false): { source: string; selected: string; projected: string } {
    write(baseRepo, 'package.json', '{"name":"parent","private":true}')
    write(baseRepo, '.gitignore', 'node_modules/\n')
    for (const relative of [registration, `${registration}/packages/tool`, `${registration}/a/b/c`, 'apps/sibling']) {
      write(baseRepo, `${relative}/package.json`, JSON.stringify({ name: path.basename(relative), private: true }))
    }
    git('init', '-q', baseRepo)
    git('-C', baseRepo, 'add', '.')
    git('-C', baseRepo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline')
    const source = linkedSource ? path.join(baseRepo, 'linked-source') : baseRepo
    if (linkedSource) git('-C', baseRepo, 'worktree', 'add', '--detach', source, 'HEAD')
    git('-C', baseRepo, 'worktree', 'add', '--detach', worktree, 'HEAD')
    return { source, selected: path.join(source, registration), projected: path.join(worktree, registration) }
  }
  function install(root: string, name = 'react-markdown'): void {
    write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', main: 'index.cjs' }))
    write(root, `node_modules/${name}/index.cjs`, `module.exports = ${JSON.stringify(name + '-fixture')}\n`)
    write(root, 'node_modules/.yarn-state.yml', `__metadata:\n  version: 1\n  nmMode: classic\n${JSON.stringify(name + '@npm:1.0.0')}:\n  locations:\n    - ${JSON.stringify('node_modules/' + name)}\n`)
  }
  function link(source: string, destination: string): void {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : undefined)
  }
  function snapshot(root: string): string {
    return JSON.stringify(fs.readdirSync(root, { recursive: true, withFileTypes: true }).map(entry => {
      const file = path.join(entry.parentPath, entry.name)
      return [path.relative(root, file), entry.isSymbolicLink() ? fs.readlinkSync(file) : entry.isDirectory() ? 'directory' : fs.readFileSync(file).toString('base64')]
    }).sort(([a], [b]) => a.localeCompare(b)))
  }

  it.each([false, true])('projects package resolution and Yarn state without widening scope (source is a worktree: %s)', linkedSource => {
    const { source, selected, projected } = fixture(linkedSource)
    install(selected)
    install(source, 'unrelated-root')
    install(path.join(source, 'apps/sibling'), 'unrelated-sibling')
    write(selected, 'node_modules/.bin/markdown', '#!/usr/bin/env node\n')
    for (const cache of WORKTREE_DEPENDENCY_CACHES) write(selected, `node_modules/${cache}/source-cache`, 'keep source cache')
    const before = snapshot(selected)
    if (linkedSource) write(worktree, 'node_modules/already-installed', 'preserve root install')

    const result = linkNodeModulesIntoWorktree(selected, worktree)
    expect(result.linked).toEqual([`${registration}/node_modules`])
    expect(result.warnings).toEqual([])
    expect(result.authenticated.sort()).toEqual([
      `${registration}/node_modules/.bin`, `${registration}/node_modules/.yarn-state.yml`, `${registration}/node_modules/react-markdown`,
    ])
    expect(authenticateWarmNodeModulesLinks(selected, worktree)).toEqual(result.evidence)
    const child = spawnSync(process.execPath, ['-e', "const fs=require('node:fs');console.log(JSON.stringify({value:require('react-markdown'),state:fs.readFileSync('node_modules/.yarn-state.yml','utf8')}))"], {
      cwd: projected, encoding: 'utf8', timeout: 10_000,
    })
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toMatchObject({ value: 'react-markdown-fixture', state: expect.stringContaining('react-markdown@npm:1.0.0') })
    for (const cache of WORKTREE_DEPENDENCY_CACHES) {
      expect(fs.lstatSync(path.join(projected, 'node_modules', cache)).isSymbolicLink()).toBe(false)
      expect(fs.existsSync(path.join(projected, 'node_modules', cache, 'source-cache'))).toBe(false)
      write(projected, `node_modules/${cache}/worktree-cache`, 'local cache')
    }
    expect(snapshot(selected)).toBe(before)
    expect(fs.existsSync(path.join(worktree, 'node_modules/react-markdown'))).toBe(false)
    expect(fs.existsSync(path.join(worktree, 'node_modules/unrelated-root'))).toBe(false)
    expect(fs.existsSync(path.join(worktree, 'apps/sibling/node_modules'))).toBe(false)
    if (linkedSource) expect(fs.readFileSync(path.join(worktree, 'node_modules/already-installed'), 'utf8')).toBe('preserve root install')
    else expect(fs.existsSync(path.join(worktree, 'node_modules'))).toBe(false)
    expect(linkNodeModulesIntoWorktree(selected, worktree)).toMatchObject({ linked: [], evidence: result.evidence })
  })

  it('keeps child discovery and restart authentication bounded relative to the registered source', () => {
    const { selected } = fixture()
    install(path.join(selected, 'packages/tool'), 'child-package')
    install(path.join(selected, 'a/b/c'), 'too-deep')
    const result = linkNodeModulesIntoWorktree(selected, worktree)
    expect(result.linked).toEqual([`${registration}/packages/tool/node_modules`])
    expect(result.authenticated.sort()).toEqual([
      `${registration}/packages/tool/node_modules/.yarn-state.yml`, `${registration}/packages/tool/node_modules/child-package`,
    ])
    expect(authenticateWarmNodeModulesLinks(selected, worktree)).toEqual(result.evidence)
    expect(fs.existsSync(path.join(worktree, registration, 'a/b/c/node_modules'))).toBe(false)
  })

  it.each(['entries', 'directory'])('preserves historical misplaced %s while preparing the correct layout', layout => {
    const { selected, projected } = fixture()
    install(selected)
    const historical = path.join(worktree, 'node_modules')
    if (layout === 'directory') link(path.join(selected, 'node_modules'), historical)
    else {
      link(path.join(selected, 'node_modules/react-markdown'), path.join(historical, 'react-markdown'))
      write(worktree, 'node_modules/user-created', 'preserve local work')
    }
    const result = linkNodeModulesIntoWorktree(selected, worktree)
    expect(result.linked).toEqual([`${registration}/node_modules`])
    expect(fs.lstatSync(path.join(projected, 'node_modules')).isDirectory()).toBe(true)
    if (layout === 'directory') expect(fs.realpathSync(historical)).toBe(fs.realpathSync(path.join(selected, 'node_modules')))
    else expect(fs.readFileSync(path.join(historical, 'user-created'), 'utf8')).toBe('preserve local work')
    expect(result.authenticated).toContain(layout === 'directory' ? 'node_modules' : 'node_modules/react-markdown')
    expect(result.authenticated).toContain(`${registration}/node_modules/react-markdown`)
    expect(new Set(result.authenticated).size).toBe(result.authenticated.length)
    expect(authenticateWarmNodeModulesLinks(selected, worktree)).toEqual(result.evidence)
  })

  it('leaves a foreign projected dependency directory untouched and refuses a replaced package link', () => {
    const { selected, projected } = fixture()
    install(selected)
    const foreign = path.join(baseRepo, 'foreign-install')
    install(foreign, 'foreign-package')
    const destination = path.join(projected, 'node_modules')
    link(path.join(foreign, 'node_modules'), destination)
    const before = snapshot(foreign)
    expect(linkNodeModulesIntoWorktree(selected, worktree)).toMatchObject({ linked: [], authenticated: [] })
    expect(fs.realpathSync(destination)).toBe(fs.realpathSync(path.join(foreign, 'node_modules')))
    expect(snapshot(foreign)).toBe(before)
    fs.unlinkSync(destination)
    linkNodeModulesIntoWorktree(selected, worktree)
    fs.unlinkSync(path.join(destination, 'react-markdown'))
    link(path.join(foreign, 'node_modules/foreign-package'), path.join(destination, 'react-markdown'))
    expect(authenticateWarmNodeModulesLinks(selected, worktree).map(entry => entry.path)).not.toContain(`${registration}/node_modules/react-markdown`)
  })

  it.each(['apps', registration, `${registration}/packages`])('refuses preparation and cleanup through the symlinked ancestor %s', ancestor => {
    const { selected } = fixture()
    const childRegistration = ancestor.endsWith('/packages')
    const packageSource = childRegistration ? path.join(selected, 'packages/tool') : selected
    install(packageSource)
    const packageRelative = childRegistration ? `${registration}/packages/tool` : registration
    const foreign = path.join(baseRepo, 'foreign-tree')
    const foreignPackage = path.join(foreign, path.relative(ancestor, packageRelative))
    // Even an exact source link cannot grant cleanup authority through an
    // unowned directory symlink, nor permit preparation to write there.
    link(path.join(packageSource, 'node_modules/react-markdown'), path.join(foreignPackage, 'node_modules/react-markdown'))
    const before = snapshot(foreign)
    fs.rmSync(path.join(worktree, ancestor), { recursive: true })
    link(foreign, path.join(worktree, ancestor))
    const result = linkNodeModulesIntoWorktree(selected, worktree)
    expect(result.linked).toEqual([])
    expect(result.authenticated).toEqual([])
    expect(authenticateWarmNodeModulesLinks(selected, worktree)).toEqual([])
    expect(snapshot(foreign)).toBe(before)
  })
})

describe('dependencyInputs', () => {
  function put(root: string, relative: string, content: string): void {
    const file = path.join(root, ...relative.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  it('finds the lockfile at the package directory before any parent lockfile', () => {
    put(baseRepo, 'package.json', '{}')
    put(baseRepo, 'yarn.lock', 'root')
    put(baseRepo, 'client/package.json', '{}')
    put(baseRepo, 'client/package-lock.json', 'client')
    expect(dependencyInputs(baseRepo, 'client').lockfile).toMatchObject({ name: 'package-lock.json', location: '' })
  })

  it('walks to a parent directory when the package directory has no lockfile', () => {
    put(baseRepo, 'yarn.lock', 'root')
    put(baseRepo, 'packages/tool/package.json', '{}')
    expect(dependencyInputs(baseRepo, 'packages/tool').lockfile).toMatchObject({ name: 'yarn.lock', location: '../..' })
  })

  it('prefers pnpm-lock.yaml over yarn.lock in the same directory', () => {
    put(baseRepo, 'package.json', '{}')
    put(baseRepo, 'yarn.lock', 'y')
    put(baseRepo, 'pnpm-lock.yaml', 'p')
    expect(dependencyInputs(baseRepo, '').lockfile?.name).toBe('pnpm-lock.yaml')
  })

  it('reaches the git top level for a subdirectory project, and no further', () => {
    put(baseRepo, 'outside/yarn.lock', 'not part of this repository')
    const top = path.join(baseRepo, 'outside', 'repo')
    fs.mkdirSync(path.join(top, '.git'), { recursive: true })
    put(top, 'yarn.lock', 'monorepo')
    put(top, 'apps/courses/package.json', '{}')
    const inputs = dependencyInputs(path.join(top, 'apps/courses'), '')
    expect(inputs.lockfile).toMatchObject({ name: 'yarn.lock', location: '../..' })
    fs.rmSync(path.join(top, 'yarn.lock'))
    expect(dependencyInputs(path.join(top, 'apps/courses'), '').lockfile).toBeNull()
  })

  it('treats a lockfile present on only one side as different', () => {
    put(baseRepo, 'package.json', '{}')
    put(worktree, 'package.json', '{}')
    put(baseRepo, 'yarn.lock', 'x')
    expect(differingDependencyInput(dependencyInputs(baseRepo, ''), dependencyInputs(worktree, ''))).toBe('yarn.lock')
    expect(differingDependencyInput(dependencyInputs(worktree, ''), dependencyInputs(baseRepo, ''))).toBe('yarn.lock')
  })

  it('treats no lockfile on either side with equal manifests as equal', () => {
    put(baseRepo, 'package.json', '{"dependencies":{"a":"1"}}')
    put(worktree, 'package.json', '{"dependencies":{"a":"1"}}')
    expect(differingDependencyInput(dependencyInputs(baseRepo, ''), dependencyInputs(worktree, ''))).toBeNull()
  })

  it('compares dependency fields canonically: reordering is equal, a changed range differs', () => {
    put(baseRepo, 'package.json', JSON.stringify({ devDependencies: { z: '1', a: '2' }, dependencies: { x: '^5.23.0', b: '1' } }))
    put(worktree, 'package.json', JSON.stringify({ dependencies: { b: '1', x: '^5.23.0' }, devDependencies: { a: '2', z: '1' } }, null, 2))
    expect(dependencyInputs(baseRepo, '').manifestDigest).toBe(dependencyInputs(worktree, '').manifestDigest)
    put(worktree, 'package.json', JSON.stringify({ dependencies: { b: '1', x: '^5.24.0' }, devDependencies: { a: '2', z: '1' } }))
    expect(differingDependencyInput(dependencyInputs(baseRepo, ''), dependencyInputs(worktree, ''))).toBe('package.json')
  })

  it('ignores scripts, version and other metadata', () => {
    put(baseRepo, 'package.json', JSON.stringify({ version: '1.0.0', scripts: { test: 'vitest' }, peerDependencies: { react: '*' } }))
    put(worktree, 'package.json', JSON.stringify({ version: '2.0.0', scripts: { test: 'jest' }, peerDependencies: { react: '*' } }))
    expect(differingDependencyInput(dependencyInputs(baseRepo, ''), dependencyInputs(worktree, ''))).toBeNull()
  })

  it('never throws: missing or unparsable manifests compare as different', () => {
    put(baseRepo, 'package.json', '{ not json')
    put(worktree, 'package.json', '{ not json')
    const broken = dependencyInputs(baseRepo, '')
    expect(broken.manifestDigest).toBeNull()
    expect(differingDependencyInput(broken, dependencyInputs(worktree, ''))).toBe('package.json')
    expect(() => dependencyInputs(path.join(baseRepo, 'missing'), 'nope')).not.toThrow()
  })
})

describe('linkNodeModulesIntoWorktree freshness guard', () => {
  function put(root: string, relative: string, content: string): void {
    const file = path.join(root, ...relative.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  function tree(root: string): string {
    return JSON.stringify(fs.readdirSync(root, { recursive: true }).map(String).sort().map(entry => {
      const file = path.join(root, entry)
      const stat = fs.lstatSync(file)
      return [entry, stat.isFile() ? fs.readFileSync(file, 'utf8') : stat.isSymbolicLink() ? fs.readlinkSync(file) : 'dir']
    }))
  }

  it('skips a stale base lockfile with an exact warning and leaves the base checkout untouched', () => {
    mkRepo(['package.json', 'node_modules/a.js'])
    put(baseRepo, 'yarn.lock', '@busuu/experiments@5.23.0')
    put(worktree, 'yarn.lock', '@busuu/experiments@5.24.0')
    const before = tree(baseRepo)
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res).toEqual({
      linked: [], authenticated: [], evidence: [],
      warnings: ['.: yarn.lock differs from the base checkout; dependencies will be installed in the worktree'],
    })
    expect(fs.existsSync(path.join(worktree, 'node_modules'))).toBe(false)
    expect(tree(baseRepo)).toBe(before)
  })

  it('skips only the package directory whose manifest differs', () => {
    mkRepo(['package.json', 'node_modules/a.js', 'client/package.json', 'client/node_modules/b.js'])
    put(worktree, 'client/package.json', '{"dependencies":{"x":"^2.0.0"}}')
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res.linked).toEqual(['node_modules'])
    expect(res.authenticated).toEqual(['node_modules/a.js'])
    expect(res.warnings).toEqual(['client: package.json differs from the base checkout; dependencies will be installed in the worktree'])
    expect(fs.existsSync(path.join(worktree, 'client', 'node_modules'))).toBe(false)
  })

  it('links as before when lockfile and dependency fields match', () => {
    mkRepo(['package.json', 'node_modules/a.js'])
    put(baseRepo, 'package-lock.json', 'same')
    put(worktree, 'package-lock.json', 'same')
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res.linked).toEqual(['node_modules'])
    expect(res.warnings).toEqual([])
  })

  it('keeps an existing authenticated link on resume after the base lockfile changes', () => {
    mkRepo(['package.json', 'node_modules/a.js'])
    put(baseRepo, 'yarn.lock', 'v1')
    put(worktree, 'yarn.lock', 'v1')
    const first = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(first.authenticated).toEqual(['node_modules/a.js'])
    put(baseRepo, 'yarn.lock', 'v2')
    const resumed = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(resumed).toMatchObject({ linked: [], authenticated: ['node_modules/a.js'], warnings: [] })
    expect(resumed.evidence).toEqual(first.evidence)
  })

  it('skips a monorepo subdirectory project whose root yarn.lock differs', () => {
    const registration = 'apps/busuu-courses'
    fs.mkdirSync(path.join(baseRepo, '.git'))
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: elsewhere\n')
    for (const root of [baseRepo, worktree]) put(root, `${registration}/package.json`, '{"dependencies":{"@busuu/experiments":"^5.24.0"}}')
    put(baseRepo, 'yarn.lock', 'experiments 5.23.0')
    put(worktree, 'yarn.lock', 'experiments 5.24.0')
    put(baseRepo, `${registration}/node_modules/@busuu/experiments/index.js`, 'old')
    const selected = path.join(baseRepo, registration)
    const before = tree(selected)
    const res = linkNodeModulesIntoWorktree(selected, worktree)
    expect(res).toEqual({
      linked: [], authenticated: [], evidence: [],
      warnings: [`${registration}: yarn.lock differs from the base checkout; dependencies will be installed in the worktree`],
    })
    expect(fs.existsSync(path.join(worktree, registration, 'node_modules'))).toBe(false)
    expect(tree(selected)).toBe(before)
    // Same root lockfile: the warm link is prepared at the projected position.
    put(worktree, 'yarn.lock', 'experiments 5.23.0')
    expect(linkNodeModulesIntoWorktree(selected, worktree).linked).toEqual([`${registration}/node_modules`])
  })
})
