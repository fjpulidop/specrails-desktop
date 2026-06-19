import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

// Neutralize the host-dependent prerequisite gate. `startInstall` calls
// `formatMissingSetupPrerequisites()` BEFORE the bundled path, and that gate
// requires at least one provider CLI (claude/codex/gemini) on PATH. CI runners
// (ubuntu) ship none, so the unmocked gate emits a `setup_error` and returns
// early — the bundled offline path under test never runs, and every
// `getByType('setup_error')` assertion fails. This suite exercises the BUNDLED
// OFFLINE INSTALL path; the prerequisite gate has its own coverage in
// setup-prerequisites.test.ts (and the gate wiring in setup-manager.test.ts), so
// forcing it to pass here keeps the install assertions meaningful while making
// the suite deterministic on any host. Mirrors setup-manager.test.ts's mock.
vi.mock('./setup-prerequisites', () => ({
  formatMissingSetupPrerequisites: vi.fn().mockReturnValue(null),
  getSetupPrerequisitesStatus: vi.fn().mockReturnValue({
    ok: true,
    platform: 'linux',
    prerequisites: [],
    missingRequired: [],
  }),
}))

import { SetupManager } from './setup-manager'

/**
 * Integration tests for the bundled-core install path in setup-manager.
 * Unlike setup-manager.test.ts (which mocks fs + child_process), this suite uses
 * a REAL tmpdir + a REAL fake bundled-core CLI subprocess so the existence-gating
 * + offline branch are exercised end-to-end:
 *   - bundled core present  → spawns `node <fake-cli> init` (NO npx), framework
 *     materialized, setup_install_done emitted.
 *   - bundled core absent    → falls back to the legacy npx probe + spawn.
 */

// A fake bundled-core CLI that handles install-framework + init, writing just
// enough to satisfy validateInstalledCore and exiting 0.
const FAKE_CLI = `
const fs = require('fs')
const path = require('path')
function arg(name) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i+1] : undefined }
const sub = process.argv[2]
if (sub === 'install-framework') {
  const fw = arg('framework-dir'); const version = arg('version')
  fs.mkdirSync(path.join(fw, version, '.claude', 'agents'), { recursive: true })
  const cur = path.join(fw, 'current'); try { fs.unlinkSync(cur) } catch {}
  fs.symlinkSync(version, cur)
  process.exit(0)
}
if (sub === 'init') {
  // The real init assembles + runs openspec; the fake just signals success.
  // Record the openspec env the desktop set so the test can assert the bundled
  // (offline) vs npx-fallback wiring without spawning real openspec.
  const repo = arg('root-dir') || process.cwd()
  try {
    fs.writeFileSync(
      path.join(repo, 'openspec-env.json'),
      JSON.stringify({
        bin: process.env.SPECRAILS_OPENSPEC_BIN || null,
        node: process.env.SPECRAILS_OPENSPEC_NODE || null,
        relocate: process.env.SPECRAILS_RELOCATE || null,
      }),
    )
  } catch {}
  process.stdout.write('Phase 2 & 3: Installing specrails artifacts\\n')
  process.stdout.write('init complete\\n')
  process.exit(0)
}
process.exit(9)
`

