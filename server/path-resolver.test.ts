import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  resolveStartupPath,
  augmentPathFromLoginShell,
  parseLoginShellOutput,
  getPathDiagnostic,
  resolveBundledRuntimePath,
  resolveBundledNodeExe,
  __resetPathResolverForTest,
} from './path-resolver'

const ORIGINAL_PATH = process.env.PATH
const ORIGINAL_PLATFORM = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value })
}

/** Create a real temp runtimes tree so the existence-gated desktop branch
 *  prepends them. Returns the base dir plus the node/bin and git/{bin,cmd}
 *  subdirs (all created on disk). */
function makeRuntimesDir(): { base: string; nodeBin: string; gitBin: string; gitCmd: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prq-'))
  const nodeBin = path.join(base, 'node', 'bin')
  const gitBin = path.join(base, 'git', 'bin')
  const gitCmd = path.join(base, 'git', 'cmd')
  fs.mkdirSync(nodeBin, { recursive: true })
  fs.mkdirSync(gitBin, { recursive: true })
  fs.mkdirSync(gitCmd, { recursive: true })
  // Create the actual binary files — the resolver gates on file existence, not
  // just the directory. Touch both POSIX and Windows layouts so the helper works
  // regardless of which platform a test mocks.
  fs.writeFileSync(path.join(nodeBin, 'node'), '#!/bin/sh\n')
  fs.writeFileSync(path.join(gitBin, 'git'), '#!/bin/sh\n')
  fs.writeFileSync(path.join(base, 'node', 'node.exe'), 'x')
  fs.writeFileSync(path.join(gitCmd, 'git.exe'), 'x')
  return { base, nodeBin, gitBin, gitCmd }
}

describe('resolveStartupPath (fast path)', () => {
  beforeEach(() => {
    __resetPathResolverForTest()
  })

  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH
    setPlatform(ORIGINAL_PLATFORM)
  })

  it('prepends missing brew Apple Silicon dirs on darwin', () => {
    setPlatform('darwin')
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
    resolveStartupPath()
    expect(process.env.PATH?.startsWith('/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:')).toBe(true)
    expect(process.env.PATH).toContain('/usr/bin')
  })

  it('is idempotent when dirs already present', () => {
    setPlatform('darwin')
    process.env.PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin'
    const before = process.env.PATH
    resolveStartupPath()
    expect(process.env.PATH).toBe(before)
  })

  it('is no-op on win32', () => {
    setPlatform('win32')
    const before = 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd'
    process.env.PATH = before
    resolveStartupPath()
    expect(process.env.PATH).toBe(before)
  })

  it('records path sources in diagnostic', () => {
    setPlatform('darwin')
    process.env.PATH = '/usr/bin:/bin'
    resolveStartupPath()
    const diag = getPathDiagnostic()
    expect(diag.pathSegments[0]).toBe('/opt/homebrew/bin')
    expect(diag.pathSources[0]).toBe('fast-path')
    expect(diag.pathSources[diag.pathSources.length - 1]).toBe('inherited')
  })
})

describe('parseLoginShellOutput', () => {
  it('extracts content between sentinels and ignores noise', () => {
    const stdout = 'rc-file noise here\nNVM warning\n__SRH_PATH_BEGIN__/Users/me/.volta/bin:/usr/bin:/bin__SRH_PATH_END__\nmore noise'
    expect(parseLoginShellOutput(stdout)).toBe('/Users/me/.volta/bin:/usr/bin:/bin')
  })

  it('returns null when sentinels missing', () => {
    expect(parseLoginShellOutput('no sentinels here')).toBeNull()
    expect(parseLoginShellOutput('__SRH_PATH_BEGIN__incomplete')).toBeNull()
  })
})

