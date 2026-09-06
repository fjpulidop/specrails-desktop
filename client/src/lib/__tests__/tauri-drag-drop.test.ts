import { describe, expect, it } from 'vitest'
import { isDropPositionInsideRect } from '../tauri-drag-drop'

const rect = {
  left: 500,
  right: 900,
  top: 400,
  bottom: 800,
} as DOMRect

describe('tauri-drag-drop', () => {
  it('does not mistake physical coordinates outside the terminal for CSS coordinates inside it', () => {
    expect(isDropPositionInsideRect({ x: 650, y: 600 }, rect, 2)).toBe(false)
  })

  it('accepts positions reported in physical pixels', () => {
    expect(isDropPositionInsideRect({ x: 1300, y: 1200 }, rect, 2)).toBe(true)
  })

  it.each([1, 1.25, 1.5, 2])('converts physical coordinates once at display scale %s', (scale) => {
    expect(isDropPositionInsideRect({ x: 600 * scale, y: 500 * scale }, rect, scale)).toBe(true)
    expect(isDropPositionInsideRect({ x: 450 * scale, y: 500 * scale }, rect, scale)).toBe(false)
  })

  it('rejects positions outside the viewport in either coordinate space', () => {
    expect(isDropPositionInsideRect({ x: 100, y: 100 }, rect, 2)).toBe(false)
  })
})
