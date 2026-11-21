import { describe, expect, it } from 'vitest'
import { mapInSlices, replay, settle } from './event-loop-slices'

describe('event-loop slices', () => {
  it('maps in order and yields to the event loop between slices', async () => {
    const order: string[] = []
    setImmediate(() => order.push('other work'))
    const out = await mapInSlices([1, 2, 3], (n) => { order.push(`item ${n}`); return n * 2 }, 0)
    expect(out).toEqual([2, 4, 6])
    // With a zero slice every item after the first runs after a turn of the loop.
    expect(order.indexOf('other work')).toBeGreaterThan(0)
    expect(order.indexOf('other work')).toBeLessThan(order.indexOf('item 3'))
  })

  it('does not yield inside one slice', async () => {
    const order: string[] = []
    setImmediate(() => order.push('other work'))
    await mapInSlices([1, 2, 3], (n) => order.push(`item ${n}`), 10_000)
    expect(order).toEqual(['item 1', 'item 2', 'item 3'])
  })

  it('replays a settled value or its failure', () => {
    expect(replay(settle(() => 7))).toBe(7)
    const failure = settle(() => { throw new Error('locked') })
    expect(() => replay(failure)).toThrow('locked')
  })
})
