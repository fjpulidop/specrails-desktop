import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}))

// On Windows the probe routes through cross-spawn (no shell:true). Forward its
// `.sync` to the same spawnSync mock so the platform-forced win32 tests exercise
// the real branch with the existing mock setups.
vi.mock('cross-spawn', () => ({ default: { sync: vi.fn() } }))

import { spawnSync } from 'child_process'
import crossSpawn from 'cross-spawn'
import {
  compareVersions,
  formatMissingSetupPrerequisites,
  getSetupPrerequisitesStatus,
  __resetSetupPrerequisitesCacheForTest,
  parseSemver,
  type SetupPrerequisitesStatus,
} from './setup-prerequisites'

const mockSpawnSync = vi.mocked(spawnSync)
const mockCrossSpawnSync = vi.mocked(crossSpawn.sync)

describe('setup prerequisites', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // cross-spawn (win32 path) delegates to the same spawnSync mock so a single
    // mockImplementation drives both platform branches.
    mockCrossSpawnSync.mockImplementation((cmd: any, args: any, opts: any) =>
      mockSpawnSync(cmd, args, opts) as any,
    )
    __resetSetupPrerequisitesCacheForTest()
  })

  it('reports all required tools as installed with versions when versions meet minimums', () => {
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 0 } as any
      // Return versions at/above the configured minimums (node 20.19, npm 9, git 2.20)
      if (cmd === 'node') return { status: 0, stdout: 'v20.19.0\n', stderr: '' } as any
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
    expect(tools).toHaveLength(5)
    expect(tools.map((item) => item.command)).toEqual(['node', 'npm', 'npx', 'git', 'gh'])
    expect(tools.every((item) => item.installed)).toBe(true)
    expect(tools.every((item) => item.executable)).toBe(true)
    expect(tools.every((item) => item.meetsMinimum)).toBe(true)
    expect(tools.find((item) => item.command === 'git')?.version).toBe('git version 2.42.1')
    // At least one provider is usable, satisfying the at-least-one-provider rule
    const providers = status.prerequisites.filter((p) => p.kind === 'provider')
    expect(providers.some((p) => p.installed && p.executable && p.meetsMinimum)).toBe(true)
  })

  it('reports platform field matching process.platform', () => {
    mockSpawnSync.mockImplementation(() => ({ status: 0, stdout: 'v20.19.0\n', stderr: '' } as any))
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
    expect(node?.minVersion).toBe('20.19.0')
  })

  it.each([
    ['v20.18.0', false],
    ['v20.19.0', true],
  ] as const)('enforces the Core-compatible Node boundary for %s', (nodeVersion, expected) => {
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 0 } as any
      if (cmd === 'node') return { status: 0, stdout: `${nodeVersion}\n`, stderr: '' } as any
      if (cmd === 'npm' || cmd === 'npx') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === 'git') return { status: 0, stdout: 'git version 2.42.1\n', stderr: '' } as any
      if (cmd === 'claude') return { status: 0, stdout: '1.2.3\n', stderr: '' } as any
      return { status: 1, stdout: '', stderr: 'not installed' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const node = status.prerequisites.find((item) => item.command === 'node')
    expect(node?.minVersion).toBe('20.19.0')
    expect(node?.meetsMinimum).toBe(expected)
    expect(status.missingRequired.some((item) => item.command === 'node')).toBe(!expected)
  })

  it('treats npx without minVersion as meeting any version requirement', () => {
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 0 } as any
      if (cmd === 'node') return { status: 0, stdout: 'v20.19.0\n', stderr: '' } as any
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
      if (cmd === 'node') return { status: 0, stdout: 'v20.19.0\n', stderr: '' } as any
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

  it('passes resolved paths with whitespace UNQUOTED on win32 (cross-spawn handles spaces)', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      mockSpawnSync.mockImplementation((cmd: any, args: any) => {
        if (cmd === 'where' || cmd === 'which') {
          if (args[0] === 'git') return { status: 0, stdout: 'C:\\Program Files\\Git\\cmd\\git.exe\r\n', stderr: '' } as any
          return { status: 0, stdout: `C:\\nodejs\\${args[0]}.cmd\r\n`, stderr: '' } as any
        }
        // cross-spawn is given the RAW path (no manual quoting); a quoted target
        // would be a regression, so only the unquoted form resolves.
        if (cmd === 'C:\\Program Files\\Git\\cmd\\git.exe') {
          return { status: 0, stdout: 'git version 2.42.1\n', stderr: '' } as any
        }
        if (cmd === 'C:\\nodejs\\node.cmd') return { status: 0, stdout: 'v20.19.0\n', stderr: '' } as any
        if (cmd === 'C:\\nodejs\\npm.cmd') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
        if (cmd === 'C:\\nodejs\\npx.cmd') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
        if (cmd === 'C:\\nodejs\\claude.cmd') return { status: 0, stdout: '1.0.0\n', stderr: '' } as any
        if (cmd === 'C:\\nodejs\\codex.cmd') return { status: 0, stdout: '0.128.0\n', stderr: '' } as any
        return { status: 1, stdout: '', stderr: 'quoted/unknown path' } as any
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
      if (cmd === 'node') return { status: 0, stdout: 'v20.19.0\n', stderr: '' } as any
      if (cmd === 'npm') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === 'npx') return { status: 0, stdout: '10.0.0\n', stderr: '' } as any
      if (cmd === 'git') return { status: 0, stdout: 'git version 2.42.1\n', stderr: '' } as any
      // All providers fail their version probe → unusable. claude/codex return a
      // non-zero status; gemini/kimi return 0 with empty stdout (no version
      // match → meetsMinimum false), so all registered providers are unusable.
      if (cmd === 'claude' || cmd === 'codex') return { status: 1, stdout: '', stderr: 'auth missing' } as any
      return { status: 0, stdout: '', stderr: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    expect(status.ok).toBe(false)
    const missingProviders = status.missingRequired
      .filter((p) => p.kind === 'provider')
      .map((p) => p.key)
      .sort()
    expect(missingProviders).toEqual(['claude', 'codex', 'gemini', 'kimi'])
  })

  it('registers Kimi 0.27+ with official install/login remediation', () => {
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 0, stdout: `/bin/${cmd}\n` } as any
      if (cmd === 'kimi') return { status: 0, stdout: 'Kimi Code 0.27.1\n', stderr: '' } as any
      return { status: 0, stdout: '99.0.0\n', stderr: '' } as any
    })
    const kimi = getSetupPrerequisitesStatus().prerequisites.find((item) => item.key === 'kimi')
    expect(kimi).toMatchObject({
      kind: 'provider',
      label: 'Kimi Code',
      command: 'kimi',
      minVersion: '0.27.0',
      installed: true,
      executable: true,
      meetsMinimum: true,
    })
    expect(kimi?.installUrl).toContain('kimi.com/code')
    expect(kimi?.installHint).toContain('kimi login')
  })

  it('does NOT block when at least one provider is usable', () => {
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 0 } as any
      if (cmd === 'node') return { status: 0, stdout: 'v20.19.0\n', stderr: '' } as any
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
    // win32 probes route through cross-spawn → forward to the spawnSync mock.
    mockCrossSpawnSync.mockImplementation((cmd: any, args: any, opts: any) =>
      mockSpawnSync(cmd, args, opts) as any,
    )
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
    const tools = status.prerequisites.filter((p) => p.kind === 'tool' && p.key !== 'uv' && p.key !== 'gh')
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
    const tools = status.prerequisites.filter((p) => p.kind === 'tool' && p.key !== 'uv' && p.key !== 'gh')
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
    const tools = status.prerequisites.filter((p) => p.kind === 'tool' && p.key !== 'uv' && p.key !== 'gh')
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
      if (cmd === '/usr/local/bin/node' || cmd === 'node') return { status: 0, stdout: 'v20.19.0\n', stderr: '' } as any
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

  // Materialize the POSIX npm package CLI JS inside the default runtimes tree so
  // npm/npx take the node-direct probe path (node <npm-cli.js> --version).
  function addNpmCliJs(): { npmCli: string; npxCli: string } {
    const binDir = path.join(runtimesBase, 'node', 'lib', 'node_modules', 'npm', 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    const npmCli = path.join(binDir, 'npm-cli.js')
    const npxCli = path.join(binDir, 'npx-cli.js')
    fs.writeFileSync(npmCli, '// npm')
    fs.writeFileSync(npxCli, '// npx')
    return { npmCli, npxCli }
  }

  it('probes npm/npx via the bundled node + npm-cli.js (node-direct), NOT the shim', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    addNpmCliJs()
    mockSpawnSync.mockImplementation((cmd: any, args: any) => {
      // node-direct: `node <…/npm-cli.js> --version` (npm package serves npx too)
      if (typeof args?.[0] === 'string' && args[0].endsWith('npm-cli.js')) return { status: 0, stdout: '10.9.0\n' } as any
      if (typeof args?.[0] === 'string' && args[0].endsWith('npx-cli.js')) return { status: 0, stdout: '10.9.0\n' } as any
      // bare node/git bundled probes
      if (typeof cmd === 'string' && cmd.endsWith('/node')) return { status: 0, stdout: 'v22.0.0\n' } as any
      if (typeof cmd === 'string' && cmd.includes('git')) return { status: 0, stdout: 'git version 2.49.0\n' } as any
      if (cmd === 'claude') return { status: 0, stdout: '1.0.0\n' } as any
      if (cmd === 'codex') return { status: 0, stdout: '0.128.0\n' } as any
      return { status: 0, stdout: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const npm = status.prerequisites.find((p) => p.key === 'npm')
    const npx = status.prerequisites.find((p) => p.key === 'npx')
    expect(npm?.bundled).toBe(true)
    expect(npm?.executable).toBe(true)
    expect(npm?.version).toBe('10.9.0')
    expect(npm?.resolvedPath?.endsWith('npm-cli.js')).toBe(true)
    expect(npx?.executable).toBe(true)
    expect(npx?.resolvedPath?.endsWith('npx-cli.js')).toBe(true)
  })

  it('npm/npx are advisory (required:false) and never block when bundled core+openspec are present', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    // Bundled core + bundled openspec → fully offline project-add (node cli.js /
    // node openspec.js); npm/npx are never spawned, so a broken npm must not block.
    const coreDir = path.join(tmpRoot, 'core')
    fs.mkdirSync(path.join(coreDir, 'dist', 'installer'), { recursive: true })
    fs.writeFileSync(path.join(coreDir, 'dist', 'installer', 'cli.js'), '// core')
    const osDir = path.join(tmpRoot, 'openspec')
    fs.mkdirSync(path.join(osDir, 'node_modules', '@fission-ai', 'openspec', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(osDir, 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js'), '// os')
    process.env.SPECRAILS_BUNDLED_CORE_PATH = coreDir
    process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH = osDir
    // Remove the bundled npm/npx shims so npm/npx fail to resolve entirely.
    fs.rmSync(path.join(runtimesBase, 'node', 'bin', 'npm'), { force: true })
    fs.rmSync(path.join(runtimesBase, 'node', 'bin', 'npx'), { force: true })
    try {
      mockSpawnSync.mockImplementation((cmd: any) => {
        if (cmd === 'which' || cmd === 'where') return { status: 1 } as any
        if (typeof cmd === 'string' && cmd.endsWith('/node')) return { status: 0, stdout: 'v22.0.0\n' } as any
        if (typeof cmd === 'string' && cmd.includes('git')) return { status: 0, stdout: 'git version 2.49.0\n' } as any
        return { status: 1, stdout: '', stderr: '' } as any
      })
      const status = getSetupPrerequisitesStatus()
      const npm = status.prerequisites.find((p) => p.key === 'npm')
      const npx = status.prerequisites.find((p) => p.key === 'npx')
      expect(npm?.required).toBe(false)
      expect(npx?.required).toBe(false)
      expect(status.missingRequired.some((p) => p.key === 'npm' || p.key === 'npx')).toBe(false)
      // node + git stay required.
      expect(status.prerequisites.find((p) => p.key === 'node')?.required).toBe(true)
      expect(status.prerequisites.find((p) => p.key === 'git')?.required).toBe(true)
    } finally {
      delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      delete process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH
    }
  })

  it('reports npm corrupted-bundle when the node-direct npm-cli.js probe fails', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    addNpmCliJs()
    mockSpawnSync.mockImplementation((cmd: any, args: any) => {
      if (typeof args?.[0] === 'string' && args[0].endsWith('npm-cli.js')) return { status: 1, stdout: '', stderr: 'kaboom' } as any
      if (typeof args?.[0] === 'string' && args[0].endsWith('npx-cli.js')) return { status: 0, stdout: '10.9.0\n' } as any
      if (typeof cmd === 'string' && cmd.endsWith('/node')) return { status: 0, stdout: 'v22.0.0\n' } as any
      if (typeof cmd === 'string' && cmd.includes('git')) return { status: 0, stdout: 'git version 2.49.0\n' } as any
      if (cmd === 'claude') return { status: 0, stdout: '1.0.0\n' } as any
      if (cmd === 'codex') return { status: 0, stdout: '0.128.0\n' } as any
      return { status: 0, stdout: '' } as any
    })

    const status = getSetupPrerequisitesStatus()
    const npm = status.prerequisites.find((p) => p.key === 'npm')
    expect(npm?.executable).toBe(false)
    expect(npm?.error).toBe('corrupted-bundle')
    expect(npm?.resolvedPath?.endsWith('npm-cli.js')).toBe(true)
    expect(npm?.executionError).toContain('kaboom')
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

describe('gh prerequisite (system-first, bundled fallback, auth-aware)', () => {
  const ORIGINAL_PLATFORM = process.platform
  let tmpRoot: string
  let runtimesBase: string

  function makeGhRuntimes(withGh = true): string {
    const base = path.join(tmpRoot, 'runtimes')
    fs.mkdirSync(path.join(base, 'gh', 'bin'), { recursive: true })
    if (withGh) fs.writeFileSync(path.join(base, 'gh', 'bin', 'gh'), '#!/bin/sh\n')
    return base
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mockCrossSpawnSync.mockImplementation((cmd: any, args: any, opts: any) =>
      mockSpawnSync(cmd, args, opts) as any,
    )
    __resetSetupPrerequisitesCacheForTest()
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sprq-gh-'))
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env.SPECRAILS_IS_DESKTOP = '1'
    runtimesBase = makeGhRuntimes()
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = runtimesBase
  })

  afterEach(() => {
    delete process.env.SPECRAILS_IS_DESKTOP
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('SYSTEM gh wins even when a bundled gh exists (auth config lives with the user install)', () => {
    mockSpawnSync.mockImplementation((cmd: any, args: any) => {
      if (cmd === 'which' && args?.[0] === 'gh') return { status: 0, stdout: '/usr/local/bin/gh\n' } as any
      if (cmd === 'which' || cmd === 'where') return { status: 1 } as any
      if (cmd === '/usr/local/bin/gh' && args?.[0] === '--version') return { status: 0, stdout: 'gh version 2.63.2 (2024-12-05)\n' } as any
      if (cmd === '/usr/local/bin/gh' && args?.[0] === 'auth') return { status: 0, stdout: 'gho_****\n' } as any
      return { status: 1, stdout: '', stderr: '' } as any
    })
    const gh = getSetupPrerequisitesStatus().prerequisites.find((p) => p.key === 'gh')
    expect(gh?.installed).toBe(true)
    expect(gh?.executable).toBe(true)
    expect(gh?.bundled).toBeUndefined()
    expect(gh?.resolvedPath).toBe('/usr/local/bin/gh')
    expect(gh?.authenticated).toBe(true)
  })

  it('falls back to the bundled gh when no system gh resolves', () => {
    mockSpawnSync.mockImplementation((cmd: any, args: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 1 } as any
      if (typeof cmd === 'string' && cmd.includes('runtimes/gh/bin/gh')) {
        if (args?.[0] === '--version') return { status: 0, stdout: 'gh version 2.63.2 (2024-12-05)\n' } as any
        if (args?.[0] === 'auth') return { status: 1, stdout: '', stderr: 'no oauth token' } as any
      }
      return { status: 1, stdout: '', stderr: '' } as any
    })
    const status = getSetupPrerequisitesStatus()
    const gh = status.prerequisites.find((p) => p.key === 'gh')
    expect(gh?.installed).toBe(true)
    expect(gh?.bundled).toBe(true)
    expect(gh?.resolvedPath).toBe(path.join(runtimesBase, 'gh', 'bin', 'gh'))
    // No credential yet: bundling removes the install step, not the login step.
    expect(gh?.authenticated).toBe(false)
    // Optional: never blocks Add Project.
    expect(status.missingRequired.some((p) => p.key === 'gh')).toBe(false)
  })

  it('bundled gh present but failing its probe reports corrupted-bundle WITHOUT blocking', () => {
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 1 } as any
      if (typeof cmd === 'string' && cmd.includes('runtimes/gh/bin/gh')) return { status: 126, stdout: '', stderr: 'exec format error' } as any
      return { status: 1, stdout: '', stderr: '' } as any
    })
    const status = getSetupPrerequisitesStatus()
    const gh = status.prerequisites.find((p) => p.key === 'gh')
    expect(gh?.error).toBe('corrupted-bundle')
    expect(gh?.executable).toBe(false)
    expect(status.missingRequired.some((p) => p.key === 'gh')).toBe(false)
  })

  it('no system gh and no bundled file → plainly not installed, still optional', () => {
    fs.rmSync(path.join(runtimesBase, 'gh', 'bin', 'gh'), { force: true })
    mockSpawnSync.mockImplementation((cmd: any) => {
      if (cmd === 'which' || cmd === 'where') return { status: 1 } as any
      return { status: 1, stdout: '', stderr: '' } as any
    })
    const status = getSetupPrerequisitesStatus()
    const gh = status.prerequisites.find((p) => p.key === 'gh')
    expect(gh?.installed).toBe(false)
    expect(gh?.required).toBe(false)
    expect(gh?.bundled).toBeUndefined()
    expect(status.missingRequired.some((p) => p.key === 'gh')).toBe(false)
  })

  it('non-desktop mode: gh probed via system PATH only, never the bundle', () => {
    delete process.env.SPECRAILS_IS_DESKTOP
    mockSpawnSync.mockImplementation((cmd: any, args: any) => {
      if (cmd === 'which' && args?.[0] === 'gh') return { status: 0, stdout: '/opt/homebrew/bin/gh\n' } as any
      if (cmd === 'which' || cmd === 'where') return { status: 1 } as any
      if (cmd === '/opt/homebrew/bin/gh' && args?.[0] === '--version') return { status: 0, stdout: 'gh version 2.65.0\n' } as any
      if (cmd === '/opt/homebrew/bin/gh' && args?.[0] === 'auth') return { status: 1 } as any
      return { status: 1, stdout: '', stderr: '' } as any
    })
    const gh = getSetupPrerequisitesStatus().prerequisites.find((p) => p.key === 'gh')
    expect(gh?.installed).toBe(true)
    expect(gh?.bundled).toBeUndefined()
    expect(gh?.authenticated).toBe(false)
  })
})
