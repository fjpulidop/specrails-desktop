import { describe, expect, it, vi } from 'vitest'
import { createDockBadge } from '../dock-badge'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Dock badge', () => {
  it('sends only changes; zero and null clear it; large counts are clamped', () => {
    const invoke = vi.fn(async () => undefined)
    const badge = createDockBadge(invoke, () => true)
    badge.set(3)
    badge.set(3)
    badge.set(0)
    badge.set(null)
    badge.set(50_000)
    expect(invoke.mock.calls).toEqual([
      ['desktop_set_badge', { count: 3 }],
      ['desktop_set_badge', { count: null }],
      ['desktop_set_badge', { count: 9_999 }],
    ])
  })

  it('the first value always reaches the host, even a clear (a crash may have left a badge)', () => {
    const invoke = vi.fn(async () => undefined)
    createDockBadge(invoke, () => true).set(0)
    expect(invoke).toHaveBeenCalledWith('desktop_set_badge', { count: null })
  })

  it('a refused update is retried by the next set', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error('no window')).mockResolvedValue(undefined)
    const badge = createDockBadge(invoke, () => true)
    badge.set(2)
    await flush()
    badge.set(2)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('is a no-op outside the desktop app', () => {
    const invoke = vi.fn(async () => undefined)
    createDockBadge(invoke, () => false).set(4)
    expect(invoke).not.toHaveBeenCalled()
  })
})
