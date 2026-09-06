import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addProject, addProjectRepository, getDesktopDbPath, getProject, initDesktopDb, listProjects } from './desktop-db'
import type { DbInstance } from './db'
import { canonicalRepositoryPath, repositoryPathKey } from './project-repositories'
import { FrameworkManager, frameworkRoot, readCurrentFrameworkVersion } from './framework-manager'

// Real native filesystem + SQLite + Node child process. Windows uses directory
// junctions, so these regressions require neither symlink privileges nor Developer Mode.
let root: string
let home: string
let db: DbInstance | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-windows-fs-'))
  home = path.join(root, 'José User Home')
  fs.mkdirSync(home, { recursive: true })
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('SPECRAILS_BUNDLED_RUNTIMES_PATH', '')
})
afterEach(() => {
  db?.close()
  db = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Windows filesystem persistence and recovery (native platform)', () => {
  it('reopens the same project catalog and repository IDs under a spaced Unicode profile', () => {
    const primary = path.join(root, 'Café App')
    const secondary = path.join(root, 'Service API')
    for (const dir of [primary, secondary]) fs.mkdirSync(dir)
    const filename = getDesktopDbPath()
    expect(filename).toBe(path.join(home, '.specrails', 'desktop.sqlite'))
    db = initDesktopDb()
    const project = addProject(db, { id: 'project', slug: 'cafe', name: 'Café', path: primary, providers: ['codex'], repositories: [{ path: secondary }] })
    const ids = project.repositories!.map((repo) => repo.id)
    expect(project.db_path.startsWith(path.join(home, '.specrails'))).toBe(true)
    db.close()
    db = initDesktopDb()
    expect(listProjects(db)).toHaveLength(1)
    const restored = getProject(db, 'project')!
    expect(restored.repositories!.map((repo) => repo.id)).toEqual(ids)
    expect(restored.repositories!.map((repo) => repositoryPathKey(repo.path))).toEqual([repositoryPathKey(primary), repositoryPathKey(canonicalRepositoryPath(secondary))])
    expect(restored.repositories!.every((repo) => repo.available)).toBe(true)
  })

  it('rejects duplicate membership through a junction and resolves new children through the same root', () => {
    const primary = path.join(root, 'Café App')
    const alias = path.join(root, 'Alias Project')
    fs.mkdirSync(primary)
    fs.symlinkSync(primary, alias, process.platform === 'win32' ? 'junction' : 'dir')
    db = initDesktopDb()
    addProject(db, { id: 'project', slug: 'cafe', name: 'Café', path: primary })
    expect(() => addProjectRepository(db!, 'project', { path: alias })).toThrow('distinct, non-overlapping')
    expect(canonicalRepositoryPath(path.join(alias, 'new folder', 'new.ts'))).toBe(path.join(fs.realpathSync(primary), 'new folder', 'new.ts'))
    if (process.platform === 'win32') {
      expect(() => addProjectRepository(db!, 'project', { path: primary.toUpperCase() })).toThrow('distinct, non-overlapping')
    }
    expect(getProject(db, 'project')!.repositories).toHaveLength(1)
  })

  it.each(['junction', 'copy'] as const)('restores an active %s framework if Core removes current and then fails publication', (layout) => {
    const fw = frameworkRoot(home)
    const previous = path.join(fw, '5.0.0')
    const current = path.join(fw, 'current')
    fs.mkdirSync(previous, { recursive: true })
    fs.writeFileSync(path.join(previous, '.framework-stamp.json'), JSON.stringify({ version: '5.0.0' }))
    fs.writeFileSync(path.join(previous, 'instructions.md'), 'Previous working instructions')
    const nestedFile = path.join('Guía española', '契約.md')
    fs.mkdirSync(path.dirname(path.join(previous, nestedFile)), { recursive: true })
    fs.writeFileSync(path.join(previous, nestedFile), 'Preserved nested Unicode instructions')
    if (layout === 'junction') fs.symlinkSync(previous, current, process.platform === 'win32' ? 'junction' : 'dir')
    else {
      // Seed independently of cpSync: the operation under test must perform the
      // recursive recovery copy, including Unicode parent and child paths.
      fs.mkdirSync(path.dirname(path.join(current, nestedFile)), { recursive: true })
      for (const file of ['.framework-stamp.json', 'instructions.md', nestedFile]) {
        fs.writeFileSync(path.join(current, file), fs.readFileSync(path.join(previous, file)))
      }
    }
    const coreRoot = path.join(root, 'Core fixture')
    const cli = path.join(coreRoot, 'dist', 'installer', 'cli.js')
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.writeFileSync(path.join(coreRoot, 'package.json'), JSON.stringify({ name: 'specrails-core', version: '5.1.0' }))
    fs.writeFileSync(cli, `const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const framework = args[args.indexOf('--framework-dir') + 1];
if (args[0] !== 'swap-current') process.exit(7);
fs.rmSync(path.join(framework, 'current'), { recursive: true, force: true });
process.stderr.write('EPERM simulated publication failure'); process.exit(41);
`)
    const manager = new FrameworkManager({ home, coreRoot })
    const result = manager.swapCurrentDetailed('5.1.0')
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('previous framework 5.0.0 restored')
    expect(readCurrentFrameworkVersion(home)).toBe('5.0.0')
    expect(fs.readFileSync(path.join(current, 'instructions.md'), 'utf8')).toBe('Previous working instructions')
    expect(fs.readFileSync(path.join(previous, 'instructions.md'), 'utf8')).toBe('Previous working instructions')
    expect(fs.readFileSync(path.join(current, nestedFile), 'utf8')).toBe('Preserved nested Unicode instructions')
    expect(fs.readFileSync(path.join(previous, nestedFile), 'utf8')).toBe('Preserved nested Unicode instructions')
  })
})
