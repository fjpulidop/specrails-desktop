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
    expect(CATALOGS.es.core['choose.other']).toBe('Otra cosa — escríbela')
    expect(CATALOGS.en.core['choose.other']).toBe('Something else — write it')
  })
})
