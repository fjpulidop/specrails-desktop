import { describe, expect, it } from 'vitest'
import { avoidTop } from '../bubble-avoid'

describe('avoidTop', () => {
  const card = { left: 300, right: 1260, top: 700, bottom: 860 }
  it('lifts the bubble just above a docked surface it overlaps', () => {
    expect(avoidTop({ left: 1200, top: 800, size: 56 }, [card], 64)).toBe(700 - 8 - 56)
  })
  it('stays where it is when nothing is under it', () => {
    expect(avoidTop({ left: 100, top: 800, size: 56 }, [card], 64)).toBe(800)
  })
  it('never rises above the chrome', () => {
    expect(avoidTop({ left: 1200, top: 800, size: 56 }, [{ ...card, top: 80 }], 64)).toBe(64)
  })
})
