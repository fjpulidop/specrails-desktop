import { describe, it, expect } from 'vitest'
import {
  buildCanonicalPrBody, collectBranchChanges, extractSpecNarrative,
  isTestFilePath, parseShortstat, parseNameStatus,
  type BranchChanges, type PrBodyTicket,
} from './pr-body'
import type { GitRunner, GitResult } from './worktree-manager'

const ticket = (over: Partial<PrBodyTicket> = {}): PrBodyTicket => ({
  ticketId: 37,
  title: 'Add dark mode',
  description: 'Users cannot switch themes at night.\n\nAdd a theme toggle persisted per user.',
  branch: 'feat/37-add-dark-mode',
  ...over,
})

const changesFor = (branch: string, over: Partial<BranchChanges> = {}): Map<string, BranchChanges> =>
  new Map([[branch, { branch, filesChanged: 3, insertions: 120, deletions: 8, testFiles: [], failed: false, ...over }]])

// ─── helpers ──────────────────────────────────────────────────────────────────

describe('isTestFilePath', () => {
  it.each([
    ['server/db.test.ts', true],
    ['client/src/components/__tests__/RailRow.test.tsx', true],
    ['client/src/lib/__tests__/helper.ts', true], // inside __tests__/
    ['server/foo.spec.ts', true],
    ['server/db.ts', false],
    ['client/src/latest.tsx', false],
    ['server/protest.ts', false],
  ])('%s → %s', (p, expected) => {
    expect(isTestFilePath(p)).toBe(expected)
  })
})

describe('parseShortstat / parseNameStatus', () => {
  it('parses a full shortstat line', () => {
    expect(parseShortstat(' 12 files changed, 340 insertions(+), 25 deletions(-)\n')).toEqual({
      filesChanged: 12, insertions: 340, deletions: 25,
    })
  })
  it('tolerates missing parts and empty output', () => {
    expect(parseShortstat(' 1 file changed, 2 insertions(+)\n')).toEqual({ filesChanged: 1, insertions: 2, deletions: 0 })
    expect(parseShortstat('')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 })
  })
  it('parses name-status incl. renames (new path wins)', () => {
    const out = parseNameStatus('M\tserver/a.ts\nA\tserver/a.test.ts\nR100\told/x.ts\tnew/y.ts\n\n')
    expect(out).toEqual(['server/a.ts', 'server/a.test.ts', 'new/y.ts'])
  })
})

// ─── collectBranchChanges ─────────────────────────────────────────────────────

function fakeGit(handler: (args: string[]) => GitResult | Error): GitRunner {
  return {
    async run(args): Promise<GitResult> {
      const r = handler(args)
      if (r instanceof Error) throw r
      return r
    },
  }
}

describe('collectBranchChanges', () => {
  it('collects per-branch diffstat + touched test files', async () => {
    const git = fakeGit((args) => {
      if (args[1] === '--shortstat') return { code: 0, stdout: ' 4 files changed, 100 insertions(+), 7 deletions(-)', stderr: '' }
      return { code: 0, stdout: 'M\tserver/x.ts\nA\tserver/x.test.ts\nM\tclient/src/__tests__/y.test.tsx\n', stderr: '' }
    })
    const map = await collectBranchChanges(git, '/repo', 'main', ['feat/1-a', 'feat/1-a'])
    expect(map.size).toBe(1) // deduped
    const c = map.get('feat/1-a')!
    expect(c).toMatchObject({ filesChanged: 4, insertions: 100, deletions: 7, failed: false })
    expect(c.testFiles).toEqual(['server/x.test.ts', 'client/src/__tests__/y.test.tsx'])
  })

  it('a failing git command marks the branch failed (never throws)', async () => {
    const git = fakeGit(() => ({ code: 128, stdout: '', stderr: 'fatal: bad revision' }))
    const map = await collectBranchChanges(git, '/repo', 'main', ['feat/1-a'])
    expect(map.get('feat/1-a')!.failed).toBe(true)
  })

  it('a throwing git runner marks the branch failed (never throws)', async () => {
    const git = fakeGit(() => new Error('boom'))
    const map = await collectBranchChanges(git, '/repo', 'main', ['feat/1-a'])
    expect(map.get('feat/1-a')!.failed).toBe(true)
  })
})

