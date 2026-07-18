import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from 'fs'
import os from 'os'
import path from 'path'

import {
  FrameworkManager,
  frameworkRoot,
  readCurrentFrameworkVersion,
} from './framework-manager'
import { withFileLock } from './artifact-registry'

/**
 * FrameworkManager tests. A FAKE bundled-core CLI (a tiny node script) stands in
 * for specrails-core's compiled `dist/installer/cli.js`. It implements just
 * enough of `install-framework` (create <fw>/<version>/<providerDir>/agents +
 * point current → version) and `assemble` (symlink + write the version marker) to
 * exercise materialize / swap / versionCheck / assemble + the graceful no-op when
 * the env is absent.
 */

const FAKE_CLI = `
const fs = require('fs')
const path = require('path')
function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const sub = process.argv[2]
const providerDirFor = (p) => p === 'codex' ? '.codex' : p === 'gemini' ? '.gemini' : '.claude'
function swap(fw, version) {
  const cur = path.join(fw, 'current')
  try { fs.unlinkSync(cur) } catch {}
  fs.symlinkSync(version, cur)
}
if (sub === 'install-framework') {
  const fw = arg('framework-dir'); const provider = arg('provider'); const version = arg('version')
  const pd = providerDirFor(provider)
  const dir = path.join(fw, version, pd, 'agents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'sr-architect.md'), '# arch')
  // current → version (relative symlink swap, atomic-ish) UNLESS --no-swap.
  if (!process.argv.includes('--no-swap')) swap(fw, version)
  process.exit(0)
} else if (sub === 'swap-current') {
  const fw = arg('framework-dir'); const version = arg('version')
  // Defence: only swap to a materialized version (mirrors core's guard).
  if (!fs.existsSync(path.join(fw, version))) process.exit(41)
  swap(fw, version)
  process.exit(0)
} else if (sub === 'assemble') {
  const ws = arg('workspace'); const provider = arg('provider')
  const pd = providerDirFor(provider)
  fs.mkdirSync(path.join(ws, pd, 'agents'), { recursive: true })
  // symlink agents/sr-architect.md into the workspace (simulates the linked tree)
  const fw = arg('framework-dir'); const version = arg('version')
  const target = path.join(fw, 'current', pd, 'agents', 'sr-architect.md')
  try { fs.symlinkSync(target, path.join(ws, pd, 'agents', 'sr-architect.md')) } catch {}
  // REAL writable agent-memory dir (never linked)
  fs.mkdirSync(path.join(ws, pd, 'agent-memory', 'sr-architect'), { recursive: true })
  // The version marker the gate checks for (real file)
  fs.mkdirSync(path.join(ws, '.specrails'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.specrails', 'specrails-version'), version + '\\n')
  process.exit(0)
}
process.exit(7)
`

