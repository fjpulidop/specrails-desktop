import { describe, it, expect } from 'vitest'
import { SCOPE_PREFIX, SCOPE_ROW_CAPS, SEARCH_SCOPES, UNSCOPED_SETTINGS_CAP, detectScope } from '../search-scopes'
import { highlightParts, rangesForQuery, sanitizeRanges } from '../snippet'
import { rankSettings as rankAll, type SettingRow, type SettingsSearchRow } from '../settings-search'
import { SETTINGS_REGISTRY } from '../../../features/settings/lib/settings-registry'
import type { TFn } from '../palette-actions'

// Non-English resources load lazily in the app, so these tests read the locale
// files themselves: a missing key resolves to the key (never to English).
const resources = import.meta.glob('../../../locales/*/{commands,settings}.json', { eager: true }) as Record<string, { default: Record<string, unknown> }>
function tIn(lng: string): TFn {
  return ((key: string) => {
    const [ns, path] = key.includes(':') ? key.split(':') : ['commands', key]
    let node: unknown = resources[`../../../locales/${lng}/${ns}.json`]?.default
    for (const part of path.split('.')) node = (node as Record<string, unknown> | undefined)?.[part]
    return typeof node === 'string' ? node : key
  }) as TFn
}

describe('detectScope', () => {
  it.each([
    ['#12 login', 'specs', '12 login'],
    ['@tetris', 'missions', 'tetris'],
    ['/budget', 'settings', 'budget'],
    ['f:store.ts', 'files', 'store.ts'],
    ['F: src/app', 'files', 'src/app'],
    ['log:  timeout', 'logs', 'timeout'],
    ['LOG:timeout', 'logs', 'timeout'],
    ['?rails', 'docs', 'rails'],
    ['  #7', 'specs', '7'],
  ])('%s -> %s', (value, scope, rest) => {
    expect(detectScope(value)).toEqual({ scope, rest })
  })

  it('does not treat ordinary text, the actions prefix or a bare "f" as a scope', () => {
    for (const value of ['', 'tetris', '>new spec', 'f', 'fix: bug', 'logs', 'a#b']) expect(detectScope(value)).toBeNull()
  })

  it('knows a prefix for every scope and a positive row cap', () => {
    for (const scope of SEARCH_SCOPES) {
      expect(SCOPE_PREFIX[scope]).toBeTruthy()
      expect(SCOPE_ROW_CAPS[scope]).toBeGreaterThan(0)
    }
    expect(UNSCOPED_SETTINGS_CAP).toBeLessThanOrEqual(3)
  })
})

describe('highlight sanitization', () => {
  it('drops ranges that are out of bounds, fractional, empty or malformed and merges overlaps', () => {
    const text = 'hello world'
    expect(sanitizeRanges(text, [[0, 2], [1, 4], [8, 99], [3.5, 5], [5, 5], [-4, 1], [9, 8], ['a', 'b'] as never, [1] as never])).toEqual([[0, 4], [8, 11]])
    expect(sanitizeRanges(text, null)).toEqual([])
    expect(sanitizeRanges(text, 'nope' as never)).toEqual([])
  })

  it('splits text into plain and marked runs and never alters the characters', () => {
    const text = '<img src=x onerror=alert(1)> & friends'
    const parts = highlightParts(text, [[1, 4]])
    expect(parts.map((p) => p.text).join('')).toBe(text)
    expect(parts).toEqual([
      { text: '<', mark: false }, { text: 'img', mark: true }, { text: text.slice(4), mark: false },
    ])
  })

  it('finds a query ignoring case and diacritics, mapping back to the original offsets', () => {
    const text = 'Revisión de la API'
    const [range] = rangesForQuery(text, 'REVISION')
    expect(text.slice(...range)).toBe('Revisión')
    expect(rangesForQuery(text, 'zzz')).toEqual([])
    expect(rangesForQuery(text, '   ')).toEqual([])
  })
})

// Most assertions are about the settings registry; the Budget panel action row has its own tests below.
const isSetting = (row: SettingsSearchRow): row is SettingRow => row.kind === 'setting'
const rankSettings = (...args: Parameters<typeof rankAll>) => rankAll(...args).filter(isSetting)

