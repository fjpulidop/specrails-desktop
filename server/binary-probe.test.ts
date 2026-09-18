import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync as mockExecSync } from 'child_process'
import { binaryOnPath, __resetBinaryProbeCacheForTest } from './binary-probe'

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
