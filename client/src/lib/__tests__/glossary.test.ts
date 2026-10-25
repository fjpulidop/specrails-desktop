/**
 * Glossary guard (reaudit-8 #1). One name per object, per locale:
 *   Spanish: Tablero (not Dashboard/Panel), Trabajos (not Jobs), spec (not ticket), ejecución (not run).
 *   English: "spec" (never "ticket") for the unit of work; Jira issues keep "ticket" (the jira namespace).
 * The guard scans every translated value, ignoring `{{placeholders}}`, markup tags and the search-alias
 * lists (`*Keywords`, `verbs`), which intentionally carry the old terms so muscle memory keeps matching.
 * Exceptions live in the explicit allowlists below, each with the reason.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const LOCALES_DIR = path.resolve(__dirname, '../../locales')

function flatten(obj: unknown, prefix: string[] = [], out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof obj === 'string') out.push([prefix.join('.'), obj])
  else if (Array.isArray(obj)) obj.forEach((v, i) => flatten(v, [...prefix, String(i)], out))
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) flatten(v, [...prefix, k], out)
  return out
}

function values(lang: string): Array<{ id: string; ns: string; text: string }> {
  const dir = path.join(LOCALES_DIR, lang)
  const rows: Array<{ id: string; ns: string; text: string }> = []
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const ns = file.replace(/\.json$/, '')
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    for (const [key, raw] of flatten(data)) {
      if (/(^|\.)(verbs|[A-Za-z]*[kK]eywords)(\.|$)/.test(key)) continue
      const text = raw.replace(/\{\{[^}]*\}\}/g, '').replace(/<[^>]+>/g, '')
      rows.push({ id: `${ns}:${key}`, ns, text })
    }
  }
  return rows
}

function offenders(lang: string, re: RegExp, allow: (row: { id: string; ns: string }) => boolean): string[] {
  return values(lang).filter((r) => !allow(r) && re.test(r.text)).map((r) => `${r.id} => ${r.text.slice(0, 90)}`)
}

/** Jira issues are genuinely "tickets" in every language: the whole jira namespace and the Jira-key sort mode. */
const JIRA_TICKET = (r: { id: string; ns: string }) => r.ns === 'jira' || r.id === 'specs:sortControl.modes.jiraKey'

describe('glossary: Spanish', () => {
  it('uses Tablero / Trabajos / spec / ejecución, never Dashboard, job, ticket or run', () => {
    const outsideJira = offenders('es', /\b(dashboard|jobs?|tickets?|runs?)\b/i, JIRA_TICKET)
    const insideJira = offenders('es', /\b(dashboard|jobs?|runs?)\b/i, (r) => !JIRA_TICKET(r))
    expect([...outsideJira, ...insideJira]).toEqual([])
  })

  it('does not name the board "Panel" in the navigation labels', () => {
    const bad = offenders('es', /^Panel$/, () => false)
    expect(bad).toEqual([])
  })

  it('keeps the canonical destination names', async () => {
    const nav = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'es/nav.json'), 'utf8'))
    const commands = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'es/commands.json'), 'utf8'))
    expect(nav.places.routes.dashboard).toBe('Tablero')
    expect(nav.rightSidebar.dashboard).toBe('Tablero')
    expect(nav.rightSidebar.jobs).toBe('Trabajos')
    expect(commands.palette.nav.dashboard).toBe('Tablero')
    expect(commands.palette.groups.jobs).toBe('Trabajos')
  })
})

describe('glossary: English', () => {
  it('says spec, not ticket, outside Jira', () => {
    expect(offenders('en', /\btickets?\b/i, JIRA_TICKET)).toEqual([])
  })
})

describe('glossary: one word per concept (reaudit-9 #9)', () => {
  it('English names the spend ceiling a "limit" and a unit of work a "run": never "cap" or "execution"', () => {
    expect(offenders('en', /\b(caps?|executions?)\b/i, () => false)).toEqual([])
  })

  for (const lang of ['en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja']) {
    it(`${lang}: "ticket" appears only for Jira issues, in every translated value`, () => {
      expect(offenders(lang, /\bticket|工单|チケット/i, (r) => JIRA_TICKET(r) || /jira/i.test(r.id + r.text))).toEqual([])
    })
  }

  it('Spanish writes "specs", not "especificaciones", and the deleted flag agrees with its noun', () => {
    expect(offenders('es', /\bespecificaci[oó]n(es)?\b/i, () => false)).toEqual([])
    const analytics = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'es/analytics.json'), 'utf8'))
    expect(analytics.table.deleted).toBe('(eliminada)')
  })
})

describe('glossary: other locales keep the spec noun where they translated it', () => {
  for (const lang of ['fr', 'de', 'it', 'pt', 'zh', 'ja']) {
    it(`${lang}: the spec-list empty state no longer says ticket`, () => {
      const specs = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, lang, 'specs.json'), 'utf8'))
      const text = [...flatten(specs.emptyState), ...flatten(specs.listView), ...flatten(specs.card)].map(([, v]) => v).join(' ')
      expect(text).not.toMatch(/ticket|工单|チケット/i)
    })
  }
})

describe('glossary: guide pages', () => {
  const GUIDE = path.resolve(__dirname, '../../../../docs/guide')
  function pages(lang: string, dir = path.join(GUIDE, lang), out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) pages(lang, full, out)
      else if (entry.name.endsWith('.md')) out.push(full)
    }
    return out
  }
  /** Prose only: code spans, link targets, URLs, tags and Jira tickets are exempt. */
  const prose = (line: string) => line.replace(/`[^`\n]*`|\]\([^)]*\)|https?:\/\/\S+|<[^>\n]+>|\{\{[^}]*\}\}|\b[Tt]icket(s)? (de )?Jira|\bJira[- ](ticket|issue)s?/g, '')

  it('the Spanish pages say Tablero / Trabajos / spec / ejecución', () => {
    const bad: string[] = []
    for (const file of pages('es')) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const m = /\b(dashboard|jobs?|tickets?|runs?)\b/i.exec(prose(line))
        if (m) bad.push(`${path.relative(GUIDE, file)}:${i + 1} ${m[0]}`)
      })
    }
    expect(bad).toEqual([])
  })

  it('the English pages say spec, not ticket, outside Jira', () => {
    const bad: string[] = []
    for (const file of pages('en')) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const m = /\btickets?\b/i.exec(prose(line))
        if (m) bad.push(`${path.relative(GUIDE, file)}:${i + 1} ${m[0]}`)
      })
    }
    expect(bad).toEqual([])
  })
})

