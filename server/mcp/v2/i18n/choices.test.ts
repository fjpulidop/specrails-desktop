import { describe, expect, it } from 'vitest'
import { CATALOGS, I18N_AREAS } from './catalog'
import { SUPPORTED_LANGS } from '../core/lang'

// Offers are human choices: every `offer.*` label has a `choice.*` effect ("what happens if you pick this")
// in all eight languages; labels stay short enough for a menu line or a form option.

const CJK = new Set(['zh', 'ja'])
const words = (text: string) => text.replace(/\{\{[^}]*\}\}/g, 'X').trim().split(/\s+/).length
const width = (text: string) => [...text.replace(/\{\{[^}]*\}\}/g, 'X').replace(/\s+/g, '')].length

describe('offer labels and effects', () => {
  for (const lang of SUPPORTED_LANGS) {
    it(`${lang}: every offer has a short label and a one-line effect`, () => {
      const problems: string[] = []
      for (const area of I18N_AREAS) {
        const catalog = CATALOGS[lang]?.[area] ?? {}
        const english = CATALOGS.en[area] ?? {}
        for (const key of Object.keys(english).filter((k) => k.startsWith('offer.'))) {
          const label = catalog[key]
          const effect = catalog[`choice.${key.slice('offer.'.length)}`]
          if (!label) problems.push(`${area}.${key}: no label`)
          else if (CJK.has(lang) ? width(label) > 16 : words(label) > 5) problems.push(`${area}.${key}: label too long "${label}"`)
          if (!effect) problems.push(`${area}.${key}: no effect`)
          else if (/\n/.test(effect) || effect.length > 90) problems.push(`${area}.choice.${key.slice(6)}: effect not one short line "${effect}"`)
        }
        // No orphan effects.
        for (const key of Object.keys(catalog).filter((k) => k.startsWith('choice.'))) if (!(`offer.${key.slice(7)}` in english)) problems.push(`${area}.${key}: no offer`)
      }
      expect(problems).toEqual([])
    })
  }

  it('words the free-text option in every language', () => {
    for (const lang of SUPPORTED_LANGS) {
      for (const key of ['choose.other', 'choose.ask', 'choose.menu', 'choose.declined', 'choose.wrote', 'choose.field', 'choose.recommended']) expect(CATALOGS[lang]?.core?.[key], `${lang} ${key}`).toBeTruthy()
    }
    expect(CATALOGS.es.core['choose.other']).toBe('Otra cosa — escríbelo')
    expect(CATALOGS.en.core['choose.other']).toBe('Something else — write it')
  })

  // The person reads these words in their own language: an English phrase left in one ("Something else — escríbelo")
  // is the bug this guards against. Menu strings: the free-text items, the numbered yes/no menus of a confirmation,
  // the menu rule, and every offer label and effect.
  const ENGLISH_MENU_WORDS = /something else|write it|write why|write your|describe the changes|your own|go ahead|leave it|recommended|\bother\b|\bpick\b|\bchoose\b/i
  const isMenuKey = (area: string, key: string) => (area === 'core' && /^(choose\.|confirm\.(required|declined|stale|replayed|expired|mismatch|malformed))/.test(key)) || /^(offer|choice)\./.test(key)
  for (const lang of SUPPORTED_LANGS.filter((l) => l !== 'en')) {
    it(`${lang}: no menu string mixes in English, and every numbered menu ends with the same free-text item`, () => {
      const problems: string[] = []
      const other = CATALOGS[lang].core['choose.other']
      for (const area of I18N_AREAS) {
        const catalog = CATALOGS[lang]?.[area] ?? {}
        for (const [key, value] of Object.entries(catalog)) {
          if (!isMenuKey(area, key)) continue
          const words = value.replace(/\{\{[^}]*\}\}/g, '').replace(/\b(data\.choices|preview\.effect|resend|confirmToken)\b/g, '')
          const english = words.match(ENGLISH_MENU_WORDS)
          if (english) problems.push(`${area}.${key}: English "${english[0]}" in "${value}"`)
        }
      }
      for (const key of ['confirm.required', 'confirm.declined']) {
        const value = CATALOGS[lang].core[key]
        if (/\b3\. /.test(value) && !value.includes(`3. ${other}`)) problems.push(`core.${key}: its menu's last item is not "${other}"`)
      }
      if (!CATALOGS[lang].core['choose.menu'].includes(other)) problems.push(`core.choose.menu does not name "${other}"`)
      for (const key of ['choose.other_reject', 'choose.other_changes', 'choose.other_message']) {
        const head = other.split(/[—（(]/)[0].trim()
        if (!CATALOGS[lang].core[key].startsWith(head)) problems.push(`core.${key}: starts differently from "${head}"`)
      }
      expect(problems).toEqual([])
    })
  }
})
