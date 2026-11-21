/**
 * Which tests a run's host verification failed, and which of them look flaky,
 * read from the verification output the run already recorded (pure).
 *
 * A round is one visit of the verification step (one candidate of the code).
 * The rounds of a whole attempt chain are read oldest first, so a test that
 * passed in the attempts before and fails now is seen as such. Nothing is
 * re-run: the classification uses recorded output only.
 *
 * A failing test of the latest round is flaky when the record shows it:
 * - `mixed`: it passed and failed on the same candidate (two commands of one
 *   round, or a retry the runner reported);
 * - `reported`: the test runner itself listed it as flaky (Playwright retries);
 * - `alternating`: its outcome flipped at least twice across the rounds;
 * - `timing`: it passed in at least two earlier rounds and now fails on a
 *   timeout or a process/page that closed under it (a race, not an assertion
 *   about the change).
 */

export type TestOutcome = 'pass' | 'fail'
export type FlakyBasis = 'mixed' | 'reported' | 'alternating' | 'timing'

export interface VerificationRound {
  /** The round's verification output lines, in order (ANSI and runner prefixes are tolerated). */
  lines: readonly string[]
}

export interface VerificationTests {
  /** Tests that failed in the latest round with test results, as `file › title`. */
  failingTests: string[]
  /** The failing tests the record shows to be flaky, with why. */
  flakyTests: string[]
  flakyBasis: Record<string, FlakyBasis>
  /** Rounds that reported test results. */
  rounds: number
}

const MAX_FAILING = 20
const MAX_FLAKY = 12
const MAX_NAME = 240
const MAX_LINES_PER_ROUND = 20_000

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
/** `[verification primary-…/npm] ` (Core's prefix of a verification command's output). */
const RUNNER_PREFIX = /^\[verification [^\]]*\]\s?/
const DURATION = /\s*\((?:\d+(?:\.\d+)?\s*(?:ms|s|m|min)|retry #\d+)\)\s*$/
const TRAILING_MS = /\s+\d+(?:\.\d+)?\s*ms\s*$/
const SPEC_TAGS = /\s*\[spec:[^\]]*\]/g
const TEST_FILE = /^(\S+?\.(?:spec|test|e2e)\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?$/

// Playwright list reporter: `✓  21 tests/a.spec.ts:209:1 › title (843ms)`, optionally `[project] › ` first.
const PLAYWRIGHT_RESULT = /^\s*(✓|✔|ok|✘|×|x)\s+\d+\s+(?:\[[^\]]+\]\s+›\s+)?(\S+?\.[cm]?[jt]sx?(?::\d+:\d+)?)\s+›\s+(.+)$/
// Playwright summary list entries (`  1 failed` / `  2 flaky`, then `    [project] › file:line:col › title`).
const PLAYWRIGHT_SUMMARY_HEAD = /^\s*\d+\s+(failed|flaky|passed|skipped|did not run|interrupted)\b/
const PLAYWRIGHT_SUMMARY_ITEM = /^\s+(?:\[[^\]]+\]\s+›\s+)?(\S+?\.[cm]?[jt]sx?:\d+:\d+)\s+›\s+(.+)$/
// Playwright failure block header: `  1) tests/a.spec.ts:221:1 › title ───`.
const FAILURE_HEADER = /^\s*\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?(\S+?\.[cm]?[jt]sx?:\d+:\d+)\s+›\s+(.+?)\s*[─-]*\s*$/
// Vitest verbose: ` ✓ src/a.test.ts > suite > name 2ms` / ` × …` / ` FAIL  src/a.test.ts > suite > name`.
const VITEST_RESULT = /^\s*(✓|✔|×|✗|FAIL)\s+(\S+?\.(?:spec|test)\.[cm]?[jt]sx?)\s+>\s+(.+)$/
// Vitest default: ` ❯ src/a.test.ts (3 tests | 1 failed)` then `   × suite > name 2ms`.
const VITEST_FILE = /^\s*❯\s+(\S+?\.(?:spec|test)\.[cm]?[jt]sx?)\b/
const VITEST_NESTED = /^\s{2,}(×|✗|✓|✔)\s+(.+?)$/
// Jest: ` FAIL src/a.test.ts` / ` PASS …`, then `  ✕ name (3 ms)` / `  ✓ name (2 ms)`.
const JEST_FILE = /^\s*(PASS|FAIL)\s+(\S+?\.(?:spec|test)\.[cm]?[jt]sx?)\b/
const JEST_RESULT = /^\s{2,}(✕|✓|√)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?$/
/** A failure that says the clock or the process lost, not the change. */
const TIMING = /\bTimeout \d+ ?ms exceeded\b|\bexceeded while waiting\b|\btimed? ?out\b|\bTarget (?:page, context or browser|closed)\b|\bhas been closed\b|\bETIMEDOUT\b|\bwaiting for (?:event|process|exit)\b/i

const PASS_MARKS = new Set(['✓', '✔', 'ok', '√'])

function clean(line: string): string {
  return line.replace(ANSI, '').replace(RUNNER_PREFIX, '').replace(/\r$/, '')
}

function title(raw: string): string {
  return raw.replace(SPEC_TAGS, '').replace(DURATION, '').replace(TRAILING_MS, '').replace(/\s*[─]+\s*$/, '').replace(/\s+/g, ' ').trim()
}