describe('augmentPathFromLoginShell', () => {
  beforeEach(() => {
    __resetPathResolverForTest()
    delete process.env.VITEST
    process.env.NODE_ENV = 'production'
  })

  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH
    setPlatform(ORIGINAL_PLATFORM)
    process.env.VITEST = 'true'
    process.env.NODE_ENV = 'test'
  })

  it('skips spawn under VITEST=true', async () => {
    process.env.VITEST = 'true'
    setPlatform('darwin')
    process.env.PATH = '/usr/bin'
    const spawnFn = vi.fn()
    await augmentPathFromLoginShell({ spawnFn: spawnFn as any })
    expect(spawnFn).not.toHaveBeenCalled()
    expect(getPathDiagnostic().loginShellStatus).toBe('skipped')
  })

  it('merges new segments from login shell output', async () => {
    setPlatform('darwin')
    process.env.PATH = '/usr/bin:/bin'
    const fakeSpawn = makeFakeSpawn({
      stdout: '__SRH_PATH_BEGIN__/Users/me/.volta/bin:/usr/bin:/bin__SRH_PATH_END__',
      exitCode: 0,
    })
    await augmentPathFromLoginShell({ spawnFn: fakeSpawn as any })
    expect(process.env.PATH?.startsWith('/Users/me/.volta/bin:')).toBe(true)
    expect(getPathDiagnostic().loginShellStatus).toBe('ok')
  })

  it('leaves PATH unchanged on timeout', async () => {
    setPlatform('darwin')
    process.env.PATH = '/usr/bin:/bin'
    const before = process.env.PATH
    const hangingSpawn = makeFakeSpawn({ stdout: '', exitCode: null, hang: true })
    await augmentPathFromLoginShell({ spawnFn: hangingSpawn as any, timeoutMs: 30 })
    expect(process.env.PATH).toBe(before)
    expect(getPathDiagnostic().loginShellStatus).toBe('timeout')
  })

  it('reports error when spawn fails', async () => {
    setPlatform('darwin')
    process.env.PATH = '/usr/bin'
    const errorSpawn = (() => {
      const child: any = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => { /* noop */ }
      setImmediate(() => child.emit('error', new Error('boom')))
      return () => child
    })()
    await augmentPathFromLoginShell({ spawnFn: errorSpawn as any })
    expect(getPathDiagnostic().loginShellStatus).toBe('error')
  })

  it('is no-op on win32', async () => {
    setPlatform('win32')
    const before = process.env.PATH
    const spawnFn = vi.fn()
    await augmentPathFromLoginShell({ spawnFn: spawnFn as any })
    expect(spawnFn).not.toHaveBeenCalled()
    expect(process.env.PATH).toBe(before)
  })
})

describe('resolveBundledRuntimePath', () => {
  afterEach(() => {
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
  })

  it('returns env var value when set', () => {
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = '/tmp/runtimes'
    expect(resolveBundledRuntimePath()).toBe('/tmp/runtimes')
  })

  it('throws when env var is missing', () => {
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    expect(() => resolveBundledRuntimePath()).toThrow('SPECRAILS_BUNDLED_RUNTIMES_PATH is not set')
  })
})

