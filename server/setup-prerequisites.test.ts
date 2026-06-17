import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}))

import { spawnSync } from 'child_process'
import {
  compareVersions,
  formatMissingSetupPrerequisites,
  getSetupPrerequisitesStatus,
  __resetSetupPrerequisitesCacheForTest,
  parseSemver,
  type SetupPrerequisitesStatus,
} from './setup-prerequisites'

const mockSpawnSync = vi.mocked(spawnSync)

describe('setup prerequisites', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    __resetSetupPrerequisitesCacheForTest()
  })

  it('reports all required tools as installed with versions when versions meet minimums', () => {
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 0 } as any
      // Return versions above the configured minimums (node 18, npm 9, git 2.20)
      if (cmd === 'node') return { status: 0, stdout: 'v20.11.0\n', stderr: '' } as any
      if (cmd === 'npm') return { status: 0, stdout: '10.2.4\n', stderr: '' } as any
      if (cmd === 'npx') return { status: 0, stdout: '10.2.4\n', stderr: '' } as any
      if (cmd === 'git') return { status: 0, stdout: 'git version 2.42.1\n', stderr: '' } as any
      // Providers: claude has no minVersion (any executable version is fine);
      // codex has min 0.128.0, so feed something ≥ that.
      if (cmd === 'claude') return { status: 0, stdout: '1.2.3\n', stderr: '' } as any
      if (cmd === 'codex') return { status: 0, stdout: 'codex-cli 0.128.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()

    expect(status.ok).toBe(true)
    expect(status.missingRequired).toEqual([])
    const tools = status.prerequisites.filter((p) => p.kind === 'tool')
    expect(tools).toHaveLength(4)
    expect(tools.map((item) => item.command)).toEqual(['node', 'npm', 'npx', 'git'])
    expect(tools.every((item) => item.installed)).toBe(true)
    expect(tools.every((item) => item.executable)).toBe(true)
    expect(tools.every((item) => item.meetsMinimum)).toBe(true)
    expect(tools.find((item) => item.command === 'git')?.version).toBe('git version 2.42.1')
    // At least one provider is usable, satisfying the at-least-one-provider rule
    const providers = status.prerequisites.filter((p) => p.kind === 'provider')
    expect(providers.some((p) => p.installed && p.executable && p.meetsMinimum)).toBe(true)
  })

  it('reports platform field matching process.platform', () => {
    mockSpawnSync.mockImplementation(() => ({ status: 0, stdout: 'v20.0.0\n', stderr: '' } as any))
    const status = getSetupPrerequisitesStatus()
    const expected = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
    expect(status.platform).toBe(expected)
  })

  it('flags an installed-but-too-old Node as missing via meetsMinimum=false', () => {
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 0 } as any
      if (cmd === 'node') return { status: 0, stdout: 'v14.21.3\n', stderr: '' } as any
      if (cmd === 'npm') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === 'npx') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === 'git') return { status: 0, stdout: 'git version 2.42.1\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()

    expect(status.ok).toBe(false)
    expect(status.missingRequired.map((item) => item.command)).toContain('node')
    const node = status.prerequisites.find((item) => item.command === 'node')
    expect(node?.installed).toBe(true)
    expect(node?.meetsMinimum).toBe(false)
    expect(node?.version).toBe('v14.21.3')
    expect(node?.minVersion).toBe('18.0.0')
  })

  it('treats npx without minVersion as meeting any version requirement', () => {
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 0 } as any
      if (cmd === 'node') return { status: 0, stdout: 'v20.0.0\n', stderr: '' } as any
      if (cmd === 'npm') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === 'npx') return { status: 0, stdout: '5.0.0\n', stderr: '' } as any
      if (cmd === 'git') return { status: 0, stdout: 'git version 2.42.1\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const npx = status.prerequisites.find((item) => item.command === 'npx')
    expect(npx?.minVersion).toBeUndefined()
    expect(npx?.meetsMinimum).toBe(true)
  })

  it('reports missing Git without probing its version', () => {
    mockSpawnSync.mockImplementation((cmd: any, args: any) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: args[0] === 'git' ? 1 : 0 } as any
      }
      // Return versions that meet the minimums for non-git tools
      if (cmd === 'node') return { status: 0, stdout: 'v20.0.0\n', stderr: '' } as any
      if (cmd === 'npm') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === 'npx') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      // Ensure at least one provider is usable so the at-least-one-provider
      // rule does NOT add the providers to missingRequired (we want this test
      // to assert that git alone is missing).
      if (cmd === 'claude') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
      if (cmd === 'codex') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()

    expect(status.ok).toBe(false)
    expect(status.missingRequired.map((item) => item.command)).toEqual(['git'])
    expect(mockSpawnSync).not.toHaveBeenCalledWith('git', ['--version'], expect.anything())
  })

  it('treats version-probe failures as not executable (broken-symlink detection)', () => {
    mockSpawnSync.mockImplementation((cmd: any, args: any) => {
      if (cmd === 'which' || cmd === 'where') {
        if (args[0] === 'node') return { error: new Error('lookup failed') } as any
        return { status: 0, stdout: `/usr/local/bin/${args[0]}\n`, stderr: '' } as any
      }
      if (cmd === '/usr/local/bin/npm') return { status: 1, stdout: '', stderr: 'npm failed' } as any
      if (cmd === '/usr/local/bin/npx') return { error: new Error('version failed') } as any
      if (cmd === '/usr/local/bin/git') return { status: 0, stdout: undefined, stderr: 'git version 2.50.0\n' } as any
      return { status: 0, stdout: undefined, stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()

    expect(status.ok).toBe(false)
    // node: not installed (which failed). npm/npx: which found them, version probe failed → executable=false.
    expect(status.missingRequired.map((item) => item.command).sort()).toEqual(['node', 'npm', 'npx'].sort())

    const node = status.prerequisites.find((item) => item.command === 'node')
    expect(node?.installed).toBe(false)
    expect(node?.executable).toBe(false)

    const npm = status.prerequisites.find((item) => item.command === 'npm')
    expect(npm?.installed).toBe(true)
    expect(npm?.executable).toBe(false)
    expect(npm?.version).toBeUndefined()
    expect(npm?.meetsMinimum).toBe(false)
    expect(npm?.installHint).toMatch(/failed to execute/)

    const git = status.prerequisites.find((item) => item.command === 'git')
    expect(git?.executable).toBe(true)
    expect(git?.version).toBe('git version 2.50.0')
  })

  it('flags installed-but-unexecutable Node distinctly from not-installed', () => {
    mockSpawnSync.mockImplementation((cmd: any, args: any) => {
      if (cmd === 'which' || cmd === 'where') {
        return { status: 0, stdout: `/usr/local/bin/${args[0]}\n`, stderr: '' } as any
      }
      if (cmd === '/usr/local/bin/node') return { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } as any
      if (cmd === '/usr/local/bin/npm') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === '/usr/local/bin/npx') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === '/usr/local/bin/git') return { status: 0, stdout: 'git version 2.42.1\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const node = status.prerequisites.find((item) => item.command === 'node')
    expect(node?.installed).toBe(true)
    expect(node?.executable).toBe(false)
    expect(node?.meetsMinimum).toBe(false)
    expect(node?.resolvedPath).toBe('/usr/local/bin/node')
    expect(node?.installHint).toMatch(/broken symlink/)
  })

  it('quotes resolved paths containing whitespace on win32 (Program Files)', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      mockSpawnSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === 'where' || cmd === 'which') {
          if (args[0] === 'git') return { status: 0, stdout: 'C:\\Program Files\\Git\\cmd\\git.exe\r\n', stderr: '' } as any
          return { status: 0, stdout: `C:\\nodejs\\${args[0]}.cmd\r\n`, stderr: '' } as any
        }
        if (cmd === '"C:\\Program Files\\Git\\cmd\\git.exe"') {
          return { status: 0, stdout: 'git version 2.42.1\n', stderr: '' } as any
        }
        if (cmd === 'C:\\nodejs\\node.cmd') return { status: 0, stdout: 'v20.11.0\n', stderr: '' } as any
        if (cmd === 'C:\\nodejs\\npm.cmd') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
        if (cmd === 'C:\\nodejs\\npx.cmd') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
        // Provider CLIs on win32 — keep at least one usable so this test (which
        // is about path-quoting for tools) is not gated by the provider rule.
        if (cmd === 'C:\\nodejs\\claude.cmd') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
        if (cmd === 'C:\\nodejs\\codex.cmd') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
        return { status: 1, stdout: '', stderr: 'unquoted path' } as any
      })

      const status = getSetupPrerequisitesStatus()
      const git = status.prerequisites.find((item) => item.command === 'git')
      expect(git?.executable).toBe(true)
      expect(git?.version).toBe('git version 2.42.1')
      expect(status.ok).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('marks all providers missingRequired when zero provider CLIs are usable', () => {
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 0 } as any
      if (cmd === 'node') return { status: 0, stdout: 'v20.0.0\n', stderr: '' } as any
      if (cmd === 'npm') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === 'npx') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === 'git') return { status: 0, stdout: 'git version 2.42.1\n', stderr: '' } as any
      // All providers fail their version probe → unusable. claude/codex return a
      // non-zero status; gemini returns 0 with empty stdout (no version match →
      // meetsMinimum false), so all three are unusable.
      if (cmd === 'claude' || cmd === 'codex') return { status: 1, stdout: '', stderr: 'auth missing' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    expect(status.ok).toBe(false)
    const missingProviders = status.missingRequired
      .filter((p) => p.kind === 'provider')
      .map((p) => p.key)
      .sort()
    expect(missingProviders).toEqual(['claude', 'codex', 'gemini'])
  })

  it('does NOT block when at least one provider is usable', () => {
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 0 } as any
      if (cmd === 'node') return { status: 0, stdout: 'v20.0.0\n', stderr: '' } as any
      if (cmd === 'npm') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === 'npx') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === 'git') return { status: 0, stdout: 'git version 2.42.1\n', stderr: '' } as any
      if (cmd === 'claude') return { status: 0, stdout: '1.2.3\n', stderr: '' } as any
      // Codex too old → not usable
      if (cmd === 'codex') return { status: 0, stdout: '0.100.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    expect(status.ok).toBe(true)
    expect(status.missingRequired).toEqual([])
    const codex = status.prerequisites.find((p) => p.key === 'codex')
    expect(codex?.installed).toBe(true)
    expect(codex?.executable).toBe(true)
    expect(codex?.meetsMinimum).toBe(false)
  })

  it('formats missing prerequisite guidance and returns null when ready', () => {
    const ready: SetupPrerequisitesStatus = {
      ok: true,
      prerequisites: [],
      missingRequired: [],
    }
    const missing: SetupPrerequisitesStatus = {
      ok: false,
      platform: 'darwin',
      prerequisites: [],
      missingRequired: [
        {
          key: 'git',
          kind: 'tool',
          label: 'Git',
          command: 'git',
          required: true,
          installed: false,
          executable: false,
          meetsMinimum: false,
          installUrl: 'https://git-scm.com/downloads',
          installHint: 'Install Git and restart Specrails.',
        },
      ],
    }

    expect(formatMissingSetupPrerequisites(ready)).toBeNull()
    expect(formatMissingSetupPrerequisites(missing)).toContain('Git (git) is not on PATH')
    expect(formatMissingSetupPrerequisites(missing)).toContain('restart Specrails')
  })
})

