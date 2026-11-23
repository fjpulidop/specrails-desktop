import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { CATALOGS, I18N_AREAS } from './catalog'
import { SUPPORTED_LANGS } from '../core/lang'
import sources from './sources.json'

// Server catalogs (v2/i18n/<lang>/<area>.json). Keys whose text the app already
// has come from the client locales (sources.json) and must stay identical in
// all eight languages; run with UPDATE_MCP_I18N=1 to regenerate them.

const root = path.resolve(__dirname, '../../../..')
const here = __dirname
const clientValue = (lang: string, ref: string): string => {
  const [ns, key] = ref.split(':')
  let value: unknown = JSON.parse(fs.readFileSync(path.join(root, 'client/src/locales', lang, `${ns}.json`), 'utf8'))
  for (const part of key.split('.')) value = (value as Record<string, unknown> | undefined)?.[part]
  if (typeof value !== 'string') throw new Error(`client locale ${lang} has no ${ref}`)
  return value
}
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((match) => match[1]).sort()

describe('v2 message catalogs', () => {
  it('has an English file for every area, all statically imported', () => {
    for (const area of I18N_AREAS) {
      expect(fs.existsSync(path.join(here, 'en', `${area}.json`)), area).toBe(true)
      expect(CATALOGS.en[area], area).toBeDefined()
    }
    const onDisk = fs.readdirSync(here, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    expect(onDisk).toEqual([...SUPPORTED_LANGS].sort())
    for (const lang of onDisk) {
      for (const file of fs.readdirSync(path.join(here, lang))) {
        expect(CATALOGS[lang]?.[file.replace(/\.json$/, '') as keyof (typeof CATALOGS)['en']], `${lang}/${file} is not imported in catalog.ts`).toBeDefined()
      }
    }
  })

  it('keeps every translation a subset of English with the same placeholders', () => {
    for (const lang of SUPPORTED_LANGS) {
      for (const [area, messages] of Object.entries(CATALOGS[lang] ?? {})) {
        const english = CATALOGS.en[area as keyof (typeof CATALOGS)['en']] ?? {}
        for (const [key, text] of Object.entries(messages ?? {})) {
          expect(english[key], `${lang}/${area}.${key} has no English key`).toBeDefined()
          expect(placeholders(text), `${lang}/${area}.${key}`).toEqual(placeholders(english[key]))
        }
      }
    }
  })

  it('stays in sync with the client locales for the keys it reuses', () => {
    const update = process.env.UPDATE_MCP_I18N === '1'
    for (const [area, keys] of Object.entries(sources).filter(([name]) => name !== '//')) {
      for (const lang of SUPPORTED_LANGS) {
        const file = path.join(here, lang, `${area}.json`)
        const current: Record<string, string> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
        const expected = { ...current }
        for (const [key, ref] of Object.entries(keys as Record<string, string>)) expected[key] = clientValue(lang, ref)
        if (update) fs.writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`)
        else expect(current, `${lang}/${area}.json drifted from client/src/locales; run UPDATE_MCP_I18N=1`).toEqual(expected)
      }
    }
  })

  it('defines every core.* key the v2 sources reference', () => {
    const files = ['core', 'tools'].flatMap((dir) => fs.readdirSync(path.join(here, '..', dir)).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts')).map((file) => path.join(here, '..', dir, file)))
    const keys = new Set(files.flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/'core\.([a-z_]+(?:\.[a-z_-]+)+)'/gi)].map((match) => match[1])))
    expect(keys.size).toBeGreaterThan(20)
    for (const key of keys) expect(CATALOGS.en.core?.[key], `core.${key}`).toBeDefined()
  })
})