// ─── extractSpecNarrative ─────────────────────────────────────────────────────

describe('extractSpecNarrative', () => {
  it('null/empty description → both slots null', () => {
    expect(extractSpecNarrative(null)).toEqual({ problem: null, solution: null, overflow: null })
    expect(extractSpecNarrative('   ')).toEqual({ problem: null, solution: null, overflow: null })
    expect(extractSpecNarrative(undefined)).toEqual({ problem: null, solution: null, overflow: null })
  })

  it('explicit Problem/Solution headings are used', () => {
    const n = extractSpecNarrative('## Problem\n\nIt crashes.\n\n## Solution\n\nCatch the error.')
    expect(n.problem).toBe('It crashes.')
    expect(n.solution).toContain('Catch the error.')
  })

  it('bold-label sections work too (**Context** / **Approach**)', () => {
    const n = extractSpecNarrative('**Context**\nUsers lose data.\n\n**Approach**\nAdd autosave.')
    expect(n.problem).toBe('Users lose data.')
    expect(n.solution).toContain('Add autosave.')
  })

  it('heading-less description: first paragraph = problem, rest = solution', () => {
    const n = extractSpecNarrative('The app is slow on startup.\n\nLazy-load the dashboard.\n\nSplit the bundle.')
    expect(n.problem).toBe('The app is slow on startup.')
    expect(n.solution).toContain('Lazy-load the dashboard.')
    expect(n.solution).toContain('Split the bundle.')
  })

  it('single-paragraph description: problem only, no solution', () => {
    const n = extractSpecNarrative('Just do the thing.')
    expect(n.problem).toBe('Just do the thing.')
    expect(n.solution).toBeNull()
  })

  it('leading narrative before headings is the problem when no problem heading exists', () => {
    const n = extractSpecNarrative('Users cannot export data.\n\n## Implementation\n\nAdd a CSV exporter.')
    expect(n.problem).toBe('Users cannot export data.')
    expect(n.solution).toContain('CSV exporter')
  })

  it('the Contract Layer appendix is stripped before extraction', () => {
    const desc = 'It crashes.\n\n---\n\n## Contract Layer\n\n### Exact identifiers\nsecret-stuff'
    const n = extractSpecNarrative(desc)
    expect(n.problem).toBe('It crashes.')
    expect(`${n.problem}${n.solution ?? ''}${n.overflow ?? ''}`).not.toContain('secret-stuff')
  })

  it('long solutions overflow (full text preserved for the details block)', () => {
    const long = `## Solution\n\n${'The approach is nuanced. '.repeat(80)}`
    const n = extractSpecNarrative(`Problem text.\n\n${long}`)
    expect(n.solution!.length).toBeLessThanOrEqual(910)
    expect(n.overflow).not.toBeNull()
    expect(n.overflow!.length).toBeGreaterThan(n.solution!.length)
  })
})

// ─── buildCanonicalPrBody ─────────────────────────────────────────────────────

