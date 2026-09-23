import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { getActiveThemeId, getActiveTheme, getStatusColors, getChartPalette } from '../theme-palette'
import { DEFAULT_THEME, THEMES } from '../themes'

describe('theme-palette', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })

  it('falls back to default when no data-theme attribute is set', () => {
    expect(getActiveThemeId()).toBe(DEFAULT_THEME)
  })

  it('falls back to default when data-theme is invalid', () => {
    document.documentElement.dataset.theme = 'not-a-real-theme'
    expect(getActiveThemeId()).toBe(DEFAULT_THEME)
  })

  it('returns the configured theme id', () => {
    document.documentElement.dataset.theme = 'aurora-light'
    expect(getActiveThemeId()).toBe('aurora-light')
  })

  it('getActiveTheme resolves to the descriptor', () => {
    document.documentElement.dataset.theme = 'obsidian-dark'
    expect(getActiveTheme()).toBe(THEMES['obsidian-dark'])
  })

  it('getStatusColors returns a fresh copy of the status map', () => {
    const a = getStatusColors()
    const b = getStatusColors()
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })

  it('getChartPalette returns the active theme chart palette', () => {
    document.documentElement.dataset.theme = 'aurora-light'
    expect(getChartPalette()).toEqual(THEMES['aurora-light'].chart)
  })

  it('scopes Galaxy transparency CSS without a broad background override', () => {
    const css = readFileSync('src/globals.css', 'utf8')

    expect(css).toContain('[data-theme="galaxy"] [data-agent-mode-surface]')
    expect(css).toContain('[data-theme="galaxy"] .bg-card\\/30')
    expect(css).toContain('[data-theme="galaxy"] [class*="from-card/"]')
    expect(css).toContain('[data-theme="galaxy"] .bg-muted\\/30')
    expect(css).not.toMatch(/\[data-theme="galaxy"\]\s+\.bg-background\s*\{/)
  })
})
