import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  linkNodeModulesIntoWorktree,
  isWorktreeNodeModulesEnabled,
  authenticateWarmNodeModulesLinks,
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
  it('links the root node_modules as a symlink into the worktree', () => {
    mkRepo(['package.json', 'node_modules/left-pad/index.js'])
    const res = linkNodeModulesIntoWorktree(baseRepo, worktree)
    expect(res.linked).toEqual(['node_modules'])
    expect(res.warnings).toEqual([])
    const dest = path.join(worktree, 'node_modules')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
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
    expect(fs.lstatSync(path.join(worktree, 'client', 'node_modules')).isSymbolicLink()).toBe(true)
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
    expect(res.authenticated.sort()).toEqual(['client/node_modules', 'node_modules'])
    expect(res.evidence.map((e) => e.path).sort()).toEqual(['client/node_modules', 'node_modules'])
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
    expect(second.authenticated).toEqual(['node_modules'])
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
    expect(evidence.map((e) => e.path).sort()).toEqual(['client/node_modules', 'node_modules'])
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