describe('buildCanonicalPrBody', () => {
  const base = { loopName: 'Implement', baseBranch: 'main' }

  it('single local ticket: summary + #id heading + Problem/Solution/Tests + Changes', () => {
    const t = ticket()
    const body = buildCanonicalPrBody({
      ...base,
      tickets: [t],
      changes: changesFor(t.branch!, { testFiles: ['server/theme.test.ts'] }),
    })
    expect(body).toContain('This pull request delivers 1 ticket (#37)')
    expect(body).toContain('**Implement**')
    expect(body).toContain('`main`')
    expect(body).toContain('## #37 — Add dark mode')
    expect(body).toContain('**Problem**')
    expect(body).toContain('Users cannot switch themes at night.')
    expect(body).toContain('**Solution**')
    expect(body).toContain('theme toggle')
    expect(body).toContain('**Tests**')
    expect(body).toContain('- `server/theme.test.ts`')
    expect(body).toContain('## Changes')
    expect(body).toContain('- `feat/37-add-dark-mode` — 3 files changed, +120 −8')
    // the retired v1 footer is gone
    expect(body).not.toContain('Draft PR produced by specrails')
    expect(body).not.toContain('engineer owns the merge')
  })

  it('jira-linked ticket heads with the key (no # prefix)', () => {
    const t = ticket({ jiraKey: 'SKILLS-101' })
    const body = buildCanonicalPrBody({ ...base, tickets: [t], changes: changesFor(t.branch!) })
    expect(body).toContain('## SKILLS-101 — Add dark mode')
    expect(body).toContain('(SKILLS-101)')
    expect(body).not.toContain('## #37')
  })

  it('multi-ticket body renders one section per ticket', () => {
    const a = ticket({ ticketId: 1, title: 'A', branch: 'feat/1-a', description: 'Problem A.\n\nSolution A.' })
    const b = ticket({ ticketId: 2, title: 'B', branch: 'feat/2-b', description: 'Problem B.\n\nSolution B.' })
    const body = buildCanonicalPrBody({ ...base, tickets: [a, b], changes: null })
    expect(body).toContain('This pull request delivers 2 tickets (#1, #2)')
    expect(body).toContain('## #1 — A')
    expect(body).toContain('## #2 — B')
  })

  it('missing description → Problem/Solution headings omitted, Tests still present', () => {
    const t = ticket({ description: null })
    const body = buildCanonicalPrBody({ ...base, tickets: [t], changes: changesFor(t.branch!) })
    expect(body).not.toContain('**Problem**')
    expect(body).not.toContain('**Solution**')
    expect(body).toContain('**Tests**')
  })

  it('missing title → bare ref heading', () => {
    const t = ticket({ title: null })
    const body = buildCanonicalPrBody({ ...base, tickets: [t], changes: null })
    expect(body).toContain('## #37\n')
  })

  it('honest Tests: none touched → the exact no-test sentence; never invented', () => {
    const t = ticket()
    const body = buildCanonicalPrBody({ ...base, tickets: [t], changes: changesFor(t.branch!, { testFiles: [] }) })
    expect(body).toContain('No test files changed in this diff.')
  })

  it('diff failure → explicit unavailable note per ticket + Changes section omitted', () => {
    const t = ticket()
    const body = buildCanonicalPrBody({
      ...base,
      tickets: [t],
      changes: changesFor(t.branch!, { failed: true }),
    })
    expect(body).toContain('_Diff unavailable — test changes could not be derived._')
    expect(body).not.toContain('## Changes')
  })

  it('changes: null (whole diff pass failed) → Changes omitted, unavailable notes', () => {
    const body = buildCanonicalPrBody({ ...base, tickets: [ticket()], changes: null })
    expect(body).not.toContain('## Changes')
    expect(body).toContain('_Diff unavailable — test changes could not be derived._')
  })

  it('long solution digests overflow into a collapsed details block', () => {
    const t = ticket({ description: `Problem.\n\n## Solution\n\n${'Very detailed design. '.repeat(120)}` })
    const body = buildCanonicalPrBody({ ...base, tickets: [t], changes: null })
    expect(body).toContain('<details>')
    expect(body).toContain('<summary>Full spec digest</summary>')
    expect(body).toContain('</details>')
  })

  it('a long test-file list is capped with an "and N more" line', () => {
    const files = Array.from({ length: 30 }, (_, i) => `server/mod-${i}.test.ts`)
    const t = ticket()
    const body = buildCanonicalPrBody({ ...base, tickets: [t], changes: changesFor(t.branch!, { testFiles: files }) })
    expect(body).toContain('- `server/mod-0.test.ts`')
    expect(body).toContain('- … and 10 more')
    expect(body).not.toContain('mod-25.test.ts')
  })

  it('zero-diffstat branch renders an honest "no file changes detected"', () => {
    const t = ticket()
    const body = buildCanonicalPrBody({
      ...base,
      tickets: [t],
      changes: changesFor(t.branch!, { filesChanged: 0, insertions: 0, deletions: 0 }),
    })
    expect(body).toContain('no file changes detected')
  })
})
