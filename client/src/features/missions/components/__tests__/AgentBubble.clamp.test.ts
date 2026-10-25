import { describe, it, expect } from 'vitest'
import { clampCorner, CHROME_LEFT, CHROME_TOP } from '../AgentBubble'

describe('AgentBubble clampCorner', () => {
  it('keeps the bubble clear of the sidebar rail and title bar in a narrow window', () => {
    const vw = 800
    const vh = 600
    const c = clampCorner({ right: 9999, bottom: 9999 }, vw, vh)
    const left = vw - 56 - c.right
    const top = vh - 56 - c.bottom
    expect(left).toBeGreaterThanOrEqual(CHROME_LEFT)
    expect(top).toBeGreaterThanOrEqual(CHROME_TOP)
  })

  it('anchors to the bottom-right: shrinking the window preserves the corner offset', () => {
    expect(clampCorner({ right: 16, bottom: 40 }, 1440, 900)).toEqual({ right: 16, bottom: 40 })
    expect(clampCorner({ right: 16, bottom: 40 }, 800, 600)).toEqual({ right: 16, bottom: 40 })
  })

  it('never goes below the minimum margin', () => {
    expect(clampCorner({ right: -50, bottom: 0 }, 800, 600)).toEqual({ right: 12, bottom: 12 })
  })
})
