import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'node:child_process'
import {
  linkNodeModulesIntoWorktree,
  isWorktreeNodeModulesEnabled,
  authenticateWarmNodeModulesLinks,
  WORKTREE_DEPENDENCY_CACHES,
} from './worktree-node-modules'

let baseRepo: string
let worktree: string

function mkRepo(structure: string[]): void {
  for (const rel of structure) {
    const abs = path.join(baseRepo, ...rel.split('/'))
    if (rel.endsWith('/')) fs.mkdirSync(abs, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, '{}')
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
