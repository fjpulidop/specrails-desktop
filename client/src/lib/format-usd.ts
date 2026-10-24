import i18n from 'i18next'

const formatters = new Map<string, Intl.NumberFormat>()

function formatterFor(lang: string, maximumFractionDigits: number): Intl.NumberFormat {
  const key = `${lang}|${maximumFractionDigits}`
  let f = formatters.get(key)
  if (!f) {
    try {
      f = new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD', maximumFractionDigits })
    } catch {
      f = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', maximumFractionDigits })
    }
    formatters.set(key, f)
  }
  return f
}

/**
 * Locale-aware USD amount. Sub-cent values keep four fraction digits so a
 * cheap invocation never collapses to "$0.00"; everything else uses two.
 * `lang` defaults to the active UI language.
 */
export function formatUsd(v: number, lang?: string): string {
  const language = lang || i18n.language || 'en'
  const abs = Math.abs(v)
  return formatterFor(language, abs > 0 && abs < 0.01 ? 4 : 2).format(v)
}
