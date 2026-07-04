import { describe, it, expect } from 'vitest'
import {
  classifyChangeType, batchChangeType, ticketRef, kebabTitle, ticketBranchName,
  batchBranchNameFor, resolveCollisionFreeName, titleChangeSummary, buildPrTitle,
  type TicketNamingInput,
} from './pr-naming'
import { isValidBranchName } from './integration-branch'

const t = (over: Partial<TicketNamingInput> = {}): TicketNamingInput => ({ ticketId: 37, ...over })

describe('classifyChangeType (documented heuristic)', () => {
  it.each([
    [{ title: 'Fix crash on save' }, 'fix'],
    [{ title: 'Bug: dashboard flickers' }, 'fix'],
    [{ title: 'Hotfix for prod' }, 'fix'],
    [{ title: 'Refactor queue manager' }, 'chore'],
    [{ title: 'Cleanup dead code' }, 'chore'],
    [{ title: 'chore: bump deps' }, 'chore'],
    [{ title: 'Docs for the MCP server' }, 'docs'],
    [{ title: 'Update documentation' }, 'docs'],
    [{ title: 'Add dark mode' }, 'feat'],
    [{ title: '' }, 'feat'],
    [{}, 'feat'],
  ] as const)('%j → %s', (input, expected) => {
    expect(classifyChangeType(t(input))).toBe(expected)
  })

  it('labels take precedence over the title', () => {
    expect(classifyChangeType(t({ title: 'Add dark mode', labels: ['bug'] }))).toBe('fix')
    expect(classifyChangeType(t({ title: 'Fix crash', labels: ['docs'] }))).toBe('docs')
    expect(classifyChangeType(t({ title: 'Anything', labels: ['type:refactor'] }))).toBe('chore')
  })

  it('does not match keyword substrings inside words (prefix/suffix)', () => {
    expect(classifyChangeType(t({ title: 'Add prefix support' }))).toBe('feat') // "prefix" ≠ fix
    expect(classifyChangeType(t({ title: 'Show doctor status' }))).toBe('feat') // "doctor" ≠ doc
  })

  it('fix wins when several groups match (documented order)', () => {
    expect(classifyChangeType(t({ title: 'docs: fix typo in readme' }))).toBe('fix')
  })
})

describe('batchChangeType', () => {
  it('feat unless ALL tickets map to the same other type', () => {
    expect(batchChangeType([t({ title: 'Fix a' }), t({ title: 'Fix b' })])).toBe('fix')
    expect(batchChangeType([t({ title: 'Fix a' }), t({ title: 'Add b' })])).toBe('feat')
    expect(batchChangeType([t({ title: 'Docs a' }), t({ title: 'Docs b' })])).toBe('docs')
    expect(batchChangeType([])).toBe('feat')
  })
})

describe('ticketRef (jira precedence)', () => {
  it('jira key prevails, local id fallback', () => {
    expect(ticketRef(t({ jiraKey: 'SKILLS-101' }))).toBe('SKILLS-101')
    expect(ticketRef(t({ jiraKey: '  ' }))).toBe('37')
    expect(ticketRef(t({ jiraKey: null }))).toBe('37')
    expect(ticketRef(t())).toBe('37')
  })
})

describe('kebabTitle (sanitization matrix)', () => {
  it.each([
    ['Add dark mode', 'add-dark-mode'],
    ['Añadir modo óscuro', 'anadir-modo-oscuro'],
    ['Über die Straße', 'uber-die-strasse'], // ß folded to ss explicitly (no NFKD decomposition)
    ['emoji 🎉 party 🎊 time', 'emoji-party-time'],
    ['🎉🎊', ''], // symbol-only folds to nothing
    ['  spaces   and\ttabs ', 'spaces-and-tabs'],
    ['weird..refs~and^chars:?*[\\', 'weird-refs-and-chars'],
    ['ends with dash-', 'ends-with-dash'],
    ['UPPER Case Title', 'upper-case-title'],
    ['a/b//c', 'a-b-c'],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(kebabTitle(input)).toBe(expected)
  })

  it('caps at ~40 chars at a word boundary, never a trailing dash', () => {
    const long = kebabTitle('this is an extremely long ticket title that keeps going and going forever')
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long.endsWith('-')).toBe(false)
    expect(long).toBe('this-is-an-extremely-long-ticket-title')
  })
})

