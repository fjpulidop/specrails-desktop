/**
 * Canonical open-source-style PR body for the safe-pr-review-flow's draft PRs,
 * composed at CREATE-PR time (rail-pr-decision has db + git + ticket store).
 *
 * Shape:
 *   <one-paragraph summary: loop name, N tickets, base branch>
 *   ## <ref> — <title>          (ref = Jira key when linked, else #<local id>)
 *     **Problem**   — the spec's leading narrative (omitted when missing)
 *     **Solution**  — a tight digest of the designed approach; overflow lands
 *                     in a collapsed <details> block, never a full spec dump
 *     **Tests**     — HONEST: derived from the branch diff (touched test
 *                     files); "No test files changed in this diff." when none;
 *                     an explicit unavailable note when the diff failed
 *   ## Changes                   (per-branch diffstat; omitted when git failed)
 *
 * The diff collection (`collectBranchChanges`) is graceful-by-contract: a git
 * failure marks the branch `failed` and can only degrade the body — it NEVER
 * blocks PR creation. The body builder itself is pure/sync.
 */
import type { GitRunner } from './worktree-manager'
import { splitDescriptionAtContractLayer } from './explore-contract-refine'
import { ticketRef, type TicketNamingInput } from './pr-naming'

export interface PrBodyTicket extends TicketNamingInput {
  description?: string | null
  /** The unit branch carrying this ticket's work (keys into the changes map). */
  branch?: string | null
}

export interface BranchChanges {
  branch: string
  filesChanged: number
  insertions: number
  deletions: number
  /** Touched test files (server/client conventions: *.test.* / *.spec.* / __tests__/). */
  testFiles: string[]
  /** True when the diff could not be computed for this branch. */
  failed: boolean
}

const TEST_FILE_RE = /(\.test\.[jt]sx?|\.spec\.[jt]sx?)$/
const PROBLEM_MAX = 600
const SOLUTION_MAX = 900
const OVERFLOW_MAX = 3000
const MAX_TEST_FILES_LISTED = 20

export function isTestFilePath(p: string): boolean {
  return TEST_FILE_RE.test(p) || p.includes('__tests__/')
}

/**
 * Per-branch diffstat + touched test files via `git diff` against the base
 * (three-dot: what the branch adds over the merge-base). Failures are recorded
 * per branch (`failed: true`) — never thrown.
 */
export async function collectBranchChanges(
  git: GitRunner,
  repoDir: string,
  baseBranch: string,
  branches: string[],
): Promise<Map<string, BranchChanges>> {
  const out = new Map<string, BranchChanges>()
  for (const branch of [...new Set(branches)]) {
    const entry: BranchChanges = { branch, filesChanged: 0, insertions: 0, deletions: 0, testFiles: [], failed: false }
    try {
      const stat = await git.run(['diff', '--shortstat', `${baseBranch}...${branch}`], repoDir)
      const names = await git.run(['diff', '--name-status', `${baseBranch}...${branch}`], repoDir)
      if (stat.code !== 0 || names.code !== 0) {
        entry.failed = true
      } else {
        const parsed = parseShortstat(stat.stdout)
        entry.filesChanged = parsed.filesChanged
        entry.insertions = parsed.insertions
        entry.deletions = parsed.deletions
        entry.testFiles = parseNameStatus(names.stdout).filter(isTestFilePath)
      }
    } catch {
      entry.failed = true
    }
    out.set(branch, entry)
  }
  return out
}

/** Parse `N files changed, X insertions(+), Y deletions(-)` (any part may be absent). */
export function parseShortstat(stdout: string): { filesChanged: number; insertions: number; deletions: number } {
  const files = /(\d+) files? changed/.exec(stdout)
  const ins = /(\d+) insertions?\(\+\)/.exec(stdout)
  const del = /(\d+) deletions?\(-\)/.exec(stdout)
  return {
    filesChanged: files ? parseInt(files[1], 10) : 0,
    insertions: ins ? parseInt(ins[1], 10) : 0,
    deletions: del ? parseInt(del[1], 10) : 0,
  }
}

