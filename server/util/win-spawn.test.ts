import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnCli, resolveWindowsBinary, windowsSpawnEnv } from './win-spawn'

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
