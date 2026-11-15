import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'globals.css'), 'utf8')

describe('area chrome', () => {
  it('[spec:app-area-chrome/area-accents-and-surface-layering] defines per-area accents and darkest title bar < centre < sidebars layering', () => {
    for (const area of ['missions', 'specs', 'jobs', 'analytics', 'files', 'loops']) {
      expect(css).toMatch(new RegExp(`\\[data-area="${area}"\\][^{]*\\{ --area-accent:`))
    }
    const depth = (name: string) => Number(new RegExp(`--surface-${name}-depth:\\s*(\\d+)%`).exec(css)?.[1])
    expect(depth('chrome')).toBeGreaterThan(depth('center'))
    expect(depth('center')).toBeGreaterThan(0)
    expect(css).toContain('.surface-chrome')
    // Themes that reuse one hue across areas remap them to distinct accents.
    expect(css).toContain('[data-theme="code-rain"] [data-area="specs"]')
    expect(css).toContain('[data-theme="galaxy"] [data-area="specs"]')
  })
})
