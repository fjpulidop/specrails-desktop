import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { discoverExternalCoreRuntimes, managedCoreRoot, readCoreRuntime, readCurrentFrameworkVersion, resolveCoreRuntime, readProjectCoreVersion } from './core-runtime'

let home: string
function runtime(version: string, source: 'managed' | 'bundled' | 'global' = 'bundled') {
  const root = path.join(home, source, version)
  fs.mkdirSync(path.join(root, 'dist', 'installer'), { recursive: true })
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'specrails-core', version }))
  fs.writeFileSync(path.join(root, 'dist', 'installer', 'cli.js'), 'process.exit(0)')
  fs.writeFileSync(path.join(root, 'bin', 'specrails-core.mjs'), '')
  return readCoreRuntime(root, source)!
}
function current(version: string) {
  const dir = path.join(home, '.specrails', 'framework')
  fs.mkdirSync(path.join(dir, version), { recursive: true })
  fs.symlinkSync(version, path.join(dir, 'current'))
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'core-runtime-'))
  vi.stubEnv('SPECRAILS_CORE_BIN', '')
  vi.stubEnv('SPECRAILS_BUNDLED_CORE_PATH', '')
  vi.stubEnv('PATH', '')
})
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }) })

describe('Core runtime selection', () => {
  it('chooses a newer external install without changing either install', () => {
    const bundled = runtime('4.12.0')
    vi.stubEnv('SPECRAILS_BUNDLED_CORE_PATH', bundled.root)
    const external = runtime('5.0.0', 'global')
    expect(resolveCoreRuntime(home, [external])).toEqual(external)
    expect(readCoreRuntime(bundled.root, 'bundled')).toEqual(bundled)
  })
  it('discovers npm symlinks through PATH without invoking the CLI', () => {
    const external = runtime('5.0.0', 'global')
    const bin = path.join(home, 'bin')
    fs.mkdirSync(bin)
    fs.symlinkSync(path.join(external.root, 'bin', 'specrails-core.mjs'), path.join(bin, 'specrails-core'))
    vi.stubEnv('PATH', bin)
    expect(discoverExternalCoreRuntimes()).toContainEqual(external)
  })
  it('honours an explicit override and rejects a missing one', () => {
    const explicit = runtime('4.12.0', 'global')
    vi.stubEnv('SPECRAILS_CORE_BIN', path.join(explicit.root, 'bin', 'specrails-core.mjs'))
    expect(resolveCoreRuntime(home, [runtime('5.0.0', 'global')])?.source).toBe('override')
    vi.stubEnv('SPECRAILS_CORE_BIN', '/missing/core')
    expect(() => resolveCoreRuntime(home)).toThrow(/SPECRAILS_CORE_BIN/)
  })
  it('retains the active managed runtime and ignores failed unactivated stages', () => {
    const managed = runtime('5.0.0', 'managed')
    const target = path.join(managedCoreRoot(home), '5.0.0', 'node_modules', 'specrails-core')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(managed.root, target, { recursive: true })
    current('5.0.0')
    runtime('5.1.0', 'managed')
    expect(resolveCoreRuntime(home)?.version).toBe('5.0.0')
    expect(resolveCoreRuntime(home)?.source).toBe('managed')
  })
  it('refuses to reassemble an updated framework with an older bundle', () => {
    vi.stubEnv('SPECRAILS_BUNDLED_CORE_PATH', runtime('4.12.0').root)
    current('5.0.0')
    expect(() => resolveCoreRuntime(home)).toThrow(/will not downgrade/)
  })
  it('ignores incompatible future majors and dangling current pointers', () => {
    const dir = path.join(home, '.specrails', 'framework')
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync('9.0.0', path.join(dir, 'current'))
    expect(readCurrentFrameworkVersion(home)).toBeNull()
    expect(resolveCoreRuntime(home, [runtime('6.0.0', 'global')])).toBeNull()
  })
  it('reports linked, pinned and copied project versions independently', () => {
    current('5.0.0')
    const workspace = path.join(home, 'workspace')
    const framework = path.join(home, '.specrails', 'framework')
    for (const version of ['4.12.0', '5.0.0']) fs.mkdirSync(path.join(framework, version, '.claude', 'commands'), { recursive: true })
    fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(workspace, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(workspace, '.specrails', 'specrails-version'), '4.12.0')
    const link = path.join(workspace, '.claude', 'commands')
    fs.symlinkSync(path.join(framework, 'current', '.claude', 'commands'), link)
    expect(readProjectCoreVersion(workspace, workspace, home)).toMatchObject({ version: null, recordedVersion: '4.12.0', mixed: true, providerVersions: { claude: '5.0.0' } })
    fs.writeFileSync(path.join(workspace, '.specrails', 'specrails-version'), '5.0.0')
    expect(readProjectCoreVersion(workspace, workspace, home).version).toBe('5.0.0')
    fs.writeFileSync(path.join(workspace, '.specrails', 'specrails-version'), '4.12.0')
    fs.unlinkSync(link)
    fs.symlinkSync(path.join(framework, '4.12.0', '.claude', 'commands'), link)
    expect(readProjectCoreVersion(workspace, workspace, home).version).toBe('4.12.0')
    fs.unlinkSync(link)
    fs.mkdirSync(link)
    expect(readProjectCoreVersion(workspace, workspace, home).version).toBe('4.12.0')
  })
})
