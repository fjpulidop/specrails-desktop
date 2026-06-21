import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock only execFileSync (the `where` resolver) — keep the real `spawn` so the
// POSIX spawnCli tests still exercise a real child. Mock cross-spawn to capture
// the binary handed to it on the win32 path.
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>()
  return { ...actual, execFileSync: vi.fn() }
})
vi.mock('cross-spawn', () => ({ default: vi.fn(() => ({ pid: 1, on: vi.fn() })) }))

import { execFileSync } from 'child_process'
import crossSpawn from 'cross-spawn'
import {
  spawnCli,
  resolveWindowsBinary,
  windowsSpawnEnv,
  stripWindowsVerbatimPrefix,
  __resetWindowsBinaryResolveCacheForTest,
} from './win-spawn'

const ORIGINAL_PLATFORM = process.platform
function asWin32() {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
}
function restorePlatform() {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
}

describe('stripWindowsVerbatimPrefix', () => {
  it('strips the \\\\?\\ drive-letter prefix', () => {
    expect(stripWindowsVerbatimPrefix('\\\\?\\C:\\Users\\javi\\core\\cli.js')).toBe('C:\\Users\\javi\\core\\cli.js')
  })
  it('rewrites \\\\?\\UNC\\server\\share to \\\\server\\share', () => {
    expect(stripWindowsVerbatimPrefix('\\\\?\\UNC\\server\\share\\x')).toBe('\\\\server\\share\\x')
  })
  it('leaves an unprefixed path unchanged', () => {
    expect(stripWindowsVerbatimPrefix('C:\\Users\\javi')).toBe('C:\\Users\\javi')
    expect(stripWindowsVerbatimPrefix('/usr/local/bin/node')).toBe('/usr/local/bin/node')
  })
  it('tolerates empty/non-string', () => {
    expect(stripWindowsVerbatimPrefix('')).toBe('')
    expect(stripWindowsVerbatimPrefix(undefined as unknown as string)).toBe(undefined)
  })
})

describe('windowsSpawnEnv', () => {
  const ORIGINAL = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIGINAL, configurable: true })
  })

  it('returns the base env unchanged on POSIX (identity)', () => {
    if (process.platform === 'win32') return
    const base = { FOO: 'bar' } as NodeJS.ProcessEnv
    expect(windowsSpawnEnv(base)).toBe(base)
  })

  it('reconstructs SystemRoot/windir/ComSpec when missing on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const out = windowsSpawnEnv({ PATH: 'x' } as NodeJS.ProcessEnv)
    expect(out.SystemRoot).toBe('C:\\Windows')
    expect(out.windir).toBe('C:\\Windows')
    expect(out.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(out.PATH).toBe('x')
  })

  it('backfills npm config env (USERPROFILE/APPDATA/HOMEDRIVE/TEMP) from defaults on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const out = windowsSpawnEnv({ PATH: 'x' } as NodeJS.ProcessEnv)
    expect(out.USERPROFILE).toBe('C:\\Users\\Default')
    expect(out.HOMEDRIVE).toBe('C:')
    expect(out.HOMEPATH).toBe('\\Users\\Default')
    expect(out.APPDATA).toBe('C:\\Users\\Default\\AppData\\Roaming')
    expect(out.LOCALAPPDATA).toBe('C:\\Users\\Default\\AppData\\Local')
    expect(out.TEMP).toBe('C:\\Users\\Default\\AppData\\Local\\Temp')
    expect(out.TMP).toBe('C:\\Users\\Default\\AppData\\Local\\Temp')
  })

  it('derives APPDATA from an existing USERPROFILE and preserves existing values', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const out = windowsSpawnEnv({ USERPROFILE: 'C:\\Users\\javi', TEMP: 'D:\\t' } as NodeJS.ProcessEnv)
    expect(out.USERPROFILE).toBe('C:\\Users\\javi')
    expect(out.HOMEDRIVE).toBe('C:')
    expect(out.HOMEPATH).toBe('\\Users\\javi')
    expect(out.APPDATA).toBe('C:\\Users\\javi\\AppData\\Roaming')
    expect(out.TEMP).toBe('D:\\t') // preserved
  })

  it('builds USERPROFILE from HOMEDRIVE+HOMEPATH when USERPROFILE is absent', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const out = windowsSpawnEnv({ HOMEDRIVE: 'E:', HOMEPATH: '\\Users\\x' } as NodeJS.ProcessEnv)
    expect(out.USERPROFILE).toBe('E:\\Users\\x')
    expect(out.APPDATA).toBe('E:\\Users\\x\\AppData\\Roaming')
  })

  it('preserves existing SystemRoot and derives ComSpec from it', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const out = windowsSpawnEnv({ SystemRoot: 'D:\\Win\\' } as NodeJS.ProcessEnv)
    expect(out.SystemRoot).toBe('D:\\Win\\')
    expect(out.ComSpec).toBe('D:\\Win\\System32\\cmd.exe')
  })

  it('falls back to windir when SystemRoot is absent', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const out = windowsSpawnEnv({ windir: 'E:\\Windows' } as NodeJS.ProcessEnv)
    expect(out.SystemRoot).toBe('E:\\Windows')
  })
})