describe('ticketBranchName', () => {
  it('jira-linked: <type>/<KEY>-<kebab>', () => {
    expect(ticketBranchName(t({ jiraKey: 'SKILLS-101', title: 'Add dark mode' }))).toBe('feat/SKILLS-101-add-dark-mode')
    expect(ticketBranchName(t({ jiraKey: 'OPS-9', title: 'Fix crash on save', labels: ['bug'] }))).toBe('fix/OPS-9-fix-crash-on-save')
  })

  it('local: <type>/<id>-<kebab>', () => {
    expect(ticketBranchName(t({ title: 'Add dark mode' }))).toBe('feat/37-add-dark-mode')
    expect(ticketBranchName(t({ title: 'Refactor the queue' }))).toBe('chore/37-refactor-the-queue')
  })

  it('missing/emoji-only title → <type>/<ref> with no trailing dash', () => {
    expect(ticketBranchName(t())).toBe('feat/37')
    expect(ticketBranchName(t({ title: '🎉🎊', jiraKey: 'PROJ-1' }))).toBe('feat/PROJ-1')
  })

  it('a hostile jira key is folded or dropped; result always passes isValidBranchName', () => {
    const hostile: TicketNamingInput[] = [
      t({ jiraKey: '--evil', title: 'x' }),
      t({ jiraKey: 'A..B', title: 'x' }),
      t({ jiraKey: 'k.lock', title: 'x' }),
      t({ jiraKey: 'sp ace/key', title: 'x' }),
      t({ jiraKey: '💥', title: '💥' }),
      t({ title: '..' }),
    ]
    for (const input of hostile) {
      const name = ticketBranchName(input)
      expect(isValidBranchName(name), name).toBe(true)
    }
  })

  it('every generated name passes isValidBranchName (unicode/long/invalid-char sweep)', () => {
    const titles = ['ñandú über 東京 🚀', 'a'.repeat(500), '~^:?*[]\\', 'CON.lock', '   ', 'fix: crash']
    for (const title of titles) {
      expect(isValidBranchName(ticketBranchName(t({ title }))), title).toBe(true)
      expect(isValidBranchName(ticketBranchName(t({ title, jiraKey: 'PROJ-12' }))), title).toBe(true)
    }
  })
})

describe('batchBranchNameFor', () => {
  it('primary ref + count; feat unless all same other type', () => {
    const a = t({ ticketId: 1, jiraKey: 'SKILLS-101', title: 'Add x' })
    const b = t({ ticketId: 2, title: 'Add y' })
    expect(batchBranchNameFor([a, b])).toBe('feat/SKILLS-101-batch-2-tickets')
    const f1 = t({ ticketId: 1, title: 'Fix x' })
    const f2 = t({ ticketId: 2, title: 'Bug y' })
    expect(batchBranchNameFor([f1, f2])).toBe('fix/1-batch-2-tickets')
  })

  it('always passes isValidBranchName', () => {
    expect(isValidBranchName(batchBranchNameFor([t({ jiraKey: '💥' }), t({ ticketId: 2 })]))).toBe(true)
  })
})