describe('SetupManager — bundled-core install path', () => {
  let home: string
  let coreDir: string
  let project: string
  let broadcast: ReturnType<typeof vi.fn>
  let sm: SetupManager
  let prevCore: string | undefined
  let prevHome: string | undefined
  let prevOpenspec: string | undefined
  let prevRuntimes: string | undefined
  let openspecDir: string

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'sm-bc-home-'))
    coreDir = mkdtempSync(path.join(os.tmpdir(), 'sm-bc-core-'))
    project = mkdtempSync(path.join(os.tmpdir(), 'sm-bc-proj-'))
    openspecDir = mkdtempSync(path.join(os.tmpdir(), 'sm-bc-openspec-'))
    broadcast = vi.fn()
    sm = new SetupManager(broadcast)
    prevCore = process.env.SPECRAILS_BUNDLED_CORE_PATH
    prevHome = process.env.SPECRAILS_REGISTRY_HOME
    prevOpenspec = process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH
    prevRuntimes = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    delete process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH
    // Default: no bundled runtimes → SPECRAILS_OPENSPEC_NODE falls back to PATH `node`.
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    process.env.SPECRAILS_REGISTRY_HOME = home
  })

  afterEach(() => {
    if (prevCore === undefined) delete process.env.SPECRAILS_BUNDLED_CORE_PATH
    else process.env.SPECRAILS_BUNDLED_CORE_PATH = prevCore
    if (prevHome === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
    else process.env.SPECRAILS_REGISTRY_HOME = prevHome
    if (prevOpenspec === undefined) delete process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH
    else process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH = prevOpenspec
    if (prevRuntimes === undefined) delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    else process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = prevRuntimes
    rmSync(home, { recursive: true, force: true })
    rmSync(coreDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
    rmSync(openspecDir, { recursive: true, force: true })
  })

  /** Materialize a fake bundled openspec CLI node entry + arm the env. */
  function installFakeOpenspec(): string {
    const cli = path.join(openspecDir, 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js')
    mkdirSync(path.dirname(cli), { recursive: true })
    writeFileSync(cli, '#!/usr/bin/env node\n')
    process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH = openspecDir
    return cli
  }

  function installFakeCore(version = '5.0.0'): void {
    mkdirSync(path.join(coreDir, 'dist', 'installer'), { recursive: true })
    writeFileSync(path.join(coreDir, 'dist', 'installer', 'cli.js'), FAKE_CLI)
    writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({ version }))
    // templates/commands so SPECRAILS_CORE_SCRIPT_DIR resolution has a real root.
    mkdirSync(path.join(coreDir, 'templates'), { recursive: true })
    mkdirSync(path.join(coreDir, 'commands'), { recursive: true })
    process.env.SPECRAILS_BUNDLED_CORE_PATH = coreDir
  }

  function getByType(type: string) {
    return broadcast.mock.calls.map((a) => a[0] as Record<string, unknown>).filter((m) => m.type === type)
  }

  function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const tick = () => {
        if (pred()) return resolve()
        if (Date.now() - started > timeoutMs) return reject(new Error('timeout'))
        setTimeout(tick, 25)
      }
      tick()
    })
  }

  it('uses the bundled core (no npx) and materializes the framework + emits setup_install_done', async () => {
    installFakeCore('5.0.0')

    sm.startInstall('proj-bc', project, 'proj-bc')

    await waitFor(() => getByType('setup_install_done').length > 0 || getByType('setup_error').length > 0)

    const errors = getByType('setup_error')
    expect(errors).toEqual([])
    const done = getByType('setup_install_done')
    expect(done).toHaveLength(1)

    // The framework was materialized to ~/.specrails/framework/5.0.0/.claude.
    const { existsSync } = await import('fs')
    expect(existsSync(path.join(home, '.specrails', 'framework', '5.0.0', '.claude', 'agents'))).toBe(true)
    // current → 5.0.0
    expect(existsSync(path.join(home, '.specrails', 'framework', 'current', '.claude', 'agents'))).toBe(true)
  })

  it('skips the npx network probe in bundled mode (proven by an offline install that materializes the framework)', async () => {
    // The npx version probe is a NETWORK call; with no network mocked here, an
    // install that completes with setup_install_done (and a materialized
    // framework) proves the bundled branch ran the offline path WITHOUT the npx
    // probe — the legacy branch would have done a real npx round-trip.
    installFakeCore('5.0.0')

    sm.startInstall('proj-noprobe', project, 'proj-noprobe')
    await waitFor(() => getByType('setup_install_done').length > 0 || getByType('setup_error').length > 0)

    expect(getByType('setup_error')).toEqual([])
    expect(getByType('setup_install_done')).toHaveLength(1)
    const { existsSync } = await import('fs')
    expect(existsSync(path.join(home, '.specrails', 'framework', '5.0.0', '.claude'))).toBe(true)
  })

  it('sets SPECRAILS_OPENSPEC_BIN + SPECRAILS_OPENSPEC_NODE in the bundled init spawn when bundled openspec is present (fully offline)', async () => {
    installFakeCore('5.0.0')
    const openspecCli = installFakeOpenspec()

    sm.startInstall('proj-os-on', project, 'proj-os-on')
    await waitFor(() => getByType('setup_install_done').length > 0 || getByType('setup_error').length > 0)

    expect(getByType('setup_error')).toEqual([])
    expect(getByType('setup_install_done')).toHaveLength(1)

    // The fake core's `init` recorded the openspec env it inherited from the spawn.
    const { readFileSync, existsSync } = await import('fs')
    const envFile = path.join(project, 'openspec-env.json')
    expect(existsSync(envFile)).toBe(true)
    const env = JSON.parse(readFileSync(envFile, 'utf8'))
    expect(env.bin).toBe(openspecCli)
    // NODE must be a REAL node executable, NOT process.execPath (the packaged
    // pkg binary, which cannot run openspec's ESM CLI → exit -1). With no bundled
    // runtimes set, it falls back to `node` on PATH.
    expect(env.node).toBe('node')
    expect(env.node).not.toBe(process.execPath)
    // The desktop forces relocation: core installs in-repo by default, but the
    // desktop must keep the user's repo pristine + manages the spawn cwd.
    expect(env.relocate).toBe('1')
  })

  it('uses the bundled Node binary as SPECRAILS_OPENSPEC_NODE when bundled runtimes are present', async () => {
    installFakeCore('5.0.0')
    const openspecCli = installFakeOpenspec()

    // Arm a fake bundled runtimes tree with a real node binary at the POSIX path
    // (the test only runs assertions on POSIX layout; on win32 the candidate is
    // node/node.exe — guard accordingly).
    const runtimes = mkdtempSync(path.join(os.tmpdir(), 'sm-bc-rt-'))
    const nodeExe = process.platform === 'win32'
      ? path.join(runtimes, 'node', 'node.exe')
      : path.join(runtimes, 'node', 'bin', 'node')
    mkdirSync(path.dirname(nodeExe), { recursive: true })
    // The core CLI is now spawned WITH this bundled node, so it must be a REAL,
    // runnable node (else the fake init never executes). Symlink the test runner's
    // node; its path differs from process.execPath, so the env.node !==
    // process.execPath contract still holds while remaining executable.
    const { symlinkSync } = await import('fs')
    symlinkSync(process.execPath, nodeExe)
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = runtimes

    try {
      sm.startInstall('proj-os-rt', project, 'proj-os-rt')
      await waitFor(() => getByType('setup_install_done').length > 0 || getByType('setup_error').length > 0)

      expect(getByType('setup_error')).toEqual([])
      const { readFileSync, existsSync } = await import('fs')
      const envFile = path.join(project, 'openspec-env.json')
      expect(existsSync(envFile)).toBe(true)
      const env = JSON.parse(readFileSync(envFile, 'utf8'))
      expect(env.bin).toBe(openspecCli)
      expect(env.node).toBe(nodeExe)
    } finally {
      rmSync(runtimes, { recursive: true, force: true })
    }
  })

  it('omits the openspec env (npx fallback) when no bundled openspec is present', async () => {
    installFakeCore('5.0.0')
    // No installFakeOpenspec() → SPECRAILS_BUNDLED_OPENSPEC_PATH stays unset.

    sm.startInstall('proj-os-off', project, 'proj-os-off')
    await waitFor(() => getByType('setup_install_done').length > 0 || getByType('setup_error').length > 0)

    expect(getByType('setup_error')).toEqual([])
    expect(getByType('setup_install_done')).toHaveLength(1)

    const { readFileSync, existsSync } = await import('fs')
    const envFile = path.join(project, 'openspec-env.json')
    expect(existsSync(envFile)).toBe(true)
    const env = JSON.parse(readFileSync(envFile, 'utf8'))
    expect(env.bin).toBeNull()
    expect(env.node).toBeNull()
  })
})