/** Parse `git diff --name-status` output into touched paths (rename → new path). */
export function parseNameStatus(stdout: string): string[] {
  const paths: string[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('\t')
    if (parts.length < 2) continue
    paths.push(parts[parts.length - 1])
  }
  return paths
}

export interface CanonicalPrBodyInput {
  loopName: string
  baseBranch: string
  tickets: PrBodyTicket[]
  /** Keyed by branch; null/undefined ⇒ the whole diff pass failed → section omitted. */
  changes?: Map<string, BranchChanges> | null
}

export function buildCanonicalPrBody(input: CanonicalPrBodyInput): string {
  const parts: string[] = [summaryParagraph(input)]

  for (const t of input.tickets) {
    parts.push(ticketSection(t, input.changes ?? null))
  }

  const changesSection = buildChangesSection(input.changes ?? null)
  if (changesSection) parts.push(changesSection)

  return parts.join('\n\n')
}

function summaryParagraph(input: CanonicalPrBodyInput): string {
  const n = input.tickets.length
  const refs = input.tickets.map((t) => displayRef(t)).join(', ')
  const noun = n === 1 ? 'ticket' : 'tickets'
  return (
    `This pull request delivers ${n} ${noun} (${refs}) implemented by the ` +
    `**${input.loopName}** run against \`${input.baseBranch}\`. Each ticket below ` +
    `describes the problem it addresses, the approach taken, and the test files ` +
    `touched by its diff.`
  )
}

/** Body-facing ref: Jira key verbatim when linked, `#<id>` for local tickets. */
function displayRef(t: PrBodyTicket): string {
  return t.jiraKey?.trim() ? ticketRef(t) : `#${t.ticketId}`
}

function ticketSection(t: PrBodyTicket, changes: Map<string, BranchChanges> | null): string {
  const title = cleanInline(t.title)
  const heading = title ? `## ${displayRef(t)} — ${title}` : `## ${displayRef(t)}`
  const chunks: string[] = [heading]

  const narrative = extractSpecNarrative(t.description)
  if (narrative.problem) {
    chunks.push('**Problem**', clampText(narrative.problem, PROBLEM_MAX))
  }
  if (narrative.solution) {
    chunks.push('**Solution**', clampText(narrative.solution, SOLUTION_MAX))
    if (narrative.overflow) {
      chunks.push(
        `<details>\n<summary>Full spec digest</summary>\n\n${clampText(narrative.overflow, OVERFLOW_MAX)}\n\n</details>`,
      )
    }
  }

  chunks.push('**Tests**', testsLine(t, changes))
  return chunks.join('\n\n')
}

function testsLine(t: PrBodyTicket, changes: Map<string, BranchChanges> | null): string {
  const entry = t.branch ? changes?.get(t.branch) : undefined
  if (!entry || entry.failed) {
    return '_Diff unavailable — test changes could not be derived._'
  }
  if (entry.testFiles.length === 0) {
    return 'No test files changed in this diff.'
  }
  const listed = entry.testFiles.slice(0, MAX_TEST_FILES_LISTED)
  const lines = listed.map((f) => `- \`${f}\``)
  const more = entry.testFiles.length - listed.length
  if (more > 0) lines.push(`- … and ${more} more`)
  return lines.join('\n')
}

function buildChangesSection(changes: Map<string, BranchChanges> | null): string | null {
  if (!changes) return null
  const ok = [...changes.values()].filter((c) => !c.failed)
  if (ok.length === 0) return null
  const lines = ok.map((c) => {
    const stat =
      c.filesChanged > 0
        ? `${c.filesChanged} file${c.filesChanged === 1 ? '' : 's'} changed, +${c.insertions} −${c.deletions}`
        : 'no file changes detected'
    return `- \`${c.branch}\` — ${stat}`
  })
  return ['## Changes', lines.join('\n')].join('\n\n')
}