describe('getSetupPrerequisitesStatus — desktop mode', () => {
  const ORIGINAL_PLATFORM = process.platform
  let runtimesBase: string
  let tmpRoot: string

  /** Create a temp runtimes tree containing the requested tool files so the
   *  existence-gate in getSetupPrerequisitesStatus sees them on disk. The dir
   *  name ends in `runtimes` so the spawnSync mocks can substring-match
   *  `runtimes/node/bin/node` etc. */
  function makeRuntimes(tools: Partial<Record<'node' | 'npm' | 'npx' | 'git', boolean>> = {
    node: true, npm: true, npx: true, git: true,
  }): string {
    const base = path.join(tmpRoot, 'runtimes')
    fs.mkdirSync(path.join(base, 'node', 'bin'), { recursive: true })
    fs.mkdirSync(path.join(base, 'git', 'bin'), { recursive: true })
    fs.mkdirSync(path.join(base, 'git', 'cmd'), { recursive: true })
    fs.mkdirSync(path.join(base, 'node'), { recursive: true })
    const touch = (p: string) => fs.writeFileSync(p, '#!/bin/sh\n')
    if (tools.node) touch(path.join(base, 'node', 'bin', 'node'))
    if (tools.npm) touch(path.join(base, 'node', 'bin', 'npm'))
    if (tools.npx) touch(path.join(base, 'node', 'bin', 'npx'))
    if (tools.git) touch(path.join(base, 'git', 'bin', 'git'))
    return base
  }

  beforeEach(() => {
    vi.resetAllMocks()
    __resetSetupPrerequisitesCacheForTest()
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sprq-'))
    process.env.SPECRAILS_IS_DESKTOP = '1'
    runtimesBase = makeRuntimes()
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = runtimesBase
  })

  afterEach(() => {
    delete process.env.SPECRAILS_IS_DESKTOP
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('all bundled tools return bundled: true, installed: true, executable: true on success', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    // Desktop mode calls probeVersion with the absolute bundled path directly (no which call)
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 1 } as any // should not be called for bundled tools
      // bundled paths are probed directly
      if (typeof cmd === 'string' && cmd.includes('runtimes/node/bin/node')) return { status: 0, stdout: 'v22.0.0\n', stderr: '' } as any
      if (typeof cmd === 'string' && cmd.includes('runtimes/node/bin/npm')) return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (typeof cmd === 'string' && cmd.includes('runtimes/node/bin/npx')) return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (typeof cmd === 'string' && cmd.includes('runtimes/git/bin/git')) return { status: 0, stdout: 'git version 2.49.0\n', stderr: '' } as any
      // Providers (claude, codex) are probed via system path
      if (cmd === 'which') return { status: 0, stdout: '/usr/local/bin/claude\n', stderr: '' } as any
      if (cmd === 'claude') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
      if (cmd === 'codex') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const tools = status.prerequisites.filter((p) => p.kind === 'tool' && p.key !== 'uv')
    expect(tools.every((t) => t.bundled === true)).toBe(true)
    expect(tools.every((t) => t.installed === true)).toBe(true)
    expect(tools.every((t) => t.executable === true)).toBe(true)
    expect(tools.every((t) => t.error === undefined)).toBe(true)
  })

  it('resolvedPath is the bundled binary path, not a system which result', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('runtimes')) return { status: 0, stdout: 'v22.0.0\n', stderr: '' } as any
      if (cmd === 'claude') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
      if (cmd === 'codex') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const node = status.prerequisites.find((p) => p.key === 'node')
    expect(node?.resolvedPath).toContain('runtimes/node/bin/node')
    const git = status.prerequisites.find((p) => p.key === 'git')
    expect(git?.resolvedPath).toContain('runtimes/git/bin/git')
  })

  it('meetsMinimum is true when version meets threshold', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('runtimes/node/bin/node')) return { status: 0, stdout: 'v22.0.0\n', stderr: '' } as any
      if (typeof cmd === 'string' && cmd.includes('runtimes/node/bin/npm')) return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (typeof cmd === 'string' && cmd.includes('runtimes/node/bin/npx')) return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (typeof cmd === 'string' && cmd.includes('runtimes/git/bin/git')) return { status: 0, stdout: 'git version 2.49.0\n', stderr: '' } as any
      if (cmd === 'claude') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
      if (cmd === 'codex') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const tools = status.prerequisites.filter((p) => p.kind === 'tool' && p.key !== 'uv')
    expect(tools.every((t) => t.meetsMinimum === true)).toBe(true)
  })

  it('corrupted-bundle: executable: false, error: corrupted-bundle when probe fails (file present)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    mockSpawnSync.mockImplementation((cmd: any) => {
      // node binary EXISTS on disk (makeRuntimes) but its --version probe fails → genuine corruption
      if (typeof cmd === 'string' && cmd.includes('runtimes/node/bin/node')) {
        return { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } as any
      }
      if (typeof cmd === 'string' && cmd.includes('runtimes')) return { status: 0, stdout: 'v22.0.0\n', stderr: '' } as any
      if (cmd === 'claude') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
      if (cmd === 'codex') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const node = status.prerequisites.find((p) => p.key === 'node')
    expect(node?.bundled).toBe(true)
    expect(node?.executable).toBe(false)
    expect(node?.error).toBe('corrupted-bundle')
    expect(node?.installed).toBe(true)
    expect(node?.meetsMinimum).toBe(false)
  })

  it('corrupted-bundle: installHint is Bundle corrupted — reinstall...', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('runtimes/node/bin/node')) {
        return { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } as any
      }
      if (typeof cmd === 'string' && cmd.includes('runtimes')) return { status: 0, stdout: 'v22.0.0\n', stderr: '' } as any
      if (cmd === 'claude') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
      if (cmd === 'codex') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const node = status.prerequisites.find((p) => p.key === 'node')
    expect(node?.installHint).toContain('Bundle corrupted')
    expect(node?.installHint).toContain('reinstall')
  })

  it('corrupted-bundle: entry appears in missingRequired', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('runtimes/node/bin/node')) {
        return { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } as any
      }
      if (typeof cmd === 'string' && cmd.includes('runtimes')) return { status: 0, stdout: 'v22.0.0\n', stderr: '' } as any
      if (cmd === 'claude') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
      if (cmd === 'codex') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    expect(status.ok).toBe(false)
    expect(status.missingRequired.map((m) => m.key)).toContain('node')
    const missing = status.missingRequired.find((m) => m.key === 'node')
    expect(missing?.error).toBe('corrupted-bundle')
  })

  it('bundle absent (no runtimes files) → falls back to system probe, no corrupted-bundle, no bundled flag', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    // Point at an empty runtimes dir: the bundled binary FILES do not exist, so
    // the existence-gate must fall through to the system `which` probe rather
    // than reporting corrupted-bundle (the Windows-ARM64 / partial-extraction case).
    const emptyBase = path.join(tmpRoot, 'empty', 'runtimes')
    fs.mkdirSync(emptyBase, { recursive: true })
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = emptyBase
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 0, stdout: '/usr/local/bin/node\n', stderr: '' } as any
      if (cmd === '/usr/local/bin/node' || cmd === 'node') return { status: 0, stdout: 'v22.0.0\n', stderr: '' } as any
      if (cmd === '/usr/local/bin/npm' || cmd === 'npm') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === '/usr/local/bin/npx' || cmd === 'npx') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === '/usr/local/bin/git' || cmd === 'git') return { status: 0, stdout: 'git version 2.49.0\n', stderr: '' } as any
      if (cmd === 'claude' || cmd === '/usr/local/bin/claude') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
      if (cmd === 'codex' || cmd === '/usr/local/bin/codex') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const tools = status.prerequisites.filter((p) => p.kind === 'tool' && p.key !== 'uv')
    expect(tools.every((t) => t.bundled === undefined)).toBe(true)
    expect(tools.every((t) => t.error === undefined)).toBe(true)
    expect(tools.every((t) => t.installed === true)).toBe(true)
    // which (system probe) WAS used — proving fallback, not the bundled path
    const node = status.prerequisites.find((p) => p.key === 'node')
    expect(node?.resolvedPath).toBe('/usr/local/bin/node')
  })

  it('windows git falls back to git/bin/git.exe when git/cmd/git.exe is absent', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    // Build a win-style runtimes tree with node.exe + npm.cmd + npx.cmd and git
    // present ONLY at git/bin/git.exe (no cmd/git.exe) to exercise the alt-subpath.
    const winBase = path.join(tmpRoot, 'win', 'runtimes')
    fs.mkdirSync(path.join(winBase, 'node'), { recursive: true })
    fs.mkdirSync(path.join(winBase, 'git', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(winBase, 'node', 'node.exe'), 'x')
    fs.writeFileSync(path.join(winBase, 'node', 'npm.cmd'), 'x')
    fs.writeFileSync(path.join(winBase, 'node', 'npx.cmd'), 'x')
    fs.writeFileSync(path.join(winBase, 'git', 'bin', 'git.exe'), 'x')
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = winBase
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('git.exe')) return { status: 0, stdout: 'git version 2.49.0\n', stderr: '' } as any
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('node.exe')) return { status: 0, stdout: 'v22.0.0\n', stderr: '' } as any
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('npm.cmd')) return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (typeof cmd === 'string' && cmd.toLowerCase().includes('npx.cmd')) return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === 'claude') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
      if (cmd === 'codex') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const git = status.prerequisites.find((p) => p.key === 'git')
    expect(git?.bundled).toBe(true)
    expect(git?.executable).toBe(true)
    expect(git?.resolvedPath?.replace(/\\/g, '/')).toContain('git/bin/git.exe')
  })

  it('provider CLIs (claude/codex) are still probed via system path in desktop mode', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('runtimes')) return { status: 0, stdout: 'v22.0.0\n', stderr: '' } as any
      // Providers probed via which + version
      if (cmd === 'which' || cmd === 'where') return { status: 0, stdout: '/usr/local/bin/claude\n', stderr: '' } as any
      if (cmd === 'claude' || cmd === '/usr/local/bin/claude') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
      if (cmd === 'codex' || cmd === '/usr/local/bin/codex') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const providers = status.prerequisites.filter((p) => p.kind === 'provider')
    // Providers must not have bundled flag
    expect(providers.every((p) => p.bundled === undefined)).toBe(true)
  })

  it('non-desktop mode unchanged: uses which, no bundled field', () => {
    delete process.env.SPECRAILS_IS_DESKTOP
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH

    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 0, stdout: '/usr/local/bin/node\n', stderr: '' } as any
      if (cmd === '/usr/local/bin/node' || cmd === 'node') return { status: 0, stdout: 'v20.0.0\n', stderr: '' } as any
      if (cmd === '/usr/local/bin/npm' || cmd === 'npm') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === '/usr/local/bin/npx' || cmd === 'npx') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === '/usr/local/bin/git' || cmd === 'git') return { status: 0, stdout: 'git version 2.42.1\n', stderr: '' } as any
      if (cmd === 'claude' || cmd === '/usr/local/bin/claude') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
      if (cmd === 'codex' || cmd === '/usr/local/bin/codex') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const tools = status.prerequisites.filter((p) => p.kind === 'tool')
    // No bundled field in non-desktop mode
    expect(tools.every((t) => t.bundled === undefined)).toBe(true)
    expect(tools.every((t) => t.error === undefined)).toBe(true)
  })
})

describe('parseSemver', () => {
  it('extracts semver triple from common formats', () => {
    expect(parseSemver('v18.0.0')).toEqual([18, 0, 0])
    expect(parseSemver('20.11.0')).toEqual([20, 11, 0])
    expect(parseSemver('git version 2.42.1')).toEqual([2, 42, 1])
    expect(parseSemver('node v18.17.1\nextra')).toEqual([18, 17, 1])
  })

  it('returns null for unparseable input', () => {
    expect(parseSemver(undefined)).toBeNull()
    expect(parseSemver('')).toBeNull()
    expect(parseSemver('not a version')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('returns positive when a > b, negative when a < b, zero when equal', () => {
    expect(compareVersions('20.0.0', '18.0.0')).toBeGreaterThan(0)
    expect(compareVersions('14.21.3', '18.0.0')).toBeLessThan(0)
    expect(compareVersions('18.0.0', '18.0.0')).toBe(0)
    expect(compareVersions('git version 2.42.1', '2.20.0')).toBeGreaterThan(0)
  })

  it('returns 0 for unparseable inputs (conservative)', () => {
    expect(compareVersions('weird', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', 'weird')).toBe(0)
  })
})
