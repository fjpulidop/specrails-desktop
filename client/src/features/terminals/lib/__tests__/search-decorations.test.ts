import { describe, it, expect } from 'vitest'
import { searchDecorations, toHexColor } from '../search-decorations'
import { THEMES } from '../../../settings/lib/themes'

describe('toHexColor', () => {
  it('normalises hex and hsl to #rrggbb', () => {
    expect(toHexColor('#ABC')).toBe('#aabbcc')
    expect(toHexColor('#bd93f9')).toBe('#bd93f9')
    expect(toHexColor('hsl(0 100% 50%)')).toBe('#ff0000')
    expect(toHexColor('hsl(120, 100%, 25%)')).toBe('#008000')
    expect(toHexColor('var(--x)')).toBeNull()
  })
})

describe('searchDecorations', () => {
  it('derives valid #RRGGBB colours from every theme palette', () => {
    for (const theme of Object.values(THEMES)) {
      const d = searchDecorations(theme.xterm)
      for (const colour of Object.values(d)) expect(colour).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('falls back to the Dracula defaults without a palette', () => {
    expect(searchDecorations(null).matchBackground).toBe('#bd93f9')
    expect(searchDecorations({ blue: 'nope', magenta: 'nope' }).activeMatchBackground).toBe('#ff79c6')
  })
})
