import { beforeEach, describe, expect, it } from 'vitest'
import { readLastTierLevel, saveLastTierLevel } from '../agent-chat-storage'

describe('mission permission level default', () => {
  beforeEach(() => { localStorage.clear() })

  it('starts Autonomous until the person picks a level, then keeps their pick', () => {
    expect(readLastTierLevel()).toBe(3)
    saveLastTierLevel(1)
    expect(readLastTierLevel()).toBe(1)
  })

  it('falls back to Autonomous on a corrupt stored value', () => {
    localStorage.setItem('specrails-desktop:agent-tier-last', 'x')
    expect(readLastTierLevel()).toBe(3)
  })
})
