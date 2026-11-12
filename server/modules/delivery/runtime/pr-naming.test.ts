import { describe, it, expect } from 'vitest'
import {
  classifyChangeType, batchChangeType, ticketRef, kebabTitle, ticketBranchName,
  batchBranchNameFor, resolveCollisionFreeName, titleChangeSummary, buildPrTitle,
  formatConventionalSubject, isConventionalCommitSubject, type TicketNamingInput,
} from './pr-naming'
import { isValidBranchName } from '../../../integration-branch'

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

  it('caps at ~48 chars at a word boundary, never a trailing dash', () => {
    const long = kebabTitle('this is an extremely long ticket title that keeps going and going forever')
    expect(long.length).toBeLessThanOrEqual(48)
    expect(long.endsWith('-')).toBe(false)
    expect(long).toBe('this-is-an-extremely-long-ticket-title-that')
  })

  it('never ends a cut slug on a one- or two-letter word (reads as a phrase, not a sentence cut short)', () => {
    // 40-char budget: the word-boundary cut lands on "de"; the slug backs up to the last real word.
    expect(kebabTitle('Alta sin clave de API: proyecto de ejemplo listo en un minuto', 40)).toBe('alta-sin-clave-de-api-proyecto')
    expect(kebabTitle('Buscar ajustes desde la paleta de comandos global', 40)).toBe('buscar-ajustes-desde-la-paleta')
    // The default budget keeps the whole phrase when it fits.
    expect(kebabTitle('Alta sin clave de API: proyecto de ejemplo')).toBe('alta-sin-clave-de-api-proyecto-de-ejemplo')
    // An uncut slug is never trimmed, even when it ends on a short word.
    expect(kebabTitle('Give it a go')).toBe('give-it-a-go')
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
  it('[spec:safe-pr-workflow/delivery-pr-titles-use-conventional-commits] [spec:safe-pr-workflow/release-automation-can-classify-new-deliveries] single ticket: <type>: <change> (<ref>), jira prevailing', () => {
    expect(buildPrTitle([t({ jiraKey: 'SKILLS-101', title: 'Darkmode added' })])).toBe('feat: darkmode added (SKILLS-101)')
    expect(buildPrTitle([t({ title: 'Fix crash on save' })])).toBe('fix: fix crash on save (37)')
  })

  it('the title type matches the branch type for the same ticket (consistency)', () => {
    const input = t({ jiraKey: 'OPS-3', title: 'Refactor spawn paths' })
    expect(ticketBranchName(input).startsWith('chore/')).toBe(true)
    expect(buildPrTitle([input]).startsWith('chore: ')).toBe(true)
  })

  it('single ticket without a title still yields a change clause', () => {
    expect(buildPrTitle([t({ ticketId: 8 })])).toBe('feat: implement 8 (8)')
  })

  it('[spec:safe-pr-workflow/delivery-pr-titles-use-conventional-commits] batch: <type>: <loop summary> (<primary-ref> +<n-1>)', () => {
    const a = t({ ticketId: 1, jiraKey: 'SKILLS-101', title: 'Add x' })
    const b = t({ ticketId: 2, title: 'Add y' })
    const c = t({ ticketId: 3, title: 'Add z' })
    expect(buildPrTitle([a, b, c], { loopName: 'Implement' })).toBe('feat: implement batch of 3 tickets (SKILLS-101 +2)')
  })

  it('[spec:safe-pr-workflow/delivery-pr-titles-use-conventional-commits] batch type follows the all-same-type rule', () => {
    const a = t({ ticketId: 1, title: 'Fix x' })
    const b = t({ ticketId: 2, labels: ['bugfix'] })
    expect(buildPrTitle([a, b], { loopName: 'Implement' })).toBe('fix: implement batch of 2 tickets (1 +1)')
  })

  it('[spec:safe-pr-workflow/generated-subjects-are-bounded-and-safe] sanitizes weird titles and caps total length', () => {
    const weird = t({ title: `\x07Ship "everything"   ${'y'.repeat(300)}.` })
    const title = buildPrTitle([weird])
    expect(title.startsWith('feat: ship "everything"')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(100)
    expect(title.includes('\x07')).toBe(false)
  })

  it('defensive empty-ticket fallback', () => {
    expect(buildPrTitle([], { loopName: 'Implement' })).toBe('chore: specrails delivery')
    expect(buildPrTitle([])).toBe('chore: specrails delivery')
  })
})

describe('conventional subject contract', () => {
  it.each([
    [{ title: 'Dark mode' }, 'feat: dark mode (37)'],
    [{ title: 'Read me', labels: ['docs'] }, 'docs: read me (37)'],
    [{ title: 'Clean paths', labels: ['chore'] }, 'chore: clean paths (37)'],
    [{ title: 'Crash', labels: ['bug', ' Breaking-Change '] }, 'fix!: crash (37)'],
    [{ title: 'Breaking prose' }, 'feat: breaking prose (37)'],
    [{ title: '🎉' }, 'feat: implement 37 (37)'],
    [{ title: '東京' }, 'feat: 東京 (37)'],
    [{ title: 'Add: one\n two\u2028three\u0085four' }, 'feat: add one two three four (37)'],
    [{ title: 'Dark mode', jiraKey: 'BAD\nKEY' }, 'feat: dark mode (37)'],
    [{ title: 'Dark mode', jiraKey: '\nKEY' }, 'feat: dark mode (37)'],
    [{ title: 'Dark mode', jiraKey: 'X'.repeat(200) }, 'feat: dark mode (37)'],
  ])('[spec:safe-pr-workflow/explicit-breaking-labels-mark-completed-changes] [spec:safe-pr-workflow/generated-subjects-are-bounded-and-safe] [spec:safe-pr-workflow/release-automation-can-classify-new-deliveries] formats %j', (input, expected) => {
    expect(buildPrTitle([t(input)])).toBe(expected)
  })

  it('[spec:safe-pr-workflow/explicit-breaking-labels-mark-completed-changes] marks a mixed batch breaking when any ticket has the exact label', () => {
    expect(buildPrTitle([t({ labels: ['bug'] }), t({ labels: ['breaking'] })]))
      .toBe('feat!: batch of 2 tickets (37 +1)')
  })

  it('[spec:safe-pr-workflow/generated-subjects-are-bounded-and-safe] reserves the entire reference suffix before truncating the change', () => {
    const ref = 'PROJECT-' + '1'.repeat(40)
    const subject = buildPrTitle([t({ title: 'a'.repeat(300), jiraKey: ref })])
    expect(subject).toHaveLength(100)
    expect(subject.endsWith(`… (${ref})`)).toBe(true)
  })

  it('[spec:safe-pr-workflow/generated-subjects-are-bounded-and-safe] retains the longest usable reference for the actual prefix', () => {
    const ref = 'A'.repeat(90)
    expect(buildPrTitle([t({ title: 'a', jiraKey: ref })])).toBe(`feat: a (${ref})`)
  })

  it.each(['[37]feat - old', 'perf: fast', 'feat: ', 'feat: a\nb', 'fix: a\u2028b', `feat: ${'a'.repeat(100)}`])('[spec:safe-pr-workflow/generated-subjects-are-bounded-and-safe] rejects %j independently', (subject) => {
    expect(isConventionalCommitSubject(subject)).toBe(false)
  })

  it.each([
    [['docs'], ['docs'], 'docs: batch of 2 tickets (37 +1)'],
    [['chore'], ['chore'], 'chore: batch of 2 tickets (37 +1)'],
    [['bug'], ['docs'], 'feat: batch of 2 tickets (37 +1)'],
  ])('formats batch classification %j / %j', (first, second, expected) => {
    expect(buildPrTitle([t({ labels: first }), t({ labels: second })])).toBe(expected)
  })

  it('[spec:safe-pr-workflow/generated-subjects-are-bounded-and-safe] validates generated single and batch PR subjects across ticket metadata', () => {
    for (const title of ['', '🎉', '東京', 'Fix: crash\nnow', 'x'.repeat(400)]) {
      for (const jiraKey of [null, 'SKILLS-101', '\nKEY', 'x'.repeat(200)]) {
        for (const labels of [[], ['bug'], ['docs'], ['chore'], ['breaking'], ['bug', 'breaking-change']]) {
          const ticket = t({ title, jiraKey, labels })
          expect(isConventionalCommitSubject(buildPrTitle([ticket]))).toBe(true)
          expect(isConventionalCommitSubject(buildPrTitle([ticket, t()], { loopName: title }))).toBe(true)
        }
      }
    }
  })

  it('[spec:safe-pr-workflow/generated-subjects-are-bounded-and-safe] validates deterministic generated input combinations', () => {
    for (const type of ['feat', 'fix', 'chore', 'docs'] as const) {
      for (const change of ['', '🎉', '東京', 'Fix: crash\nnow', 'x'.repeat(400)]) {
        for (const ref of ['', '37', 'SKILLS-101 +2', '\n', 'x'.repeat(200)]) {
          for (const breaking of [false, true]) {
            expect(isConventionalCommitSubject(formatConventionalSubject({ type, change, ref, breaking }))).toBe(true)
          }
        }
      }
    }
  })
})