describe('rankSettings', () => {
  const t = tIn('en')

  it('finds settings by label and by keyword, best match first', () => {
    const rows = rankSettings(t, 'budget', { hasProject: true, cap: 8 })
    expect(rows.map((r) => r.entry.id)).toEqual(expect.arrayContaining(['budgetAlerts', 'projectBudget']))
    expect(rankSettings(t, 'dark', { hasProject: true, cap: 8 })[0].entry.id).toBe('theme')
    expect(rankSettings(t, 'telemetry', { hasProject: true, cap: 8 })[0]).toMatchObject({ scopeLabel: 'Project settings', sectionLabel: 'Telemetry' })
    expect(rankSettings(t, 'language', { hasProject: true, cap: 8 })[0]).toMatchObject({ scopeLabel: 'Desktop settings', sectionLabel: 'Appearance' })
  })

  it('hides project settings when no project is open', () => {
    const rows = rankSettings(t, 'budget', { hasProject: false, cap: 8 })
    expect(rows.every((r) => r.entry.scope === 'app')).toBe(true)
  })

  it('caps the rows and lists the registry when the query is empty', () => {
    expect(rankSettings(t, '', { hasProject: true, cap: 5 })).toHaveLength(5)
    expect(rankSettings(t, 'e', { hasProject: true, cap: 2 })).toHaveLength(2)
  })

  it('unscoped use only returns strong matches of 3+ characters, capped to the small group', () => {
    expect(rankSettings(t, 'th', { hasProject: true, cap: UNSCOPED_SETTINGS_CAP, strongOnly: true })).toEqual([])
    const strong = rankSettings(t, 'webhook', { hasProject: true, cap: UNSCOPED_SETTINGS_CAP, strongOnly: true })
    expect(strong.map((r) => r.entry.id)).toContain('webhooks')
    expect(strong.length).toBeLessThanOrEqual(UNSCOPED_SETTINGS_CAP)
    // "ilter" is only a substring of nothing strong: no noise rows.
    expect(rankSettings(t, 'zzzz', { hasProject: true, cap: 3, strongOnly: true })).toEqual([])
  })

  it.each(['es', 'fr', 'de', 'pt', 'it', 'zh', 'ja'])('has a label and keywords for every registry entry in %s', (lng) => {
    const tl = tIn(lng)
    for (const entry of SETTINGS_REGISTRY) {
      const label = tl(`palette.settings.entries.${entry.id}.label`)
      const keywords = tl(`palette.settings.entries.${entry.id}.keywords`)
      expect(label, `${lng}:${entry.id}.label`).not.toMatch(/^palette\./)
      expect(keywords, `${lng}:${entry.id}.keywords`).not.toMatch(/^palette\./)
      expect(keywords.split(',').filter((k) => k.trim()).length).toBeGreaterThanOrEqual(2)
    }
  })

  it('finds a setting through a localized keyword', () => {
    expect(rankSettings(tIn('es'), 'presupuesto', { hasProject: true, cap: 8 }).map((r) => r.entry.id)).toEqual(expect.arrayContaining(['budgetAlerts', 'projectBudget']))
    expect(rankSettings(tIn('ja'), '予算', { hasProject: true, cap: 8 }).map((r) => r.entry.id)).toContain('projectBudget')
    expect(rankSettings(tIn('zh'), '主题', { hasProject: true, cap: 8 })[0].entry.id).toBe('theme')
  })

  it('also offers the Budget panel action when the query names a cap (/budget, /weekly, /monthly), only with a project', () => {
    for (const q of ['budget', 'weekly', 'monthly', 'cap']) {
      const rows = rankAll(t, q, { hasProject: true, cap: 8 })
      expect(rows.find((r) => r.kind === 'action'), q).toMatchObject({ kind: 'action', actionId: 'budget.open', label: 'Open Budget (caps, projection, what-if)' })
    }
    expect(rankAll(t, 'weekly', { hasProject: false, cap: 8 }).some((r) => r.kind === 'action')).toBe(false)
    expect(rankAll(t, 'webhook', { hasProject: true, cap: 8 }).some((r) => r.kind === 'action')).toBe(false)
  })

  it('finds the Budget panel through the localized keywords (es: límite / semanal)', () => {
    for (const q of ['límite', 'semanal', 'presupuesto']) {
      expect(rankAll(tIn('es'), q, { hasProject: true, cap: 8 }).some((r) => r.kind === 'action'), q).toBe(true)
    }
  })

  it.each(['es', 'fr', 'de', 'pt', 'it', 'zh', 'ja'])('has the Budget panel label and keywords in %s', (lng) => {
    const tl = tIn(lng)
    expect(tl('palette.actions.openBudget')).not.toMatch(/^palette\./)
    const keywords = tl('palette.actions.openBudgetKeywords')
    expect(keywords).not.toMatch(/^palette\./)
    expect(keywords.split(',').length).toBeGreaterThanOrEqual(4)
  })
})