describe('resolveStartupPath — desktop mode', () => {
  const ORIGINAL_PATH = process.env.PATH
  const ORIGINAL_PLATFORM = process.platform
  let rt: ReturnType<typeof makeRuntimesDir>

  beforeEach(() => {
    __resetPathResolverForTest()
    process.env.SPECRAILS_IS_DESKTOP = '1'
    rt = makeRuntimesDir()
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = rt.base
  })

  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH
    delete process.env.SPECRAILS_IS_DESKTOP
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM })
    fs.rmSync(rt.base, { recursive: true, force: true })
  })

  it('prepends node/bin and git/bin dirs on non-Windows (macOS/Linux)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.PATH = '/usr/bin:/bin'
    resolveStartupPath()
    expect(process.env.PATH).toContain(rt.nodeBin)
    expect(process.env.PATH).toContain(rt.gitBin)
    expect(process.env.PATH?.startsWith(rt.nodeBin)).toBe(true)
  })

  it('prepends node/ and git/cmd/ dirs on Windows (mock: platform=win32, path.sep stays /)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    // On macOS, path.join always uses '/' even when platform is mocked to win32.
    // The getDelimiter() check does use the mocked platform so PATH uses ';'.
    process.env.PATH = '/Windows/System32'
    resolveStartupPath()
    // PATH joined by ';' (Windows delimiter) because process.platform is mocked
    const parts = (process.env.PATH ?? '').split(';')
    expect(parts.length).toBeGreaterThanOrEqual(3)
    expect(parts[0]).toContain('node')
    expect(parts[1]).toContain('git')
  })

  it('marks prepended dirs as bundled in diagnostic', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.PATH = '/usr/bin'
    resolveStartupPath()
    const diag = getPathDiagnostic()
    expect(diag.pathSources[0]).toBe('bundled')
    expect(diag.pathSources[1]).toBe('bundled')
    // The inherited /usr/bin entry is after the bundled ones
    const inheritedIdx = diag.pathSegments.indexOf('/usr/bin')
    expect(inheritedIdx).toBeGreaterThan(0)
    expect(diag.pathSources[inheritedIdx]).toBe('inherited')
  })

  it('does NOT run homebrew prepend when an active bundle is present on darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.PATH = '/usr/bin:/bin'
    resolveStartupPath()
    expect(process.env.PATH).not.toContain('/opt/homebrew/bin')
  })

  it('falls back to system resolution when SPECRAILS_BUNDLED_RUNTIMES_PATH is unset (graceful, not no-op)', () => {
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.PATH = '/usr/bin:/bin'
    expect(() => resolveStartupPath()).not.toThrow()
    // No bundle → fall through to the macOS fast-path prepend so system tools resolve.
    expect(process.env.PATH?.startsWith('/opt/homebrew/bin')).toBe(true)
    expect(getPathDiagnostic().pathSources[0]).toBe('fast-path')
  })

  it('falls back to system resolution when the runtimes dir exists but has no node/git (e.g. Windows ARM64)', () => {
    // Point at an empty runtimes base: candidate dirs do not exist → no 'bundled'
    // prepend, and system discovery must still run (no dead PATH, no early return).
    const emptyBase = fs.mkdtempSync(path.join(os.tmpdir(), 'prq-empty-'))
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = emptyBase
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.PATH = '/usr/bin:/bin'
    resolveStartupPath()
    const diag = getPathDiagnostic()
    expect(diag.pathSources).not.toContain('bundled')
    expect(process.env.PATH?.startsWith('/opt/homebrew/bin')).toBe(true)
    fs.rmSync(emptyBase, { recursive: true, force: true })
  })

  it('treats a PARTIAL bundle (node present, git absent) as not-active → full system fallback', () => {
    // Remove just the git binaries so only node remains. A partial bundle must NOT
    // suppress system discovery, otherwise the missing tool (git) would fall through
    // to a system probe against an un-augmented PATH and be wrongly reported missing.
    fs.rmSync(path.join(rt.gitBin, 'git'), { force: true })
    fs.rmSync(path.join(rt.gitCmd, 'git.exe'), { force: true })
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.PATH = '/usr/bin:/bin'
    resolveStartupPath()
    const diag = getPathDiagnostic()
    // Bundle not active: no 'bundled' segments, homebrew fast-path prepended so
    // system git resolves, and login-shell augmentation is left enabled.
    expect(diag.pathSources).not.toContain('bundled')
    expect(process.env.PATH?.startsWith('/opt/homebrew/bin')).toBe(true)
    expect(process.env.PATH).not.toContain(rt.nodeBin)
  })
})

describe('augmentPathFromLoginShell — desktop mode', () => {
  const ORIGINAL_PATH = process.env.PATH
  const ORIGINAL_PLATFORM = process.platform
  let rt: ReturnType<typeof makeRuntimesDir>

  beforeEach(() => {
    __resetPathResolverForTest()
    delete process.env.VITEST
    process.env.NODE_ENV = 'production'
    process.env.SPECRAILS_IS_DESKTOP = '1'
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    rt = makeRuntimesDir()
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = rt.base
    process.env.PATH = '/usr/bin:/bin'
  })

  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH
    process.env.VITEST = 'true'
    process.env.NODE_ENV = 'test'
    delete process.env.SPECRAILS_IS_DESKTOP
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM })
    fs.rmSync(rt.base, { recursive: true, force: true })
  })

  it('returns immediately without spawning when an active bundle was prepended', async () => {
    resolveStartupPath() // activates the bundle
    const spawnFn = vi.fn()
    await augmentPathFromLoginShell({ spawnFn: spawnFn as any })
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('sets loginShellStatus to skipped when an active bundle is present', async () => {
    resolveStartupPath()
    const spawnFn = vi.fn()
    await augmentPathFromLoginShell({ spawnFn: spawnFn as any })
    expect(getPathDiagnostic().loginShellStatus).toBe('skipped')
  })

  it('DOES run login-shell augmentation in desktop mode when no bundle is active (fallback)', async () => {
    // Empty runtimes base → resolveStartupPath does not activate a bundle, so
    // login-shell augmentation must still run to find nvm/volta/fnm shims.
    const emptyBase = fs.mkdtempSync(path.join(os.tmpdir(), 'prq-empty-'))
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = emptyBase
    resolveStartupPath()
    const fakeSpawn = makeFakeSpawn({
      stdout: '__SRH_PATH_BEGIN__/Users/me/.volta/bin:/usr/bin__SRH_PATH_END__',
      exitCode: 0,
    })
    await augmentPathFromLoginShell({ spawnFn: fakeSpawn as any })
    expect(process.env.PATH).toContain('/Users/me/.volta/bin')
    expect(getPathDiagnostic().loginShellStatus).toBe('ok')
    fs.rmSync(emptyBase, { recursive: true, force: true })
  })
})

