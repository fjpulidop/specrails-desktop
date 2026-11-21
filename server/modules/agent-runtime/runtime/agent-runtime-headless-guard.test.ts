import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ELECTRON_HEADLESS_GUARD_FILE, coreHeadlessGuard, headlessGuardLogLine, resolveRunHeadlessGuard, withElectronHeadlessGuard } from './agent-runtime-headless-guard'

let root: string
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'headless guard '))) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

/** A Core package layout: `dist/agent-runtime/cli.js`, optionally with the guard beside the pipeline module. */
function corePackage(name: string, guard?: string): string {
  const cli = path.join(root, name, 'dist', 'agent-runtime', 'cli.js')
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '')
  if (guard !== undefined) {
    fs.mkdirSync(path.join(root, name, 'dist', 'pipeline'), { recursive: true })
    fs.writeFileSync(path.join(root, name, 'dist', 'pipeline', ELECTRON_HEADLESS_GUARD_FILE), guard)
  }
  return cli
}
function runDirectory(): string { const directory = path.join(root, 'pipeline', 'run'); fs.mkdirSync(directory, { recursive: true }); return directory }
const headless = { PATH: '/bin', SPECRAILS_HEADLESS: '1' }

describe('withElectronHeadlessGuard', () => {
  it('adds --require <guard> and keeps the existing NODE_OPTIONS, without mutating env', () => {
    const env = { ...headless, NODE_OPTIONS: '--max-old-space-size=4096' }
    expect(withElectronHeadlessGuard(env, '/runs/a b/guard.cjs')).toEqual({ ...env, NODE_OPTIONS: '--max-old-space-size=4096 --require "/runs/a b/guard.cjs"' })
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096')
    expect(withElectronHeadlessGuard(headless, '/g.cjs').NODE_OPTIONS).toBe('--require "/g.cjs"')
  })
  it('is idempotent: the same guard is never required twice', () => {
    const once = withElectronHeadlessGuard(headless, '/g.cjs')
    expect(withElectronHeadlessGuard(once, '/g.cjs')).toBe(once)
    // The quoted option doubles Windows backslashes; the guard is still recognised.
    const windows = 'C:\\Users\\me\\runs\\a b\\electron-headless-guard.cjs'
    const quoted = withElectronHeadlessGuard(headless, windows)
    expect(quoted.NODE_OPTIONS).toBe(`--require ${JSON.stringify(windows)}`)
    expect(withElectronHeadlessGuard(quoted, windows)).toBe(quoted)
  })
  it('respects the SPECRAILS_HEADLESS=0 opt-out and an unmarked environment', () => {
    const optOut = { PATH: '/bin', SPECRAILS_HEADLESS: '0', NODE_OPTIONS: '--no-warnings' }
    expect(withElectronHeadlessGuard(optOut, '/g.cjs')).toBe(optOut)
    const unmarked = { PATH: '/bin' }
    expect(withElectronHeadlessGuard(unmarked, '/g.cjs')).toBe(unmarked)
  })
})

describe('resolveRunHeadlessGuard', () => {
  it('leaves a retained Core that ships the guard to apply it itself', () => {
    const current = corePackage('current', 'current guard')
    const directory = runDirectory()
    expect(resolveRunHeadlessGuard({ env: headless, runCli: corePackage('retained', 'own guard'), runtimeDirectory: directory, currentCli: () => current })).toEqual({ source: 'core' })
    expect(fs.existsSync(path.join(directory, ELECTRON_HEADLESS_GUARD_FILE))).toBe(false)
  })
  it('copies the installed Core guard into the run once and keeps that copy across Core updates', () => {
    const retained = corePackage('retained')
    const directory = runDirectory(), copy = path.join(directory, ELECTRON_HEADLESS_GUARD_FILE)
    let current: string | null = corePackage('current', 'guard v1')
    expect(resolveRunHeadlessGuard({ env: headless, runCli: retained, runtimeDirectory: directory, currentCli: () => current })).toEqual({ source: 'desktop', path: copy })
    expect(fs.readFileSync(copy, 'utf8')).toBe('guard v1')
    // A later Core (or none at all) never moves the file a running process requires.
    current = corePackage('updated', 'guard v2')
    expect(resolveRunHeadlessGuard({ env: headless, runCli: retained, runtimeDirectory: directory, currentCli: () => current })).toEqual({ source: 'desktop', path: copy })
    current = null
    expect(resolveRunHeadlessGuard({ env: headless, runCli: retained, runtimeDirectory: directory, currentCli: () => current })).toEqual({ source: 'desktop', path: copy })
    expect(fs.readFileSync(copy, 'utf8')).toBe('guard v1')
  })
  it('reports when neither Core ships a guard, and when the person opted out', () => {
    const retained = corePackage('retained'), directory = runDirectory()
    const unavailable = resolveRunHeadlessGuard({ env: headless, runCli: retained, runtimeDirectory: directory, currentCli: () => corePackage('current') })
    expect(unavailable).toMatchObject({ source: 'unavailable' })
    expect(headlessGuardLogLine(unavailable)).toContain('may be visible')
    expect(resolveRunHeadlessGuard({ env: headless, runCli: retained, runtimeDirectory: directory, currentCli: () => { throw new Error('no Core') } })).toMatchObject({ source: 'unavailable' })
    const current = corePackage('current2', 'guard')
    expect(resolveRunHeadlessGuard({ env: { SPECRAILS_HEADLESS: '0' }, runCli: retained, runtimeDirectory: directory, currentCli: () => current })).toEqual({ source: 'opted-out' })
    expect(fs.existsSync(path.join(directory, ELECTRON_HEADLESS_GUARD_FILE))).toBe(false)
    expect(headlessGuardLogLine({ source: 'core' })).toBeNull()
    expect(headlessGuardLogLine({ source: 'opted-out' })).toBeNull()
    expect(headlessGuardLogLine({ source: 'desktop', path: '/g' })).toContain('Desktop applies it')
  })
  it('finds the guard from a Core CLI path', () => {
    expect(coreHeadlessGuard(null)).toBeNull()
    expect(coreHeadlessGuard(corePackage('without'))).toBeNull()
    expect(coreHeadlessGuard(corePackage('with', ''))).toBe(path.join(root, 'with', 'dist', 'pipeline', ELECTRON_HEADLESS_GUARD_FILE))
  })
})

describe('NODE_OPTIONS parsing', () => {
  it('loads a guard whose path has spaces in a real Node child', () => {
    const guard = path.join(root, 'dir with spaces', ELECTRON_HEADLESS_GUARD_FILE)
    fs.mkdirSync(path.dirname(guard), { recursive: true })
    fs.writeFileSync(guard, 'globalThis.__guardLoads = (globalThis.__guardLoads || 0) + 1')
    const env = withElectronHeadlessGuard(withElectronHeadlessGuard({ ...process.env, ...headless, PATH: process.env.PATH }, guard), guard)
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(globalThis.__guardLoads))'], { env, encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('1')
  })
})