/** `file › title` with the line/column dropped: a test keeps its name when lines above it move. */
export function testName(file: string, rawTitle: string): string | null {
  const path = TEST_FILE.exec(file)?.[1] ?? file.replace(/:\d+(?::\d+)?$/, '')
  const name = title(rawTitle.replace(/\s+>\s+/g, ' › '))
  if (!name || !path) return null
  return `${path} › ${name}`.slice(0, MAX_NAME)
}

export interface RoundTests {
  outcomes: Map<string, Set<TestOutcome>>
  reportedFlaky: Set<string>
  /** The failure lines printed for a test (Playwright's numbered blocks), bounded. */
  failureText: Map<string, string>
}

/** The test results one round printed. Tolerant: lines it cannot read are skipped. */
export function parseRound(lines: readonly string[]): RoundTests {
  const outcomes = new Map<string, Set<TestOutcome>>()
  const reportedFlaky = new Set<string>()
  const failureText = new Map<string, string>()
  const add = (name: string | null, outcome: TestOutcome) => {
    if (!name) return
    const set = outcomes.get(name) ?? new Set<TestOutcome>()
    set.add(outcome)
    outcomes.set(name, set)
  }
  let summary: string | null = null
  let block: string | null = null
  let vitestFile: string | null = null
  let jestFile: string | null = null
  for (const raw of lines.slice(0, MAX_LINES_PER_ROUND)) {
    const line = clean(raw)
    if (!line.trim()) continue
    const head = PLAYWRIGHT_SUMMARY_HEAD.exec(line)
    if (head) { summary = head[1]; block = null; continue }
    if (summary) {
      const item = PLAYWRIGHT_SUMMARY_ITEM.exec(line)
      if (item) { if (summary === 'flaky') reportedFlaky.add(testName(item[1], item[2]) ?? ''); continue }
      summary = null
    }
    const header = FAILURE_HEADER.exec(line)
    if (header) { block = testName(header[1], header[2]); continue }
    const playwright = PLAYWRIGHT_RESULT.exec(line)
    if (playwright) { block = null; add(testName(playwright[2], playwright[3]), PASS_MARKS.has(playwright[1]) ? 'pass' : 'fail'); continue }
    const vitest = VITEST_RESULT.exec(line)
    if (vitest) { add(testName(vitest[2], vitest[3]), PASS_MARKS.has(vitest[1]) ? 'pass' : 'fail'); continue }
    const vitestFileLine = VITEST_FILE.exec(line)
    if (vitestFileLine) { vitestFile = vitestFileLine[1]; jestFile = null; continue }
    const jestFileLine = JEST_FILE.exec(line)
    if (jestFileLine) { jestFile = jestFileLine[2]; vitestFile = null; continue }
    if (vitestFile) {
      const nested = VITEST_NESTED.exec(line)
      if (nested) { add(testName(vitestFile, nested[2]), PASS_MARKS.has(nested[1]) ? 'pass' : 'fail'); continue }
    }
    if (jestFile) {
      const nested = JEST_RESULT.exec(line)
      if (nested) { add(testName(jestFile, nested[2]), PASS_MARKS.has(nested[1]) ? 'pass' : 'fail'); continue }
    }
    if (block) {
      const text = failureText.get(block) ?? ''
      if (text.length < 4_000) failureText.set(block, `${text}${line.trim()}\n`)
    }
  }
  reportedFlaky.delete('')
  return { outcomes, reportedFlaky, failureText }
}

/** The failing tests of the latest round, and which of them the recorded rounds show to be flaky. */
export function classifyVerificationTests(rounds: readonly VerificationRound[]): VerificationTests {
  const parsed = rounds.map((round) => parseRound(round.lines)).filter((round) => round.outcomes.size > 0 || round.reportedFlaky.size > 0)
  const latest = parsed[parsed.length - 1]
  if (!latest) return { failingTests: [], flakyTests: [], flakyBasis: {}, rounds: 0 }
  const failing = [...latest.outcomes].filter(([, set]) => set.has('fail')).map(([name]) => name)
  const basis: Record<string, FlakyBasis> = {}
  for (const name of new Set([...failing, ...latest.reportedFlaky])) {
    const history = parsed.map((round) => round.outcomes.get(name)).filter((set): set is Set<TestOutcome> => !!set)
    if (latest.reportedFlaky.has(name) || parsed.some((round) => round.reportedFlaky.has(name))) { basis[name] = 'reported'; continue }
    if (history.some((set) => set.size > 1)) { basis[name] = 'mixed'; continue }
    const sequence = history.map((set) => (set.has('fail') ? 'fail' : 'pass'))
    const flips = sequence.slice(1).filter((outcome, index) => outcome !== sequence[index]).length
    if (flips >= 2) { basis[name] = 'alternating'; continue }
    const passedBefore = sequence.slice(0, -1).filter((outcome) => outcome === 'pass').length
    if (sequence[sequence.length - 1] === 'fail' && passedBefore >= 2 && TIMING.test(latest.failureText.get(name) ?? '')) basis[name] = 'timing'
  }
  const flakyTests = Object.keys(basis).slice(0, MAX_FLAKY)
  return {
    failingTests: failing.slice(0, MAX_FAILING),
    flakyTests,
    flakyBasis: Object.fromEntries(flakyTests.map((name) => [name, basis[name]])),
    rounds: parsed.length,
  }
}
