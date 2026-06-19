import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import { getBundledOpenspecCli, hasBundledOpenspec } from './bundled-openspec'

/**
 * env/file gating for the bundled-openspec resolution chokepoint. EVERY path is
 * existence-gated: a missing env, a missing CLI on disk, or a stale env all
 * resolve to null (→ bundled-core init falls back to `npx @fission-ai/openspec`).
 */
describe('bundled-openspec resolution', () => {
  let tmp: string
  let prevEnv: string | undefined

  const CLI_REL = path.join('node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js')

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'bundled-openspec-test-'))
    prevEnv = process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH
    delete process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH
    else process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH = prevEnv
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Materialize a fake bundled-openspec tree at <dir> with the CLI node entry. */
  function makeFakeOpenspec(dir: string): string {
    const cli = path.join(dir, CLI_REL)
    mkdirSync(path.dirname(cli), { recursive: true })
    writeFileSync(cli, '#!/usr/bin/env node\nrunCli()')
    return cli
  }

  it('returns null when the env is unset', () => {
    expect(getBundledOpenspecCli()).toBeNull()
    expect(hasBundledOpenspec()).toBe(false)
  })

  it('returns null when the env points at a non-existent dir (stale env)', () => {
    process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH = path.join(tmp, 'does-not-exist')
    expect(getBundledOpenspecCli()).toBeNull()
    expect(hasBundledOpenspec()).toBe(false)
  })

  it('returns null when the env is the empty string', () => {
    process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH = ''
    expect(getBundledOpenspecCli()).toBeNull()
    expect(hasBundledOpenspec()).toBe(false)
  })

  it('resolves the CLI when a valid bundled openspec tree exists', () => {
    const root = path.join(tmp, 'openspec')
    const cli = makeFakeOpenspec(root)
    process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH = root

    expect(getBundledOpenspecCli()).toBe(cli)
    expect(hasBundledOpenspec()).toBe(true)
  })

  it('returns null when the dir exists but the openspec CLI entry is missing', () => {
    const root = path.join(tmp, 'openspec-no-cli')
    mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH = root

    expect(getBundledOpenspecCli()).toBeNull()
    expect(hasBundledOpenspec()).toBe(false)
  })
})