describe('resolveWindowsBinary', () => {
  it('returns the input unchanged on POSIX (no-op)', () => {
    // Test runs on the host platform; on POSIX runners (CI is Linux,
    // dev is macOS) the helper short-circuits.
    if (process.platform === 'win32') return
    expect(resolveWindowsBinary('claude')).toBe('claude')
    expect(resolveWindowsBinary('codex')).toBe('codex')
    expect(resolveWindowsBinary('does-not-exist-anywhere')).toBe('does-not-exist-anywhere')
  })

  describe('on win32 (mocked)', () => {
    beforeEach(() => {
      __resetWindowsBinaryResolveCacheForTest()
      vi.mocked(execFileSync).mockReset()
      asWin32()
    })
    afterEach(restorePlatform)

    it('resolves a bare name to its absolute shim path via `where`', () => {
      vi.mocked(execFileSync).mockReturnValue('C:\\Users\\u\\AppData\\Local\\Programs\\claude\\claude.cmd\r\n' as never)
      expect(resolveWindowsBinary('claude')).toBe('C:\\Users\\u\\AppData\\Local\\Programs\\claude\\claude.cmd')
      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith('where', ['claude'], expect.objectContaining({ encoding: 'utf-8' }))
    })

    it('prefers a .cmd/.exe over a .ps1 when `where` lists several', () => {
      vi.mocked(execFileSync).mockReturnValue('C:\\a\\claude.ps1\r\nC:\\b\\claude.cmd\r\n' as never)
      expect(resolveWindowsBinary('claude')).toBe('C:\\b\\claude.cmd')
    })

    it('falls back to the bare name when `where` finds nothing / throws', () => {
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found') })
      expect(resolveWindowsBinary('claude')).toBe('claude')
    })

    it('does not resolve a name that is already an absolute path', () => {
      expect(resolveWindowsBinary('C:\\tools\\claude.cmd')).toBe('C:\\tools\\claude.cmd')
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled()
    })

    it('caches the resolution (second call does not re-invoke `where`)', () => {
      vi.mocked(execFileSync).mockReturnValue('C:\\x\\claude.cmd\r\n' as never)
      expect(resolveWindowsBinary('claude')).toBe('C:\\x\\claude.cmd')
      expect(resolveWindowsBinary('claude')).toBe('C:\\x\\claude.cmd')
      expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1)
    })
  })
})

describe('spawnCli — win32 binary resolution (mocked)', () => {
  beforeEach(() => {
    __resetWindowsBinaryResolveCacheForTest()
    vi.mocked(execFileSync).mockReset()
    vi.mocked(crossSpawn).mockClear()
    asWin32()
  })
  afterEach(restorePlatform)

  it('hands cross-spawn the RESOLVED absolute path, not the bare name', () => {
    vi.mocked(execFileSync).mockReturnValue('C:\\u\\claude.cmd\r\n' as never)
    spawnCli('claude', ['-p', 'hi'], { env: { PATH: 'C:\\u' } as NodeJS.ProcessEnv })
    expect(vi.mocked(crossSpawn)).toHaveBeenCalledTimes(1)
    const [bin, args, opts] = vi.mocked(crossSpawn).mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }]
    expect(bin).toBe('C:\\u\\claude.cmd') // absolute → bypasses cmd.exe bare-name lookup
    expect(args).toEqual(['-p', 'hi'])
    expect(opts.env.PATH).toBe('C:\\u') // caller PATH preserved (+ SystemRoot backfill)
    expect(opts.env.SystemRoot).toBeTruthy()
  })

  it('falls back to the bare name for cross-spawn when `where` fails', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('nope') })
    spawnCli('claude', [], {})
    expect(vi.mocked(crossSpawn).mock.calls[0][0]).toBe('claude')
  })
})

describe('spawnCli', () => {
  // POSIX-only — Windows path uses cross-spawn which we don't exercise here.
  beforeEach(() => {
    if (process.platform === 'win32') return
  })

  it('spawns a real binary and resolves child output on POSIX', async () => {
    if (process.platform === 'win32') return
    const child = spawnCli('echo', ['hello world'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout!.on('data', (b: Buffer) => { out += b.toString() })
    const code: number = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? -1)))
    expect(code).toBe(0)
    expect(out.trim()).toBe('hello world')
  })

  it('emits an error event when the binary is missing on POSIX', async () => {
    if (process.platform === 'win32') return
    const child = spawnCli('definitely-not-a-real-binary-xyz', [], { stdio: ['ignore', 'pipe', 'pipe'] })
    const err: Error = await new Promise((resolve) => child.on('error', resolve))
    expect(err).toBeInstanceOf(Error)
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
  })
})
