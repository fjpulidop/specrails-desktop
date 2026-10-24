import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { THEME_IDS } from '../themes'

const css = readFileSync('src/globals.css', 'utf8')

function vars(themeId: string): Map<string, string> {
  const re = themeId === 'dracula' ? /@theme\s*\{([\s\S]*?)\n\}/ : new RegExp(`\\[data-theme="${themeId}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`)
  const block = css.match(re)?.[1]
  if (!block) throw new Error(`missing block for ${themeId}`)
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, n, v]) => [n, v.trim()]))
}
function hsl(s: string): [number, number, number] {
  const m = s.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/)
  if (!m) throw new Error(`unparseable: ${s}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}
function lum(s: string): number {
  const [h, sat, l] = hsl(s).map((v, i) => (i === 0 ? v : v / 100)) as [number, number, number]
  const a = sat * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(0) + 0.7152 * f(8) + 0.0722 * f(4)
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

describe('review lamp token', () => {
  for (const id of THEME_IDS) {
    it(`${id}: hue is ≥60° from primary and ≥40° from secondary, text contrast ≥4.5 on card`, () => {
      const v = vars(id)
      const review = v.get('--color-accent-review')!
      expect(dist(hsl(review)[0], hsl(v.get('--color-primary')!)[0])).toBeGreaterThanOrEqual(60)
      expect(dist(hsl(review)[0], hsl(v.get('--color-accent-secondary')!)[0])).toBeGreaterThanOrEqual(40)
      expect(contrast(review, v.get('--color-card')!)).toBeGreaterThanOrEqual(4.5)
    })
  }
})
