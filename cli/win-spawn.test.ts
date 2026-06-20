import { describe, it, expect, afterEach } from 'vitest'
import { windowsSpawnEnv, spawnCli } from './win-spawn'

const ORIGINAL_PLATFORM = process.platform
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

describe('cli windowsSpawnEnv', () => {
  afterEach(() => setPlatform(ORIGINAL_PLATFORM))

  it('returns base unchanged on POSIX', () => {
    setPlatform('linux')
    const base = { FOO: 'bar' } as NodeJS.ProcessEnv
    expect(windowsSpawnEnv(base)).toBe(base)
  })

  it('backfills SystemRoot/windir/ComSpec on win32 when absent', () => {
    setPlatform('win32')
    const out = windowsSpawnEnv({ PATH: 'x' } as NodeJS.ProcessEnv)
    expect(out.SystemRoot).toBe('C:\\Windows')
    expect(out.windir).toBe('C:\\Windows')
    expect(out.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(out.PATH).toBe('x')
  })

  it('preserves existing SystemRoot and derives ComSpec from it', () => {
    setPlatform('win32')
    const out = windowsSpawnEnv({ SystemRoot: 'D:\\Win' } as NodeJS.ProcessEnv)
    expect(out.SystemRoot).toBe('D:\\Win')
    expect(out.ComSpec).toBe('D:\\Win\\System32\\cmd.exe')
  })
})

describe('cli spawnCli (POSIX path)', () => {
  afterEach(() => setPlatform(ORIGINAL_PLATFORM))

  it('spawns a real binary and resolves output on POSIX', async () => {
    if (process.platform === 'win32') return
    const child = spawnCli('echo', ['hello'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout!.on('data', (b: Buffer) => { out += b.toString() })
    const code: number = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? -1)))
    expect(code).toBe(0)
    expect(out.trim()).toBe('hello')
  })
})
