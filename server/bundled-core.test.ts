import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import {
  getBundledCoreRoot,
  getBundledCoreCli,
  getBundledCoreVersion,
  hasBundledCore,
} from './bundled-core'

/**
 * env/file gating for the bundled-core resolution chokepoint. EVERY path is
 * existence-gated: a missing env, a missing CLI on disk, or a stale env all
 * resolve to null (→ caller falls back to legacy npx).
 */
describe('bundled-core resolution', () => {
  let tmp: string
  let prevEnv: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'bundled-core-test-'))
    prevEnv = process.env.SPECRAILS_BUNDLED_CORE_PATH
    delete process.env.SPECRAILS_BUNDLED_CORE_PATH
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SPECRAILS_BUNDLED_CORE_PATH
    else process.env.SPECRAILS_BUNDLED_CORE_PATH = prevEnv
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Materialize a fake bundled-core tree at <dir> with the CLI + package.json. */
  function makeFakeCore(dir: string, version = '5.1.0'): void {
    mkdirSync(path.join(dir, 'dist', 'installer'), { recursive: true })
    writeFileSync(path.join(dir, 'dist', 'installer', 'cli.js'), 'module.exports={}')
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'specrails-core', version }))
  }

  it('returns null for everything when the env is unset', () => {
    expect(getBundledCoreRoot()).toBeNull()
    expect(getBundledCoreCli()).toBeNull()
    expect(getBundledCoreVersion()).toBeNull()
    expect(hasBundledCore()).toBe(false)
  })

  it('returns null when the env points at a non-existent dir (stale env)', () => {
    process.env.SPECRAILS_BUNDLED_CORE_PATH = path.join(tmp, 'does-not-exist')
    expect(getBundledCoreRoot()).toBeNull()
    expect(getBundledCoreCli()).toBeNull()
    expect(hasBundledCore()).toBe(false)
  })

  it('resolves the root + CLI + version when a valid bundled core exists', () => {
    const coreDir = path.join(tmp, 'core')
    makeFakeCore(coreDir, '5.1.0')
    process.env.SPECRAILS_BUNDLED_CORE_PATH = coreDir

    expect(getBundledCoreRoot()).toBe(coreDir)
    expect(getBundledCoreCli()).toBe(path.join(coreDir, 'dist', 'installer', 'cli.js'))
    expect(getBundledCoreVersion()).toBe('5.1.0')
    expect(hasBundledCore()).toBe(true)
  })

  it('returns null CLI when the dir exists but dist/installer/cli.js is missing', () => {
    const coreDir = path.join(tmp, 'core-no-cli')
    mkdirSync(coreDir, { recursive: true })
    writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({ version: '5.1.0' }))
    process.env.SPECRAILS_BUNDLED_CORE_PATH = coreDir

    expect(getBundledCoreRoot()).toBe(coreDir)
    expect(getBundledCoreCli()).toBeNull()
    expect(hasBundledCore()).toBe(false)
  })

  it('returns null version when package.json is malformed', () => {
    const coreDir = path.join(tmp, 'core-bad-pkg')
    mkdirSync(path.join(coreDir, 'dist', 'installer'), { recursive: true })
    writeFileSync(path.join(coreDir, 'dist', 'installer', 'cli.js'), '')
    writeFileSync(path.join(coreDir, 'package.json'), '{ not json')
    process.env.SPECRAILS_BUNDLED_CORE_PATH = coreDir

    expect(getBundledCoreVersion()).toBeNull()
  })
})
