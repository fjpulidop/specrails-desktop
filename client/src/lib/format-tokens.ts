import i18n from 'i18next'

const formatters = new Map<string, Intl.NumberFormat>()

function formatterFor(lang: string): Intl.NumberFormat {
  let f = formatters.get(lang)
  if (!f) {
    try {
      f = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 })
    } catch {
      f = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
    }
    formatters.set(lang, f)
  }
  return f
}

/**
 * Locale-aware compact token count ("5.4M", "5,4 M", "540万"). One formatter for every
 * surface, so a figure never reads "5424.9k" in one card and "5.4M" in another.
 * `lang` defaults to the active UI language.
 */
export function formatTokens(value: number, lang?: string): string {
  return formatterFor(lang || i18n.language || 'en').format(value)
}
