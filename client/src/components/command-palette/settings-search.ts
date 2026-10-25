import { foldText } from '../../features/missions/lib/mission-search'
import { SETTINGS_REGISTRY, type SettingEntry } from '../../features/settings/lib/settings-registry'
import type { TFn } from './palette-actions'

/** A registry entry resolved for the active locale. */
export interface SettingRow {
  kind: 'setting'
  entry: SettingEntry
  label: string
  /** "Desktop settings" or "Project settings". */
  scopeLabel: string
  /** The section's own nav label ("Appearance", "Budget"). */
  sectionLabel: string
  score: number
}

/**
 * Where caps, projection and what-if live is a panel, not a settings block, but
 * people look for it with `/budget`: it is offered as a row that opens the panel.
 */
export interface ActionRow {
  kind: 'action'
  actionId: 'budget.open'
  label: string
  /** Right-hand context ("Project analytics"). */
  scopeLabel: string
  sectionLabel: string
  score: number
}

export type SettingsSearchRow = SettingRow | ActionRow

export const SETTING_LABEL_KEY = (id: string) => `palette.settings.entries.${id}.label`
export const SETTING_KEYWORDS_KEY = (id: string) => `palette.settings.entries.${id}.keywords`
export const BUDGET_ACTION_LABEL_KEY = 'palette.actions.openBudget'
export const BUDGET_ACTION_KEYWORDS_KEY = 'palette.actions.openBudgetKeywords'

/** Scores at or below this count as a strong match for the unscoped Settings group. */
const STRONG_SCORE = 1.5
const STRONG_MIN_CHARS = 3

function keywordsOf(t: TFn, id: string): string[] {
  return t(SETTING_KEYWORDS_KEY(id)).split(',').map((k) => foldText(k.trim())).filter(Boolean)
}

/** 0 label starts with the query · 1 a label word does · 1.5 a keyword does · 2 label contains it · 3 a keyword contains it · null no match. */
function scoreSetting(label: string, keywords: readonly string[], query: string): number | null {
  const q = foldText(query.trim())
  if (!q) return 2
  const l = foldText(label)
  if (l.startsWith(q)) return 0
  if (l.split(/[\s/&·-]+/).some((w) => w.startsWith(q))) return 1
  if (keywords.some((k) => k.startsWith(q) || k.split(/\s+/).some((w) => w.startsWith(q)))) return 1.5
  if (l.includes(q)) return 2
  if (keywords.some((k) => k.includes(q))) return 3
  return null
}

export interface RankSettingsOptions {
  hasProject: boolean
  cap: number
  /** Unscoped use: only strong matches, and only for queries of 3+ characters. */
  strongOnly?: boolean
}

/** The settings matching `query`, best match first, capped. Project settings need an open project. */
export function rankSettings(t: TFn, query: string, { hasProject, cap, strongOnly = false }: RankSettingsOptions): SettingsSearchRow[] {
  const text = query.trim()
  if (strongOnly && [...text].length < STRONG_MIN_CHARS) return []
  const rows: SettingsSearchRow[] = []
  SETTINGS_REGISTRY.forEach((entry, order) => {
    if (entry.scope === 'project' && !hasProject) return
    const label = t(SETTING_LABEL_KEY(entry.id))
    const score = scoreSetting(label, keywordsOf(t, entry.id), text)
    if (score === null) return
    if (strongOnly && score > STRONG_SCORE) return
    rows.push({
      kind: 'setting',
      entry,
      label,
      scopeLabel: t(entry.scope === 'app' ? 'palette.settings.appScope' : 'palette.settings.projectScope'),
      sectionLabel: t(entry.scope === 'app' ? `settings:desktop.nav.${entry.section}` : `settings:projectDialog.nav.${entry.section}`),
      score: score + order / 1000,
    })
  })
  if (hasProject) {
    const label = t(BUDGET_ACTION_LABEL_KEY)
    const score = scoreSetting(label, t(BUDGET_ACTION_KEYWORDS_KEY).split(',').map((k) => foldText(k.trim())).filter(Boolean), text)
    if (score !== null && !(strongOnly && score > STRONG_SCORE)) {
      rows.push({ kind: 'action', actionId: 'budget.open', label, scopeLabel: t('palette.nav.projectAnalytics'), sectionLabel: '', score: score + SETTINGS_REGISTRY.length / 1000 })
    }
  }
  rows.sort((a, b) => a.score - b.score)
  return rows.slice(0, cap)
}
