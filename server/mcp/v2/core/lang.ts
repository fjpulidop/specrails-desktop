import { getDesktopSetting } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import { CATALOGS } from '../i18n/catalog'

/**
 * Language of user-facing v2 text (summary, hold reasons, offer labels,
 * previews, error messages). Machine fields never change with it.
 *
 * Resolution order: the call's `lang`, then the session language (set by the
 * first call that passed one, or `projects(select, lang)`), then the app's
 * `ui_language`, then English.
 */

export const SUPPORTED_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it', 'zh', 'ja'] as const
export type Lang = (typeof SUPPORTED_LANGS)[number]

/** `es-ES` → `es`, `pt_BR` → `pt`, `zh-Hans` → `zh`; null for anything unsupported. */
export function normalizeLang(value: unknown): Lang | null {
  if (typeof value !== 'string') return null
  const base = value.trim().toLowerCase().split(/[-_]/)[0]
  return (SUPPORTED_LANGS as readonly string[]).includes(base) ? base as Lang : null
}

/** App UI language (`desktop_settings.ui_language`), null when the person never chose one. */
export function appLanguage(db: DbInstance | undefined): Lang | null {
  if (!db) return null
  try { return normalizeLang(getDesktopSetting(db, 'ui_language')) } catch { return null }
}

/**
 * The language for this call. A supported explicit `lang` also becomes the
 * session language when the session had none (first call wins; later explicit
 * values apply to their own call only, `projects(select, lang)` re-sets it).
 */
export function resolveLang(input: { explicit?: unknown; session?: { lang?: Lang | null }; db?: DbInstance }): Lang {
  const explicit = normalizeLang(input.explicit)
  if (explicit) {
    if (input.session && !input.session.lang) input.session.lang = explicit
    return explicit
  }
  return input.session?.lang ?? appLanguage(input.db) ?? 'en'
}

export type Params = Record<string, string | number | null | undefined>

function lookup(lang: string, key: string): string | undefined {
  const dot = key.indexOf('.')
  if (dot <= 0) return undefined
  const area = key.slice(0, dot) as keyof (typeof CATALOGS)['en']
  return CATALOGS[lang]?.[area]?.[key.slice(dot + 1)]
}

/** Interpolates `{{name}}` (the client locales' syntax); a missing param stays visible as `{{name}}`. */
export function interpolate(template: string, params: Params = {}): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined || value === null ? match : String(value)
  })
}

/** Message `area.key` in `lang`, falling back to English, then to the key itself. */
export function t(lang: Lang, key: string, params?: Params): string {
  return interpolate(lookup(lang, key) ?? lookup('en', key) ?? key, params)
}

/** True when the key exists in English (the reference catalog). */
export function hasMessage(key: string): boolean {
  return lookup('en', key) !== undefined
}

export type Translate = (key: string, params?: Params) => string

export function translator(lang: Lang): Translate {
  return (key, params) => t(lang, key, params)
}