describe('path-resolver — integration: full desktop startup sequence', () => {
  const ORIGINAL_PATH = process.env.PATH
  const ORIGINAL_PLATFORM = process.platform
  let rt: ReturnType<typeof makeRuntimesDir>

  beforeEach(() => {
    __resetPathResolverForTest()
    delete process.env.VITEST
    process.env.NODE_ENV = 'production'
    process.env.SPECRAILS_IS_DESKTOP = '1'
    rt = makeRuntimesDir()
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = rt.base
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.PATH = '/usr/bin:/bin'
  })

  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH
    process.env.VITEST = 'true'
    process.env.NODE_ENV = 'test'
    delete process.env.SPECRAILS_IS_DESKTOP
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM })
    fs.rmSync(rt.base, { recursive: true, force: true })
  })

  it('full sequence: bundled dirs are first in PATH; spawn never called; loginShellStatus skipped', async () => {
    const spawnFn = vi.fn()

    // Phase 1: startup path resolution
    resolveStartupPath()

    // Phase 2: login shell augmentation (should be no-op in desktop mode with active bundle)
    await augmentPathFromLoginShell({ spawnFn: spawnFn as any })

    // Bundled dirs must be first
    expect(process.env.PATH?.startsWith(rt.nodeBin)).toBe(true)
    expect(process.env.PATH).toContain(rt.gitBin)

    // System dirs preserved
    expect(process.env.PATH).toContain('/usr/bin')

    // Homebrew NOT prepended
    expect(process.env.PATH).not.toContain('/opt/homebrew')

    // spawn must not have been called
    expect(spawnFn).not.toHaveBeenCalled()

    // Diagnostic: bundled sources first, loginShellStatus skipped
    const diag = getPathDiagnostic()
    expect(diag.pathSources[0]).toBe('bundled')
    expect(diag.loginShellStatus).toBe('skipped')
  })
})

function makeFakeSpawn(opts: { stdout: string; exitCode: number | null; hang?: boolean }) {
  return () => {
    const child: any = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    let killed = false
    child.kill = () => {
      killed = true
      setImmediate(() => child.emit('close', null))
    }
    if (!opts.hang) {
      setImmediate(() => {
        if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout, 'utf-8'))
        child.emit('close', opts.exitCode)
      })
    }
    // When hang=true, only resolves via kill triggered by timeout
    void killed
    return child
  }
}

describe('resolveBundledNodeExe', () => {
  const ORIGINAL_RUNTIMES = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH

  afterEach(() => {
    if (ORIGINAL_RUNTIMES === undefined) delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    else process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = ORIGINAL_RUNTIMES
    setPlatform(ORIGINAL_PLATFORM)
  })

  it('returns null when SPECRAILS_BUNDLED_RUNTIMES_PATH is unset', () => {
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    expect(resolveBundledNodeExe()).toBeNull()
  })

  it('returns null when set but the node binary is absent', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-empty-'))
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = empty
    try {
      expect(resolveBundledNodeExe()).toBeNull()
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })

  it('returns the POSIX node path when the bundled binary exists (non-win32)', () => {
    setPlatform('darwin')
    const { base } = makeRuntimesDir()
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = base
    try {
      expect(resolveBundledNodeExe()).toBe(path.join(base, 'node', 'bin', 'node'))
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('returns the node.exe path on win32', () => {
    setPlatform('win32')
    const { base } = makeRuntimesDir()
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = base
    try {
      expect(resolveBundledNodeExe()).toBe(path.join(base, 'node', 'node.exe'))
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('never returns process.execPath (the pkg binary) — the openspec-init regression guard', () => {
    setPlatform('darwin')
    const { base } = makeRuntimesDir()
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = base
    try {
      expect(resolveBundledNodeExe()).not.toBe(process.execPath)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})
