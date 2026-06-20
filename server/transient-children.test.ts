import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { trackTransientChild, killTransientChildren } from './transient-children'

vi.mock('tree-kill', () => ({ default: vi.fn() }))
import treeKill from 'tree-kill'

function fakeChild(pid: number | undefined): any {
  const ee = new EventEmitter() as any
  ee.pid = pid
  return ee
}

describe('transient-children', () => {
  it('tree-kills tracked children on killTransientChildren', () => {
    const c1 = fakeChild(111)
    const c2 = fakeChild(222)
    trackTransientChild('p1', c1)
    trackTransientChild('p1', c2)
    killTransientChildren('p1')
    expect(treeKill).toHaveBeenCalledWith(111, 'SIGTERM')
    expect(treeKill).toHaveBeenCalledWith(222, 'SIGTERM')
    // forgotten after kill — a second call kills nothing new
    ;(treeKill as any).mockClear()
    killTransientChildren('p1')
    expect(treeKill).not.toHaveBeenCalled()
  })

  it('auto-unregisters a child on close so it is not killed later', () => {
    const c = fakeChild(333)
    trackTransientChild('p2', c)
    c.emit('close')
    ;(treeKill as any).mockClear()
    killTransientChildren('p2')
    expect(treeKill).not.toHaveBeenCalled()
  })

  it('killing an unknown project is a no-op', () => {
    ;(treeKill as any).mockClear()
    killTransientChildren('nope')
    expect(treeKill).not.toHaveBeenCalled()
  })

  it('skips a child with no pid', () => {
    const c = fakeChild(undefined)
    trackTransientChild('p3', c)
    ;(treeKill as any).mockClear()
    killTransientChildren('p3')
    expect(treeKill).not.toHaveBeenCalled()
  })
})