describe('FrameworkManager', () => {
  let home: string
  let coreDir: string
  let prevCoreEnv: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'fm-home-'))
    coreDir = mkdtempSync(path.join(os.tmpdir(), 'fm-core-'))
    prevCoreEnv = process.env.SPECRAILS_BUNDLED_CORE_PATH
  })

  afterEach(() => {
    if (prevCoreEnv === undefined) delete process.env.SPECRAILS_BUNDLED_CORE_PATH
    else process.env.SPECRAILS_BUNDLED_CORE_PATH = prevCoreEnv
    rmSync(home, { recursive: true, force: true })
    rmSync(coreDir, { recursive: true, force: true })
  })

  /** Install the fake bundled core + point the env at it. */
  function installFakeCore(version = '5.0.0'): void {
    mkdirSync(path.join(coreDir, 'dist', 'installer'), { recursive: true })
    writeFileSync(path.join(coreDir, 'dist', 'installer', 'cli.js'), FAKE_CLI)
    writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({ version }))
    process.env.SPECRAILS_BUNDLED_CORE_PATH = coreDir
  }

  describe('graceful no-op when no bundled core', () => {
    it('isAvailable=false and every method no-ops', () => {
      delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      const fm = new FrameworkManager({ home })
      expect(fm.isAvailable()).toBe(false)
      expect(fm.bundledVersion()).toBeNull()
      expect(fm.materialize()).toEqual({ ran: false, version: null, providers: [], errors: [] })
      expect(fm.swapCurrent('5.0.0')).toBe(false)
      expect(fm.versionCheck()).toEqual({ swapped: false, version: null })
      expect(fm.assembleWorkspace({ workspace: path.join(home, 'ws'), provider: 'claude', codeRoot: home })).toEqual({ ran: false })
    })
  })

  describe('materialize', () => {
    it('materializes the framework WITHOUT swapping current (--no-swap)', () => {
      installFakeCore('5.0.0')
      const fm = new FrameworkManager({ home })
      const res = fm.materialize(undefined, ['claude'])
      expect(res.ran).toBe(true)
      expect(res.version).toBe('5.0.0')
      expect(res.providers).toEqual(['claude'])
      expect(res.errors).toEqual([])
      const fw = frameworkRoot(home)
      expect(existsSync(path.join(fw, '5.0.0', '.claude', 'agents', 'sr-architect.md'))).toBe(true)
      // materialize uses --no-swap: current is NOT moved by materialize alone.
      expect(readCurrentFrameworkVersion(home)).toBeNull()
    })

    it('materializes multiple providers', () => {
      installFakeCore('5.0.0')
      const fm = new FrameworkManager({ home })
      const res = fm.materialize('5.0.0', ['claude', 'gemini', 'claude'])
      expect(res.providers.sort()).toEqual(['claude', 'gemini'])
      const fw = frameworkRoot(home)
      expect(existsSync(path.join(fw, '5.0.0', '.claude', 'agents'))).toBe(true)
      expect(existsSync(path.join(fw, '5.0.0', '.gemini', 'agents'))).toBe(true)
    })

    it('records a per-provider error when the CLI exits non-zero', () => {
      installFakeCore('5.0.0')
      const fm = new FrameworkManager({ home })
      // An unknown provider makes the fake CLI still run (it defaults to .claude),
      // so instead force a failure by corrupting the CLI for one run.
      writeFileSync(path.join(coreDir, 'dist', 'installer', 'cli.js'), 'process.exit(3)')
      const res = fm.materialize('5.0.0', ['claude'])
      expect(res.ran).toBe(true)
      expect(res.providers).toEqual([])
      expect(res.errors).toHaveLength(1)
      expect(res.errors[0].provider).toBe('claude')
    })
  })

  describe('swapCurrent', () => {
    it('is a no-op when current already points at the version', () => {
      installFakeCore('5.0.0')
      const fm = new FrameworkManager({ home })
      fm.materialize('5.0.0', ['claude'])
      // materialize no longer swaps (--no-swap) — swap-current makes it visible.
      expect(fm.swapCurrent('5.0.0')).toBe(true)
      expect(readCurrentFrameworkVersion(home)).toBe('5.0.0')
      // Now swap to the same version — should short-circuit true without spawning.
      expect(fm.swapCurrent('5.0.0')).toBe(true)
    })

    it('re-points current to a different materialized version', () => {
      installFakeCore('5.0.0')
      const fm = new FrameworkManager({ home })
      fm.materialize('5.0.0', ['claude'])
      fm.swapCurrent('5.0.0')
      // Materialize a newer version, then swap.
      writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({ version: '5.1.0' }))
      fm.materialize('5.1.0', ['claude'])
      expect(fm.swapCurrent('5.1.0')).toBe(true)
      expect(readCurrentFrameworkVersion(home)).toBe('5.1.0')
    })
  })

  describe('versionCheck', () => {
    it('materializes + swaps + broadcasts when current differs from bundled', () => {
      installFakeCore('5.0.0')
      const broadcast = vi.fn()
      const fm = new FrameworkManager({ home, broadcast })
      const res = fm.versionCheck(['claude'])
      expect(res.swapped).toBe(true)
      expect(res.version).toBe('5.0.0')
      expect(readCurrentFrameworkVersion(home)).toBe('5.0.0')
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'framework.updated', version: '5.0.0' }),
      )
    })

    it('is a no-op when current already equals the bundled version', () => {
      installFakeCore('5.0.0')
      const broadcast = vi.fn()
      const fm = new FrameworkManager({ home, broadcast })
      fm.versionCheck(['claude']) // first run swaps
      broadcast.mockClear()
      const res = fm.versionCheck(['claude']) // second run no-ops
      expect(res.swapped).toBe(false)
      expect(res.version).toBe('5.0.0')
      expect(broadcast).not.toHaveBeenCalled()
    })

    it('no-ops gracefully when no bundled core', () => {
      delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      const fm = new FrameworkManager({ home })
      expect(fm.versionCheck()).toEqual({ swapped: false, version: null })
    })
  })

  describe('assembleWorkspace', () => {
    it('symlinks the framework into the workspace + writes the version marker', () => {
      installFakeCore('5.0.0')
      const fm = new FrameworkManager({ home })
      fm.materialize('5.0.0', ['claude'])

      const ws = path.join(home, '.specrails', 'projects', 'demo', 'workspace')
      mkdirSync(ws, { recursive: true })
      const codeRoot = path.join(home, 'repo')
      mkdirSync(codeRoot, { recursive: true })

      const res = fm.assembleWorkspace({ workspace: ws, provider: 'claude', version: '5.0.0', codeRoot })
      expect(res.ran).toBe(true)
      expect(res.error).toBeUndefined()
      // Linked agent file.
      const linked = path.join(ws, '.claude', 'agents', 'sr-architect.md')
      expect(lstatSync(linked).isSymbolicLink()).toBe(true)
      // Real agent-memory dir (never linked).
      const mem = path.join(ws, '.claude', 'agent-memory', 'sr-architect')
      expect(lstatSync(mem).isSymbolicLink()).toBe(false)
      // The gate marker.
      expect(existsSync(path.join(ws, '.specrails', 'specrails-version'))).toBe(true)
    })
  })

  describe('assembleWorkspace error path', () => {
    it('returns ran:true + error when the CLI exits non-zero', () => {
      installFakeCore('5.0.0')
      const fm = new FrameworkManager({ home })
      fm.materialize('5.0.0', ['claude'])
      // Break the CLI so assemble fails.
      writeFileSync(path.join(coreDir, 'dist', 'installer', 'cli.js'), 'process.exit(4)')
      const ws = path.join(home, 'ws-fail')
      mkdirSync(ws, { recursive: true })
      const res = fm.assembleWorkspace({ workspace: ws, provider: 'claude', version: '5.0.0', codeRoot: home })
      expect(res.ran).toBe(true)
      expect(res.error).toBeDefined()
    })
  })

  describe('swapCurrent failure', () => {
    it('returns false when the install-framework re-run fails', () => {
      installFakeCore('5.0.0')
      const fm = new FrameworkManager({ home })
      fm.materialize('5.0.0', ['claude'])
      // Break the CLI; swapping to a NEW version forces a re-run that fails.
      writeFileSync(path.join(coreDir, 'dist', 'installer', 'cli.js'), 'process.exit(5)')
      expect(fm.swapCurrent('9.9.9')).toBe(false)
    })

    it('swapCurrentDetailed carries WHY: subprocess stderr, exit code, or missing CLI', () => {
      installFakeCore('5.0.0')
      const fm = new FrameworkManager({ home })
      fm.materialize('5.0.0', ['claude'])
      // stderr wins when the subprocess emits one.
      writeFileSync(
        path.join(coreDir, 'dist', 'installer', 'cli.js'),
        `process.stderr.write('version dir 9.9.9 does not exist'); process.exit(41)`,
      )
      const failed = fm.swapCurrentDetailed('9.9.9')
      expect(failed.ok).toBe(false)
      expect(failed.detail).toContain('version dir 9.9.9 does not exist')
      // Silent failure falls back to the exit code.
      writeFileSync(path.join(coreDir, 'dist', 'installer', 'cli.js'), 'process.exit(5)')
      expect(fm.swapCurrentDetailed('9.9.9')).toEqual({ ok: false, detail: 'exit 5' })
      // No usable CLI at all.
      delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      const noCli = new FrameworkManager({ home })
      expect(noCli.swapCurrentDetailed('9.9.9').detail).toMatch(/no usable core CLI/)
    })
  })

  describe('versionCheck when materialize fails', () => {
    it('does not swap + emits framework.update_failed when a provider errors', () => {
      installFakeCore('5.0.0')
      // Break the CLI before any materialize so versionCheck's materialize errors.
      writeFileSync(path.join(coreDir, 'dist', 'installer', 'cli.js'), 'process.exit(6)')
      const broadcast = vi.fn()
      const fm = new FrameworkManager({ home, broadcast })
      const res = fm.versionCheck(['claude'])
      expect(res.swapped).toBe(false)
      // current stays unset — never flipped to a half-installed version.
      expect(readCurrentFrameworkVersion(home)).toBeNull()
      // The errors are surfaced (not discarded, not reported as success).
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'framework.update_failed', version: '5.0.0' }),
      )
      const call = broadcast.mock.calls.find((c) => c[0].type === 'framework.update_failed')
      expect(call?.[0].errors).toHaveLength(1)
      expect(call?.[0].errors[0].provider).toBe('claude')
      expect(broadcast).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'framework.updated' }),
      )
    })

    it('multi-provider: one provider error blocks the swap (all-or-nothing)', () => {
      installFakeCore('5.0.0')
      // CLI that succeeds for claude but fails for gemini.
      const SELECTIVE = `
const fs = require('fs'); const path = require('path')
function arg(n){const i=process.argv.indexOf('--'+n);return i>=0?process.argv[i+1]:undefined}
const sub = process.argv[2]
if (sub === 'install-framework') {
  const provider = arg('provider')
  if (provider === 'gemini') process.exit(2)
  const fw = arg('framework-dir'); const version = arg('version')
  fs.mkdirSync(path.join(fw, version, '.claude', 'agents'), { recursive: true })
  process.exit(0)
} else if (sub === 'swap-current') {
  const fw = arg('framework-dir'); const version = arg('version')
  const cur = path.join(fw, 'current'); try { fs.unlinkSync(cur) } catch {}
  fs.symlinkSync(version, cur); process.exit(0)
}
process.exit(7)
`
      writeFileSync(path.join(coreDir, 'dist', 'installer', 'cli.js'), SELECTIVE)
      const broadcast = vi.fn()
      const fm = new FrameworkManager({ home, broadcast })
      const res = fm.versionCheck(['claude', 'gemini'])
      expect(res.swapped).toBe(false)
      // claude materialized but the swap was withheld because gemini failed.
      expect(readCurrentFrameworkVersion(home)).toBeNull()
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'framework.update_failed', version: '5.0.0' }),
      )
    })
  })

  describe('readCurrentFrameworkVersion', () => {
    it('returns null when current is absent', () => {
      expect(readCurrentFrameworkVersion(home)).toBeNull()
    })

    it('reads the version from the stamp marker when current is a REAL dir (Windows copy fallback)', () => {
      // BUG-FW-02: on the Windows copy fallback `current` is a real directory
      // (a copy of `<version>/`), so its basename is `current` and the version is
      // ONLY recoverable from the documented `.framework-stamp<providerDir>.json`
      // marker core's install-framework writes inside the version dir.
      const fw = frameworkRoot(home)
      const current = path.join(fw, 'current')
      mkdirSync(path.join(current, '.claude', 'agents'), { recursive: true })
      writeFileSync(
        path.join(current, '.framework-stamp.claude.json'),
        JSON.stringify({ version: '5.3.0', provider: 'claude', at: new Date().toISOString() }),
      )
      // Pre-fix this returned null (basename('current') === 'current').
      expect(readCurrentFrameworkVersion(home)).toBe('5.3.0')
    })

    it('reads the version from the marker for a non-claude provider (gemini/codex stamp)', () => {
      const fw = frameworkRoot(home)
      const current = path.join(fw, 'current')
      mkdirSync(current, { recursive: true })
      writeFileSync(
        path.join(current, '.framework-stamp.gemini.json'),
        JSON.stringify({ version: '6.1.0', provider: 'gemini', at: 'now' }),
      )
      expect(readCurrentFrameworkVersion(home)).toBe('6.1.0')
    })

    it('returns null when current is a real dir with no readable stamp marker', () => {
      const fw = frameworkRoot(home)
      const current = path.join(fw, 'current')
      mkdirSync(path.join(current, '.claude'), { recursive: true })
      // No stamp marker, plus a malformed one to prove it is skipped, not thrown.
      writeFileSync(path.join(current, '.framework-stamp.claude.json'), 'not json{')
      expect(readCurrentFrameworkVersion(home)).toBeNull()
    })

    it.skipIf(process.platform === 'win32')(
      'still reads the version from a POSIX symlink target basename (legacy path unchanged)',
      () => {
        const fw = frameworkRoot(home)
        mkdirSync(path.join(fw, '7.0.0'), { recursive: true })
        symlinkSync('7.0.0', path.join(fw, 'current'))
        expect(readCurrentFrameworkVersion(home)).toBe('7.0.0')
      },
    )
  })

  describe('versionCheck under the registry file-lock (boot pattern)', () => {
    it('first-run materializes + swaps + broadcasts when wrapped in withFileLock', () => {
      // Mirrors the server/index.ts boot wiring: the swap runs under the SAME
      // registry lock that serialises artifact resolution, so a concurrently-
      // spawning rail never sees a half-swapped `current`.
      installFakeCore('5.0.0')
      const broadcast = vi.fn()
      const fm = new FrameworkManager({ home, broadcast })
      // SPECRAILS_REGISTRY_HOME drives withFileLock(undefined, ...) at the home.
      const prev = process.env.SPECRAILS_REGISTRY_HOME
      process.env.SPECRAILS_REGISTRY_HOME = home
      try {
        const res = withFileLock(undefined, () => fm.versionCheck(['claude']))
        expect(res.swapped).toBe(true)
        expect(res.version).toBe('5.0.0')
      } finally {
        if (prev === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
        else process.env.SPECRAILS_REGISTRY_HOME = prev
      }
      expect(readCurrentFrameworkVersion(home)).toBe('5.0.0')
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'framework.updated', version: '5.0.0' }),
      )
    })

    it('post-update swap is serialized: a second locked versionCheck after a core bump swaps current', () => {
      installFakeCore('5.0.0')
      const fm = new FrameworkManager({ home })
      withFileLock(home, () => fm.versionCheck(['claude']))
      expect(readCurrentFrameworkVersion(home)).toBe('5.0.0')
      // App update ships a newer bundled core.
      writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({ version: '5.1.0' }))
      const res = withFileLock(home, () => fm.versionCheck(['claude']))
      expect(res.swapped).toBe(true)
      expect(res.version).toBe('5.1.0')
      expect(readCurrentFrameworkVersion(home)).toBe('5.1.0')
    })

    it('post-update keeps the old version materialized side-by-side (non-destructive)', () => {
      installFakeCore('5.0.0')
      const fm = new FrameworkManager({ home })
      fm.versionCheck(['claude'])
      writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({ version: '5.1.0' }))
      fm.versionCheck(['claude'])
      const fw = frameworkRoot(home)
      // BOTH version dirs survive; only `current` moved.
      expect(existsSync(path.join(fw, '5.0.0', '.claude', 'agents'))).toBe(true)
      expect(existsSync(path.join(fw, '5.1.0', '.claude', 'agents'))).toBe(true)
      expect(readCurrentFrameworkVersion(home)).toBe('5.1.0')
    })

    it('anti-downgrade: never reverts current to an OLDER bundled core (manual update guard)', () => {
      // Simulate the core update channel having moved current AHEAD of bundled.
      installFakeCore('5.0.0')
      const fm = new FrameworkManager({ home })
      fm.versionCheck(['claude'])
      expect(readCurrentFrameworkVersion(home)).toBe('5.0.0')
      // A user voluntarily materialized 5.2.0 via the update channel.
      mkdirSync(path.join(frameworkRoot(home), '5.2.0', '.claude', 'agents'), { recursive: true })
      const cur = path.join(frameworkRoot(home), 'current')
      rmSync(cur, { force: true })
      writeFileSync(path.join(frameworkRoot(home), '5.2.0', 'marker'), 'x')
      symlinkSync('5.2.0', cur)
      expect(readCurrentFrameworkVersion(home)).toBe('5.2.0')
      // Next startup versionCheck sees bundled 5.0.0 < current 5.2.0 → MUST NOT downgrade.
      const res = withFileLock(home, () => fm.versionCheck(['claude']))
      expect(res.swapped).toBe(false)
      expect(readCurrentFrameworkVersion(home)).toBe('5.2.0')
    })
  })

  describe('coreRoot override (update channel)', () => {
    it('materializes from an OVERRIDE core root instead of the bundled one', () => {
      // No bundled core at all — only the override.
      delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      const override = mkdtempSync(path.join(os.tmpdir(), 'fm-override-'))
      try {
        mkdirSync(path.join(override, 'dist', 'installer'), { recursive: true })
        writeFileSync(path.join(override, 'dist', 'installer', 'cli.js'), FAKE_CLI)
        writeFileSync(path.join(override, 'package.json'), JSON.stringify({ version: '6.0.0' }))
        const fm = new FrameworkManager({ home, coreRoot: override })
        expect(fm.isAvailable()).toBe(true)
        expect(fm.bundledVersion()).toBe('6.0.0')
        const res = fm.materialize('6.0.0', ['claude'])
        expect(res.ran).toBe(true)
        expect(fm.swapCurrent('6.0.0')).toBe(true)
        expect(readCurrentFrameworkVersion(home)).toBe('6.0.0')
      } finally {
        rmSync(override, { recursive: true, force: true })
      }
    })
  })

  describe('node interpreter (pkg-safety)', () => {
    // In the packaged app process.execPath is the specrails-server pkg binary, not
    // node — so the core CLI MUST be spawned with the bundled real node. Prove the
    // bundled node (resolveBundledNodeExe) is the interpreter, not process.execPath,
    // via a wrapper that records its invocation then exec's the real node.
    it.skipIf(process.platform === 'win32')(
      'spawns the core CLI with the bundled node when runtimes are present',
      () => {
        installFakeCore('5.0.0')
        const runtimes = mkdtempSync(path.join(os.tmpdir(), 'fm-rt-'))
        const prevRuntimes = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
        try {
          const nodeBin = path.join(runtimes, 'node', 'bin', 'node')
          mkdirSync(path.dirname(nodeBin), { recursive: true })
          const marker = path.join(runtimes, 'used-bundled-node')
          // Wrapper: record that the bundled node ran, then exec the real node.
          writeFileSync(
            nodeBin,
            `#!/bin/sh\necho used >> "${marker}"\nexec "${process.execPath}" "$@"\n`,
            { mode: 0o755 },
          )
          process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = runtimes

          const fm = new FrameworkManager({ home })
          const res = fm.materialize('5.0.0', ['claude'])
          expect(res.ran).toBe(true)
          expect(res.errors).toEqual([])
          // The wrapper ran ⇒ argv[0] was the bundled node, NOT process.execPath.
          expect(existsSync(marker)).toBe(true)
        } finally {
          if (prevRuntimes === undefined) delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
          else process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = prevRuntimes
          rmSync(runtimes, { recursive: true, force: true })
        }
      },
    )
  })
})