describe('resolveCollisionFreeName', () => {
  it('returns the preferred name when free', () => {
    expect(resolveCollisionFreeName('feat/1-x', { taken: () => false })).toBe('feat/1-x')
  })

  it('suffixes -2, -3 on collision', () => {
    const taken = new Set(['feat/1-x', 'feat/1-x-2'])
    expect(resolveCollisionFreeName('feat/1-x', { taken: (n) => taken.has(n) })).toBe('feat/1-x-3')
  })

  it('NEVER returns a reserved name (integration branch guard)', () => {
    expect(resolveCollisionFreeName('main', { taken: () => false, reserved: ['main'] })).toBe('main-2')
    expect(
      resolveCollisionFreeName('feat/1-x', { taken: (n) => n === 'feat/1-x', reserved: ['feat/1-x-2'] }),
    ).toBe('feat/1-x-3')
  })

  it('bounded: null when every attempt is taken', () => {
    expect(resolveCollisionFreeName('feat/1-x', { taken: () => true, maxAttempts: 5 })).toBeNull()
  })
})

describe('titleChangeSummary', () => {
  it('lowercases a plain leading word, keeps acronyms/CamelCase', () => {
    expect(titleChangeSummary('Add dark mode')).toBe('add dark mode')
    expect(titleChangeSummary('MCP server exposed')).toBe('MCP server exposed')
    expect(titleChangeSummary('JobDetailPage rework')).toBe('JobDetailPage rework')
  })

  it('strips control chars, collapses whitespace, drops trailing periods', () => {
    expect(titleChangeSummary('  Fix\tthe   thing.. ')).toBe('fix the thing')
    expect(titleChangeSummary('\x00\x01')).toBe('')
  })

  it('caps very long summaries with an ellipsis', () => {
    const s = titleChangeSummary(`Do ${'x'.repeat(200)}`)
    expect(s.length).toBeLessThanOrEqual(72)
    expect(s.endsWith('…')).toBe(true)
  })
})

describe('buildPrTitle', () => {
  it('single ticket: [<ref>]<type> - <change>, jira prevailing', () => {
    expect(buildPrTitle([t({ jiraKey: 'SKILLS-101', title: 'Darkmode added' })])).toBe('[SKILLS-101]feat - darkmode added')
    expect(buildPrTitle([t({ title: 'Fix crash on save' })])).toBe('[37]fix - fix crash on save')
  })

  it('the title type matches the branch type for the same ticket (consistency)', () => {
    const input = t({ jiraKey: 'OPS-3', title: 'Refactor spawn paths' })
    expect(ticketBranchName(input).startsWith('chore/')).toBe(true)
    expect(buildPrTitle([input]).startsWith('[OPS-3]chore - ')).toBe(true)
  })

  it('single ticket without a title still yields a change clause', () => {
    expect(buildPrTitle([t({ ticketId: 8 })])).toBe('[8]feat - implement 8')
  })

  it('batch: [<primary-ref> +<n-1>]<type> - <loop summary>', () => {
    const a = t({ ticketId: 1, jiraKey: 'SKILLS-101', title: 'Add x' })
    const b = t({ ticketId: 2, title: 'Add y' })
    const c = t({ ticketId: 3, title: 'Add z' })
    expect(buildPrTitle([a, b, c], { loopName: 'Implement' })).toBe('[SKILLS-101 +2]feat - implement batch of 3 tickets')
  })

  it('batch type follows the all-same-type rule', () => {
    const a = t({ ticketId: 1, title: 'Fix x' })
    const b = t({ ticketId: 2, labels: ['bugfix'] })
    expect(buildPrTitle([a, b], { loopName: 'Implement' })).toBe('[1 +1]fix - implement batch of 2 tickets')
  })

  it('sanitizes weird titles and caps total length', () => {
    const weird = t({ title: `\x07Ship "everything"   ${'y'.repeat(300)}.` })
    const title = buildPrTitle([weird])
    expect(title.startsWith('[37]feat - ship "everything"')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(100)
    expect(title.includes('\x07')).toBe(false)
  })

  it('defensive empty-ticket fallback', () => {
    expect(buildPrTitle([], { loopName: 'Implement' })).toBe('implement')
    expect(buildPrTitle([])).toBe('specrails delivery')
  })
})
