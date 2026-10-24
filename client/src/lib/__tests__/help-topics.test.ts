import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELP_TOPICS, APP_SETTINGS_HELP, PROJECT_SETTINGS_HELP, type HelpTopicId } from '../help-topics'
import { LANGUAGE_IDS } from '../i18n'
import { APP_SETTINGS_SECTIONS } from '../app-settings-events'
import { PROJECT_SETTINGS_SECTION_IDS } from '../../features/settings/lib/project-settings-section-ids'
import en from '../../locales/en/common.json'

const GUIDE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/guide')

/** `<n>-<slug>.md` whose bare slug matches, in one locale's category folder. */
function guideFile(lang: string, category: string, slug: string): string | null {
  const dir = path.join(GUIDE_ROOT, lang, category)
  if (!fs.existsSync(dir)) return null
  const file = fs.readdirSync(dir).find((name) => name.replace(/^\d+-/, '').replace(/\.md$/, '') === slug)
  return file ? path.join(dir, file) : null
}

/** Explicit anchors (`## Title {#anchor}`) of headings outside code fences. */
function anchorsOf(file: string): string[] {
  const anchors: string[] = []
  let fenced = false
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^```/.test(line)) fenced = !fenced
    if (fenced) continue
    const match = /^#{1,4}\s+.+?\s\{#([a-z0-9][a-z0-9-]*)\}\s*$/.exec(line)
    if (match) anchors.push(match[1])
  }
  return anchors
}

describe('help topics', () => {
  const topics = Object.entries(HELP_TOPICS) as [HelpTopicId, (typeof HELP_TOPICS)[HelpTopicId]][]

  it('covers all 8 locales of the guide', () => {
    expect([...LANGUAGE_IDS].sort()).toEqual(fs.readdirSync(GUIDE_ROOT).sort())
  })

  for (const lang of LANGUAGE_IDS) {
    it(`every topic anchor resolves to a heading in the ${lang} guide`, () => {
      const dead: string[] = []
      for (const [id, target] of topics) {
        const file = guideFile(lang, target.category, target.slug)
        if (!file) { dead.push(`${id}: no page ${lang}/${target.category}/${target.slug}`); continue }
        if (!anchorsOf(file).includes(target.anchor)) dead.push(`${id}: no {#${target.anchor}} in ${path.relative(GUIDE_ROOT, file)}`)
      }
      expect(dead).toEqual([])
    })

    it(`${lang}: an anchor is declared once per page`, () => {
      for (const [, target] of topics) {
        const file = guideFile(lang, target.category, target.slug)
        if (!file) continue
        const anchors = anchorsOf(file)
        expect(anchors.filter((a) => a === target.anchor)).toHaveLength(1)
      }
    })
  }

  it('every topic has a human name for the accessible label', () => {
    const names = (en as { help: { topics: Record<string, string> } }).help.topics
    expect(Object.keys(names).sort()).toEqual(Object.keys(HELP_TOPICS).sort())
  })

  it('settings sections only point at known sections and topics', () => {
    for (const [section, topic] of Object.entries(APP_SETTINGS_HELP)) {
      expect(APP_SETTINGS_SECTIONS as readonly string[]).toContain(section)
      expect(HELP_TOPICS).toHaveProperty(topic)
    }
    for (const [section, topic] of Object.entries(PROJECT_SETTINGS_HELP)) {
      expect(PROJECT_SETTINGS_SECTION_IDS as readonly string[]).toContain(section)
      expect(HELP_TOPICS).toHaveProperty(topic)
    }
  })
})
