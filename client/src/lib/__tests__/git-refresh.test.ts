import { describe, expect, it, vi } from 'vitest'
import { notifyGitChanged, subscribeGitChanged } from '../git-refresh'

describe('git-refresh bus', () => {
  it('delivers the projectId to subscribers and stops after unsubscribe', () => {
    const seen: string[] = []
    const unsubscribe = subscribeGitChanged((projectId) => seen.push(projectId))

    notifyGitChanged('p1')
    notifyGitChanged('p2')
    expect(seen).toEqual(['p1', 'p2'])

    unsubscribe()
    notifyGitChanged('p3')
    expect(seen).toEqual(['p1', 'p2'])
  })

  it('supports multiple independent subscribers', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeGitChanged(a)
    const offB = subscribeGitChanged(b)

    notifyGitChanged('p1')
    expect(a).toHaveBeenCalledWith('p1')
    expect(b).toHaveBeenCalledWith('p1')

    offA()
    notifyGitChanged('p2')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    offB()
  })

  it('ignores malformed events without a string projectId', () => {
    const cb = vi.fn()
    const off = subscribeGitChanged(cb)
    window.dispatchEvent(new CustomEvent('specrails:git-changed', { detail: {} }))
    window.dispatchEvent(new CustomEvent('specrails:git-changed', { detail: { projectId: 42 } }))
    window.dispatchEvent(new CustomEvent('specrails:git-changed'))
    expect(cb).not.toHaveBeenCalled()
    off()
  })
})