// ─── Spec narrative extraction ────────────────────────────────────────────────

interface SpecNarrative {
  problem: string | null
  solution: string | null
  /** Solution content beyond the visible digest (rendered inside <details>). */
  overflow: string | null
}

const PROBLEM_HEADING_RE = /\b(problem|context|background|motivation|why)\b/i
const SOLUTION_HEADING_RE = /\b(solution|approach|design|implementation|proposal|how|what)\b/i

interface Section {
  /** null = the preamble before any heading. */
  title: string | null
  content: string
}

/**
 * Split a spec description into Problem/Solution digests:
 *  - a heading matching problem/context/background wins the Problem slot,
 *    else the leading narrative before the first heading;
 *  - headings matching solution/approach/design/implementation feed the
 *    Solution slot, else everything that is not the Problem;
 *  - the Contract Layer appendix (app machinery) is stripped first.
 * Tolerates missing/empty descriptions (both slots null → headings omitted).
 */
export function extractSpecNarrative(description: string | null | undefined): SpecNarrative {
  if (typeof description !== 'string' || !description.trim()) {
    return { problem: null, solution: null, overflow: null }
  }
  const { user } = splitDescriptionAtContractLayer(description)
  const text = user.replace(/\r\n/g, '\n').trim()
  if (!text) return { problem: null, solution: null, overflow: null }

  const sections = splitSections(text)
  const preamble = sections.find((s) => s.title === null)?.content?.trim() ?? ''
  const headed = sections.filter((s): s is Section & { title: string } => s.title !== null)

  let problem: string | null = null
  const problemSection = headed.find((s) => PROBLEM_HEADING_RE.test(s.title))
  if (problemSection?.content.trim()) {
    problem = problemSection.content.trim()
  } else if (preamble) {
    problem = preamble
  }

  const solutionParts: string[] = []
  const solutionSections = headed.filter((s) => s !== problemSection && SOLUTION_HEADING_RE.test(s.title))
  if (solutionSections.length > 0) {
    for (const s of solutionSections) {
      if (s.content.trim()) solutionParts.push(`**${s.title.trim()}** — ${s.content.trim()}`)
    }
  } else {
    // No explicit solution headings: use the remaining content (everything
    // after what we used as the problem).
    const rest = headed.filter((s) => s !== problemSection && s.content.trim())
    if (rest.length > 0) {
      for (const s of rest) solutionParts.push(`**${s.title.trim()}** — ${s.content.trim()}`)
    } else if (!problemSection && preamble && problem === preamble) {
      // Heading-less description: first paragraph = problem, remainder = solution.
      const paras = preamble.split(/\n{2,}/)
      if (paras.length > 1) {
        problem = paras[0].trim()
        solutionParts.push(paras.slice(1).join('\n\n').trim())
      }
    }
  }

  const solutionFull = solutionParts.join('\n\n').trim() || null
  if (!solutionFull) return { problem, solution: null, overflow: null }
  if (solutionFull.length <= SOLUTION_MAX) return { problem, solution: solutionFull, overflow: null }
  return {
    problem,
    solution: clampText(solutionFull, SOLUTION_MAX),
    overflow: solutionFull,
  }
}

/** Split markdown into sections at `#`-headings and standalone `**Bold**` label lines. */
function splitSections(text: string): Section[] {
  const lines = text.split('\n')
  const sections: Section[] = []
  let current: Section = { title: null, content: '' }
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line) ?? /^\*\*([^*]+)\*\*:?\s*$/.exec(line)
    if (heading) {
      sections.push(current)
      current = { title: heading[1], content: '' }
    } else {
      current.content += (current.content ? '\n' : '') + line
    }
  }
  sections.push(current)
  return sections
}

function cleanInline(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim()
}

function clampText(s: string, max: number): string {
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${cut.slice(0, lastSpace > max / 2 ? lastSpace : max).trimEnd()} …`
}
