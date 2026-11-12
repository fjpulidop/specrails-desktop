import { describe, it, expect } from 'vitest'
import { LANGUAGE_IDS, DEFAULT_LANGUAGE } from '../i18n'

/**
 * Key-parity guard: every non-English locale must mirror the English
 * namespaces and key tree exactly. A missing file or key here means a raw
 * fallback-to-English string in that language — caught at test time instead
 * of by a user.
 *
 * Adding a language: create `locales/<id>/<ns>.json` for every namespace in
 * `locales/en/` with the same key structure. This test enforces it.
 */

const allModules = import.meta.glob('../../locales/*/*.json', { eager: true }) as Record<
  string,
  { default: Record<string, unknown> }
>

interface LocaleFile {
  lang: string
  ns: string
  data: Record<string, unknown>
}

const files: LocaleFile[] = Object.entries(allModules).map(([path, mod]) => {
  const parts = path.split('/')
  return {
    lang: parts[parts.length - 2],
    ns: parts[parts.length - 1].replace(/\.json$/, ''),
    data: mod.default,
  }
})

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flattenKeys(v as Record<string, unknown>, full))
    } else {
      keys.push(full)
    }
  }
  return keys.sort()
}

const enFiles = files.filter((f) => f.lang === DEFAULT_LANGUAGE)
const otherLangs = LANGUAGE_IDS.filter((id) => id !== DEFAULT_LANGUAGE)
const presentLangs = otherLangs.filter((id) => files.some((f) => f.lang === id))

describe('locale key parity', () => {
  it('has at least the common namespace in English', () => {
    expect(enFiles.map((f) => f.ns)).toContain('common')
  })

  it('contains no locale directories outside the supported language list', () => {
    const known = new Set<string>(LANGUAGE_IDS)
    for (const f of files) {
      expect(known.has(f.lang), `unexpected locale dir: ${f.lang}`).toBe(true)
    }
  })

  // Languages are translated in a follow-up pass; only validate the ones that
  // exist on disk. Once all 8 ship, `presentLangs` covers every non-en id.
  for (const lang of presentLangs) {
    describe(`locale: ${lang}`, () => {
      it('mirrors every English namespace', () => {
        const enNs = enFiles.map((f) => f.ns).sort()
        const langNs = files.filter((f) => f.lang === lang).map((f) => f.ns).sort()
        expect(langNs).toEqual(enNs)
      })

      it('[spec:milestone-launch-chain/milestone-notification-localization-parity] mirrors the English key tree per namespace', () => {
        for (const enFile of enFiles) {
          const counterpart = files.find((f) => f.lang === lang && f.ns === enFile.ns)
          if (!counterpart) continue // namespace mismatch already reported above
          expect(flattenKeys(counterpart.data), `${lang}/${enFile.ns}.json keys`).toEqual(
            flattenKeys(enFile.data)
          )
        }
      })

      it('has no empty string values', () => {
        for (const f of files.filter((x) => x.lang === lang)) {
          const check = (obj: Record<string, unknown>, prefix: string): void => {
            for (const [k, v] of Object.entries(obj)) {
              const full = `${prefix}.${k}`
              if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
                check(v as Record<string, unknown>, full)
              } else {
                expect(typeof v, `${f.ns}:${full} must be a string`).toBe('string')
                expect((v as string).length, `${f.ns}:${full} must not be empty`).toBeGreaterThan(0)
              }
            }
          }
          check(f.data, '')
        }
      })

      it('[spec:milestone-launch-chain/milestone-notification-localization-parity] preserves interpolation placeholders from English', () => {
        const placeholderRe = /\{\{[^}]+\}\}/g
        for (const enFile of enFiles) {
          const counterpart = files.find((f) => f.lang === lang && f.ns === enFile.ns)
          if (!counterpart) continue
          const walk = (en: Record<string, unknown>, other: Record<string, unknown>, prefix: string): void => {
            for (const [k, v] of Object.entries(en)) {
              const full = `${prefix}.${k}`
              const o = other[k]
              if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
                if (o && typeof o === 'object') walk(v as Record<string, unknown>, o as Record<string, unknown>, full)
              } else if (typeof v === 'string' && typeof o === 'string') {
                const enPh = (v.match(placeholderRe) ?? []).sort()
                const otherPh = (o.match(placeholderRe) ?? []).sort()
                expect(otherPh, `${lang}/${enFile.ns}:${full} placeholders`).toEqual(enPh)
              }
            }
          }
          walk(enFile.data, counterpart.data, '')
        }
      })
    })
  }
})
