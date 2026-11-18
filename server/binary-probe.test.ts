import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('./util/bounded-exec', () => ({ execBounded: vi.fn() }))

import { execSync as mockExecSync } from 'child_process'
import { execBounded } from './util/bounded-exec'
import { binaryOnPath, binaryOnPathAsync, probeCliBinary, runProbeCommand, WHICH_TIMEOUT_MS, __resetBinaryProbeCacheForTest } from './binary-probe'

describe('binaryOnPath (H19)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    __resetBinaryProbeCacheForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns true when which succeeds and false when it throws', () => {
    vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
    expect(binaryOnPath('claude')).toBe(true)

    __resetBinaryProbeCacheForTest()
    vi.mocked(mockExecSync).mockImplementation(() => { throw new Error('not found') })
    expect(binaryOnPath('claude')).toBe(false)
  })

  it('caches the result per binary within the TTL', () => {
    vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))

    expect(binaryOnPath('claude')).toBe(true)
    expect(binaryOnPath('claude')).toBe(true)
    expect(mockExecSync).toHaveBeenCalledTimes(1)

    // Different binary → its own probe.
    expect(binaryOnPath('codex')).toBe(true)
    expect(mockExecSync).toHaveBeenCalledTimes(2)
  })

  it('caches negative results too', () => {
    vi.mocked(mockExecSync).mockImplementation(() => { throw new Error('not found') })

    expect(binaryOnPath('claude')).toBe(false)
    expect(binaryOnPath('claude')).toBe(false)
    expect(mockExecSync).toHaveBeenCalledTimes(1)
  })

  it('re-probes after the TTL expires', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    vi.mocked(mockExecSync).mockImplementation(() => { throw new Error('not found') })

    expect(binaryOnPath('claude')).toBe(false)

    // Within TTL — cached negative even though the binary appeared.
    vi.mocked(mockExecSync).mockReturnValue(Buffer.from('/usr/bin/claude'))
    vi.setSystemTime(new Date('2026-01-01T00:00:20Z'))
    expect(binaryOnPath('claude')).toBe(false)

    // Past TTL — fresh probe sees it.
    vi.setSystemTime(new Date('2026-01-01T00:00:31Z'))
    expect(binaryOnPath('claude')).toBe(true)
  })
})

describe('binaryOnPath — absolute binaries', () => {
  it('probes an absolute path by existence instead of which/where', async () => {
    const { binaryOnPath } = await import('./binary-probe')
    expect(binaryOnPath(process.execPath)).toBe(true)
    expect(binaryOnPath('/definitely/not/here/node')).toBe(false)
  })
})

describe('async probes (event-loop safe)', () => {
  const mockBounded = vi.mocked(execBounded)
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  beforeEach(() => {
    vi.resetAllMocks()
    __resetBinaryProbeCacheForTest()
  })

  it('runProbeCommand runs the constant command through the shell with a timeout and trims stdout', async () => {
    mockBounded.mockResolvedValue('  1.2.3\n')
    await expect(runProbeCommand('claude --version', { timeout: 3000 })).resolves.toBe('1.2.3')
    expect(mockBounded).toHaveBeenCalledWith('claude --version', [], expect.objectContaining({ shell: true, timeoutMs: 3000 }))
  })

  it('probeCliBinary: missing on PATH → not installed (and never runs --version)', async () => {
    mockBounded.mockRejectedValue(new Error('not found'))
    await expect(probeCliBinary('kimi', { versionTimeoutMs: 3000 })).resolves.toEqual({ installed: false, executable: false })
    expect(mockBounded).toHaveBeenCalledTimes(1)
    expect(mockBounded).toHaveBeenCalledWith(`${whichCmd} kimi`, [], expect.objectContaining({ timeoutMs: WHICH_TIMEOUT_MS }))
  })

  it('probeCliBinary: installed but --version fails/times out → not executable', async () => {
    mockBounded.mockResolvedValueOnce('/usr/bin/gemini').mockRejectedValueOnce(new Error('timed out'))
    await expect(probeCliBinary('gemini', { versionTimeoutMs: 8000 })).resolves.toEqual({ installed: true, executable: false })
    expect(mockBounded).toHaveBeenLastCalledWith('gemini --version', [], expect.objectContaining({ timeoutMs: 8000 }))
  })

  it('probeCliBinary: executable → version output, and warms the binaryOnPath memo', async () => {
    mockBounded.mockResolvedValueOnce('/usr/bin/codex').mockResolvedValueOnce('codex-cli 0.130.0\n')
    await expect(probeCliBinary('codex', { versionTimeoutMs: 3000 })).resolves.toEqual({ installed: true, executable: true, versionOutput: 'codex-cli 0.130.0' })
    // The sync spawn-time gate reuses the answer instead of blocking on `which`.
    expect(binaryOnPath('codex')).toBe(true)
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('probeCliBinary passes the caller env (Windows SystemRoot backfill) to both probes', async () => {
    const env = { PATH: '/x', SystemRoot: 'C:\\Windows' }
    mockBounded.mockResolvedValue('ok')
    await probeCliBinary('kimi', { versionTimeoutMs: 3000, env })
    for (const call of mockBounded.mock.calls) expect(call[2]).toMatchObject({ env })
  })

  it('binaryOnPathAsync shares the memo and caches negatives', async () => {
    mockBounded.mockRejectedValue(new Error('not found'))
    expect(await binaryOnPathAsync('claude')).toBe(false)
    expect(await binaryOnPathAsync('claude')).toBe(false)
    expect(binaryOnPath('claude')).toBe(false)
    expect(mockBounded).toHaveBeenCalledTimes(1)
    expect(mockExecSync).not.toHaveBeenCalled()
    expect(await binaryOnPathAsync(process.execPath)).toBe(true)
  })
})
