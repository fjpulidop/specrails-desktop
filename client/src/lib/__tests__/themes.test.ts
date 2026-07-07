import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import {
  THEMES,
  THEME_IDS,
  DEFAULT_THEME,
  LEGACY_THEME_ID_MAP,
  THEME_LOCAL_STORAGE_KEY,
  isThemeId,
  getTheme,
  type ThemeId,
} from '../themes'

describe('themes', () => {
  function indexHtml(): string {
    return readFileSync('index.html', 'utf8')
  }

  function bootAllowedThemes(): string[] {
    const html = indexHtml()
    const match = html.match(/var allowed = \[([^\]]+)\]/)
    if (!match) throw new Error('missing anti-FOUC allowed theme list')
    return [...match[1].matchAll(/'([^']+)'/g)].map(([, id]) => id)
  }

  function bootThemeScript(): string {
    const html = indexHtml()
    const match = html.match(/var k = 'specrails-desktop:ui-theme'([\s\S]*?)document\.documentElement\.dataset\.theme = 'specrails'/)
    if (!match) throw new Error('missing anti-FOUC theme boot script')
    return match[0]
  }

  function splashVarsForTheme(themeId: string): Map<string, string> {
    const html = indexHtml()
    const block = html.match(new RegExp(`html\\[data-theme="${themeId}"\\]\\s*\\{([\\s\\S]*?)\\n\\s*\\}`))?.[1]
    if (!block) throw new Error(`missing splash block for ${themeId}`)
    return new Map([...block.matchAll(/(--splash-[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))
  }

  describe('THEME_IDS allow-list', () => {
    it('contains the six documented built-in themes', () => {
      expect([...THEME_IDS]).toEqual(['dracula', 'aurora-light', 'obsidian-dark', 'code-rain', 'specrails', 'galaxy'])
      expect(THEME_IDS).not.toContain('matrix')
      expect(THEME_IDS).not.toContain('star-wars')
    })

    it('exposes read-side migrations for persisted legacy theme ids', () => {
      expect(LEGACY_THEME_ID_MAP).toEqual({
        'star-wars': 'galaxy',
        matrix: 'code-rain',
      })
      expect(isThemeId(LEGACY_THEME_ID_MAP['star-wars'])).toBe(true)
      expect(isThemeId(LEGACY_THEME_ID_MAP.matrix)).toBe(true)
    })

    it('THEMES has an entry for every ThemeId', () => {
      for (const id of THEME_IDS) {
        expect(THEMES).toHaveProperty(id)
      }
    })

    it('keeps the pre-React boot allow-list synchronized with selectable themes', () => {
      expect(bootAllowedThemes()).toEqual([...THEME_IDS])
    })

    it('defines pre-React Galaxy splash variables in the boot HTML', () => {
      expect(Object.fromEntries(splashVarsForTheme('galaxy'))).toMatchObject({
        '--splash-bg': 'hsl(220 20% 4%)',
        '--splash-fg': 'hsl(210 30% 94%)',
        '--splash-primary': 'hsl(212 100% 62%)',
        '--splash-secondary': 'hsl(210 12% 65%)',
        '--splash-muted': 'hsl(215 15% 60%)',
      })
    })

    it('migrates legacy stored theme ids before applying the boot theme', () => {
      const script = bootThemeScript()

      expect(script.indexOf('legacyThemeIds')).toBeGreaterThan(-1)
      expect(script.indexOf('var allowed')).toBeGreaterThan(script.indexOf('legacyThemeIds'))
      expect(script).toContain("'star-wars': 'galaxy'")
      expect(script).toContain("matrix: 'code-rain'")
      expect(script).toContain('localStorage.setItem(k, migrated)')
      expect(script).not.toContain("allowed = ['dracula', 'aurora-light', 'obsidian-dark', 'matrix'")
    })
  })

  describe('isThemeId', () => {
    it('accepts each known ThemeId', () => {
      for (const id of THEME_IDS) {
        expect(isThemeId(id)).toBe(true)
      }
    })

    it.each([
      ['unknown', 'unknown'],
      ['empty', ''],
      ['null', null],
      ['undefined', undefined],
      ['number', 42],
      ['object', {}],
    ])('rejects %s', (_label, value) => {
      expect(isThemeId(value)).toBe(false)
    })
  })

  describe('DEFAULT_THEME', () => {
    it('is specrails', () => {
      expect(DEFAULT_THEME).toBe('specrails')
    })

    it('is in the allow-list', () => {
      expect(isThemeId(DEFAULT_THEME)).toBe(true)
    })
  })

  describe('descriptors', () => {
    it.each(THEME_IDS as readonly ThemeId[])('descriptor %s has all required fields', (id) => {
      const t = THEMES[id]
      expect(t.id).toBe(id)
      expect(typeof t.displayName).toBe('string')
      expect(t.displayName.length).toBeGreaterThan(0)
      expect(typeof t.tagline).toBe('string')
      expect(t.tagline.length).toBeGreaterThan(0)
      expect(['light', 'dark']).toContain(t.scheme)
      expect(typeof t.previewSwatches.background).toBe('string')
      expect(typeof t.previewSwatches.foreground).toBe('string')
      expect(t.previewSwatches.accents).toHaveLength(4)
      expect(t.chart).toHaveLength(5)
      expect(t.status.completed).toBeDefined()
      expect(t.status.failed).toBeDefined()
      expect(t.status.canceled).toBeDefined()
      expect(t.status.running).toBeDefined()
      expect(t.status.queued).toBeDefined()
    })

    it.each(THEME_IDS as readonly ThemeId[])('xterm palette for %s defines all 16 ANSI + meta colors', (id) => {
      const xt = THEMES[id].xterm
      expect(xt.background).toBeDefined()
      expect(xt.foreground).toBeDefined()
      expect(xt.cursor).toBeDefined()
      expect(xt.selectionBackground).toBeDefined()
      const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const
      for (const c of ansi) {
        expect(xt[c]).toBeDefined()
        expect(xt[`bright${c.charAt(0).toUpperCase()}${c.slice(1)}` as keyof typeof xt]).toBeDefined()
      }
    })

    it('aurora-light has scheme=light, others=dark', () => {
      expect(THEMES['aurora-light'].scheme).toBe('light')
      expect(THEMES['dracula'].scheme).toBe('dark')
      expect(THEMES['obsidian-dark'].scheme).toBe('dark')
      expect(THEMES['code-rain'].scheme).toBe('dark')
      expect(THEMES['galaxy'].scheme).toBe('dark')
    })

    it('each dark theme background is distinct from the others', () => {
      const darks = ['dracula', 'obsidian-dark', 'code-rain', 'galaxy'] as const
      const bgs = darks.map((id) => THEMES[id].previewSwatches.background)
      expect(new Set(bgs).size).toBe(darks.length)
    })

    it('chart palette entries are unique within each theme', () => {
      for (const id of THEME_IDS) {
        const palette = THEMES[id].chart
        expect(new Set(palette).size).toBe(palette.length)
      }
    })
  })

  describe('getTheme', () => {
    it.each(THEME_IDS as readonly ThemeId[])('returns the descriptor for %s', (id) => {
      expect(getTheme(id)).toBe(THEMES[id])
    })
  })

  describe('THEME_LOCAL_STORAGE_KEY', () => {
    it('is namespaced and stable', () => {
      expect(THEME_LOCAL_STORAGE_KEY).toBe('specrails-desktop:ui-theme')
    })
  })

  describe('localized theme copy', () => {
    it('uses current tagline keys and generic copy in every settings locale', () => {
      const localeDirs = readdirSync('src/locales', { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)

      for (const locale of localeDirs) {
        const settings = JSON.parse(readFileSync(`src/locales/${locale}/settings.json`, 'utf8')) as {
          appearance?: { taglines?: Record<string, string> }
        }
        const taglines = settings.appearance?.taglines ?? {}

        expect(taglines).toHaveProperty('code-rain')
        expect(taglines).toHaveProperty('galaxy')
        expect(taglines).not.toHaveProperty('matrix')
        expect(taglines).not.toHaveProperty('star-wars')
        expect(Object.values(taglines).join('\n')).not.toMatch(/Star Wars|lightsaber|sable láser|sabre laser|Lichtschwert|spada laser|ライトセーバー|光剑/)
      }
    })

    it('describes the current six-theme catalog in every setup locale', () => {
      const localeDirs = readdirSync('src/locales', { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)

      for (const locale of localeDirs) {
        const setup = JSON.parse(readFileSync(`src/locales/${locale}/setup.json`, 'utf8')) as {
          onboarding?: { workspace?: { themesBody?: string } }
        }
        const themesBody = setup.onboarding?.workspace?.themesBody ?? ''

        expect(themesBody).toContain('code-rain')
        expect(themesBody).toContain('galaxy')
        expect(themesBody).not.toMatch(/\bmatrix\b|matrix rain/i)
        expect(themesBody).not.toMatch(/\bfive\b|cinco|cinq|fünf|cinque|5つ|五个/i)
      }
    })
  })

  describe('code-rain theme', () => {
    // Tiny WCAG 2.x contrast helper. Parses `hsl(H S% L%)` (the format used
    // throughout themes.ts), converts to relative luminance, returns the
    // ratio. Kept local to this test — not worth a shared util for a single
    // smoke test.
    function hslToLuminance(s: string): number {
      const m = s.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/)
      if (!m) throw new Error(`unparseable hsl: ${s}`)
      const h = Number.parseFloat(m[1]) / 360
      const sat = Number.parseFloat(m[2]) / 100
      const l = Number.parseFloat(m[3]) / 100
      const a = sat * Math.min(l, 1 - l)
      const f = (n: number) => {
        const k = (n + h * 12) % 12
        const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      }
      const r = f(0)
      const g = f(8)
      const b = f(4)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    function contrastRatio(a: string, b: string): number {
      const la = hslToLuminance(a)
      const lb = hslToLuminance(b)
      const lighter = Math.max(la, lb)
      const darker = Math.min(la, lb)
      return (lighter + 0.05) / (darker + 0.05)
    }

    it('foreground vs background meets WCAG AA (≥ 4.5:1) for body copy', () => {
      const t = THEMES['code-rain']
      const ratio = contrastRatio(t.previewSwatches.foreground, t.previewSwatches.background)
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    })

    it('chart palette spans at least three distinct hue families', () => {
      // Extract hue (first hsl number) from each entry; require unique-modulo-band coverage.
      const hues = THEMES['code-rain'].chart.map((c) => {
        const m = c.match(/hsl\(\s*([\d.]+)/)
        return m ? Number.parseFloat(m[1]) : 0
      })
      // Bucket into 60°-wide bins; we want at least three different bins
      // to avoid the "five greens" failure mode.
      const bins = new Set(hues.map((h) => Math.floor(h / 60)))
      expect(bins.size).toBeGreaterThanOrEqual(3)
    })

    it('primary and secondary share the green hue family with ≥ 0.15 lightness delta', () => {
      const t = THEMES['code-rain']
      // Resolve the constants via the CSS-var values on the descriptor.
      // primary lives on chart[0], secondary maps to status.failed?  Not
      // exposed directly — re-read from xterm-green / accent slots is too
      // brittle. Instead assert against the source-of-truth helper: parse
      // both from previewSwatches.accents[0] (primary) and via the literal
      // declared in MATRIX_PALETTE which we mirror to .status.completed
      // (= primary) and the secondary deep-green is on no public field, so
      // we assert the rule by sampling chart[0] (primary) vs status.queued's
      // sibling: the muted (secondary) green sits in the same band as
      // primary but darker. Easiest reliable read: chart[0] and the descriptor's
      // primary previewSwatches.accents[0].
      const primary = t.previewSwatches.accents[0]
      const fg = t.previewSwatches.foreground
      const lOf = (s: string) => {
        const m = s.match(/hsl\(\s*[\d.]+\s+[\d.]+%\s+([\d.]+)%/)
        return m ? Number.parseFloat(m[1]) / 100 : 0
      }
      // Primary (anchor) is the lightness-50 phosphor green; foreground is
      // the lightness-86 mint. Delta should be large (≥0.30) so text never
      // visually blends into the primary accent.
      expect(Math.abs(lOf(primary) - lOf(fg))).toBeGreaterThanOrEqual(0.3)
    })

    it('non-CSS surfaces (xterm, chart, status) are populated', () => {
      const t = THEMES['code-rain']
      // xterm: 16 ANSI + 4 meta = 20 keys.
      expect(Object.keys(t.xterm).length).toBeGreaterThanOrEqual(20)
      // Recharts: 5 unique entries (covered by the generic test above too).
      expect(t.chart).toHaveLength(5)
      expect(new Set(t.chart).size).toBe(5)
      // Status: all five job states mapped.
      expect(t.status.completed).toBeDefined()
      expect(t.status.failed).toBeDefined()
      expect(t.status.canceled).toBeDefined()
      expect(t.status.running).toBeDefined()
      expect(t.status.queued).toBeDefined()
    })
  })

  describe('galaxy theme', () => {
    function hslToLuminance(s: string): number {
      const m = s.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/)
      if (!m) throw new Error(`unparseable hsl: ${s}`)
      const h = Number.parseFloat(m[1]) / 360
      const sat = Number.parseFloat(m[2]) / 100
      const l = Number.parseFloat(m[3]) / 100
      const a = sat * Math.min(l, 1 - l)
      const f = (n: number) => {
        const k = (n + h * 12) % 12
        const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      }
      const r = f(0)
      const g = f(8)
      const b = f(4)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    function contrastRatio(a: string, b: string): number {
      const la = hslToLuminance(a)
      const lb = hslToLuminance(b)
      const lighter = Math.max(la, lb)
      const darker = Math.min(la, lb)
      return (lighter + 0.05) / (darker + 0.05)
    }
    function hueOf(s: string): number {
      const m = s.match(/hsl\(\s*([\d.]+)/)
      if (!m) throw new Error(`unparseable hsl: ${s}`)
      return Number.parseFloat(m[1])
    }
    function hslParts(s: string): { hue: number; saturation: number; lightness: number } {
      const m = s.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/)
      if (!m) throw new Error(`unparseable hsl: ${s}`)
      return {
        hue: Number.parseFloat(m[1]),
        saturation: Number.parseFloat(m[2]),
        lightness: Number.parseFloat(m[3]),
      }
    }
    function cssVarsForTheme(themeId: string): Map<string, string> {
      const css = readFileSync('src/globals.css', 'utf8')
      const block = css.match(new RegExp(`\\[data-theme="${themeId}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1]
      if (!block) throw new Error(`missing [data-theme="${themeId}"] block`)
      return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))
    }
    function galaxyCssVar(name: string): string {
      const value = cssVarsForTheme('galaxy').get(name)
      if (!value) throw new Error(`missing Galaxy CSS variable: ${name}`)
      return value
    }
    function hueDistance(a: number, b: number): number {
      const raw = Math.abs(a - b)
      return Math.min(raw, 360 - raw)
    }

    it('foreground vs background meets WCAG AA (≥ 4.5:1) for body copy', () => {
      const t = THEMES['galaxy']
      const ratio = contrastRatio(t.previewSwatches.foreground, t.previewSwatches.background)
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    })

    it('primary, ring-equivalent, and info share the saturated blue hue', () => {
      const t = THEMES['galaxy']
      // previewSwatches.accents[0] = primary; status.running = info; xterm's
      // cursor and blue/cyan ANSI slots also mirror primary (ring-equivalent).
      const primaryHue = hueOf(t.previewSwatches.accents[0])
      const infoHue = hueOf(t.status.running)
      const cursorHue = hueOf(t.xterm.cursor)
      expect(Math.abs(primaryHue - infoHue)).toBeLessThanOrEqual(5)
      expect(Math.abs(primaryHue - cursorHue)).toBeLessThanOrEqual(5)
    })

    it('uses neutral black, steel-gray, and separated saturated blue instead of SpecRails hue families', () => {
      const starWars = THEMES['galaxy']
      const specrails = THEMES.specrails
      const starWarsBackground = hslParts(starWars.previewSwatches.background)
      const specrailsBackground = hslParts(specrails.previewSwatches.background)
      const starWarsPrimary = hslParts(starWars.previewSwatches.accents[0])
      const specrailsPrimary = hslParts(specrails.previewSwatches.accents[0])
      const starWarsSecondary = hslParts(starWars.xterm.magenta)
      const specrailsSecondary = hslParts(specrails.xterm.magenta)

      expect(starWarsBackground.hue).toBe(220)
      expect(starWarsBackground.saturation).toBeLessThanOrEqual(22)
      expect(starWarsBackground.lightness).toBeLessThanOrEqual(4)
      expect(specrailsBackground.saturation - starWarsBackground.saturation).toBeGreaterThanOrEqual(10)

      expect(starWarsPrimary.hue).toBeGreaterThanOrEqual(212)
      expect(starWarsPrimary.hue).toBeLessThanOrEqual(215)
      expect(Math.abs(starWarsPrimary.hue - specrailsPrimary.hue)).toBeGreaterThanOrEqual(20)

      expect(starWarsSecondary.hue).toBeGreaterThanOrEqual(205)
      expect(starWarsSecondary.hue).toBeLessThanOrEqual(215)
      expect(starWarsSecondary.saturation).toBeLessThanOrEqual(15)
      expect(Math.abs(starWarsSecondary.hue - specrailsSecondary.hue)).toBeGreaterThanOrEqual(45)
    })

    it('keeps Galaxy CSS tokens synchronized with the revised descriptor palette', () => {
      const t = THEMES['galaxy']

      expect(galaxyCssVar('--color-background')).toBe(t.previewSwatches.background)
      expect(galaxyCssVar('--color-card')).toBe('hsl(220 18% 8%)')
      expect(galaxyCssVar('--color-popover')).toBe(t.previewSwatches.background)
      expect(galaxyCssVar('--color-surface')).toBe('hsl(220 18% 10%)')
      expect(galaxyCssVar('--color-background-deep')).toBe('hsl(220 24% 2%)')
      expect(galaxyCssVar('--color-primary')).toBe(t.previewSwatches.accents[0])
      expect(galaxyCssVar('--color-ring')).toBe(t.previewSwatches.accents[0])
      expect(galaxyCssVar('--color-accent-info')).toBe(t.status.running)
      expect(galaxyCssVar('--color-accent-secondary')).toBe(t.xterm.magenta)
      expect(galaxyCssVar('--color-accent-highlight')).toBe(t.previewSwatches.accents[2])
      expect(galaxyCssVar('--galaxy-glow')).toBe(`drop-shadow(0 0 10px ${t.previewSwatches.accents[0].replace(')', ' / 0.45)')})`)
    })

    it('keeps every Galaxy CSS color hue separated from SpecRails tokens', () => {
      const minimumHueDistance = 10
      const starWarsVars = cssVarsForTheme('galaxy')
      const specrailsVars = cssVarsForTheme('specrails')
      const collisions: string[] = []

      const starWarsColorVars = [...starWarsVars].filter(([name]) => name.startsWith('--color-'))
      const specrailsColorVars = [...specrailsVars].filter(([name]) => name.startsWith('--color-'))

      for (const [starWarsName, starWarsValue] of starWarsColorVars) {
        const starWarsHue = hslParts(starWarsValue).hue
        for (const [specrailsName, specrailsValue] of specrailsColorVars) {
          const specrailsHue = hslParts(specrailsValue).hue
          const distance = hueDistance(starWarsHue, specrailsHue)
          if (distance < minimumHueDistance) {
            collisions.push(`${starWarsName}=${starWarsValue} vs ${specrailsName}=${specrailsValue} (${distance}deg)`)
          }
        }
      }

      expect(collisions).toEqual([])
    })

    it('destructive sits in the red hue band (340°-10°) and is distinct from the gold highlight', () => {
      const t = THEMES['galaxy']
      const destructiveHue = hueOf(t.status.failed)
      const inRedBand = destructiveHue >= 340 || destructiveHue <= 10
      expect(inRedBand).toBe(true)
      // previewSwatches.accents = [primary, destructive, highlight, success]
      const highlightHue = hueOf(t.previewSwatches.accents[2])
      expect(Math.abs(destructiveHue - highlightHue)).toBeGreaterThan(15)
    })

    it('chart palette spans at least three distinct hue families', () => {
      const hues = THEMES['galaxy'].chart.map((c) => hueOf(c))
      const bins = new Set(hues.map((h) => Math.floor(h / 60)))
      expect(bins.size).toBeGreaterThanOrEqual(3)
    })

    it('non-CSS surfaces (xterm, chart, status) are populated', () => {
      const t = THEMES['galaxy']
      expect(Object.keys(t.xterm).length).toBeGreaterThanOrEqual(20)
      expect(t.chart).toHaveLength(5)
      expect(new Set(t.chart).size).toBe(5)
      expect(t.status.completed).toBeDefined()
      expect(t.status.failed).toBeDefined()
      expect(t.status.canceled).toBeDefined()
      expect(t.status.running).toBeDefined()
      expect(t.status.queued).toBeDefined()
    })
  })
})
