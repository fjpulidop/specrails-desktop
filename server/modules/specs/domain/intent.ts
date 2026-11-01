/**
 * Spec intent (OpenSpec change `intent-mode`).
 *
 * The intent says WHAT problem a spec solves, WHY and within WHICH limits,
 * never HOW: problem, outcome (with an optional "We believe … we will know
 * when …" hypothesis), success signals, who/what it affects, constraints and
 * open questions. There is deliberately no solution section.
 *
 * Pure rules for the optional top-level ticket field `intent`: validation and
 * bounds, tolerant normalization on read, the canonical Markdown form
 * (`intent.md` in the delivered OpenSpec change) and its tolerant parser, the
 * block every launch door prepends to the description an agent receives, and
 * the deterministic merge of open-question answers at Intent settlement.
 * Zero imports (the architecture test pins domain files to none). The client
 * copy lives at client/src/features/specs/lib/spec-intent.ts and MUST stay
 * byte-identical (a parity test guards it).
 */

export const INTENT_TEXT_MAX_CHARS = 2000
export const INTENT_ITEM_MAX_CHARS = 300
export const INTENT_ANSWER_MAX_CHARS = 1000
export const INTENT_LIST_MAX_ITEMS = 20

export interface SpecIntentQuestion {
  question: string
  /** Absent while the question is open. */
  answer?: string
}

export interface SpecIntent {
  /** The problem worth solving, in the person's words. */
  problem: string
  /** The outcome sought once it is solved. */
  outcome: string
  /** Optional: "We believe X will produce Y; we will know when Z". */
  hypothesis?: string
  /** "How we will know": observable signals that the outcome happened. */
  successSignals: string[]
  /** Who and what the problem and its solution touch. */
  affects: string[]
  /** Limits any solution must respect. */
  constraints: string[]
  /** What nobody knows yet; agents investigate, settlement may answer. */
  openQuestions: SpecIntentQuestion[]
}

export type SpecIntentValidation =
  | { ok: true; intent: SpecIntent | null }
  | { ok: false; error: string }

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return Array.from(text).slice(0, max).join('').trim()
}

function cleanItem(value: unknown, max = INTENT_ITEM_MAX_CHARS): string {
  if (typeof value !== 'string') return ''
  return cleanText(value.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '').replace(/\s+/g, ' '), max)
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const raw of value) {
    const item = cleanItem(raw)
    if (item && !out.includes(item)) out.push(item)
    if (out.length >= INTENT_LIST_MAX_ITEMS) break
  }
  return out
}

function cleanQuestions(value: unknown): SpecIntentQuestion[] {
  if (!Array.isArray(value)) return []
  const out: SpecIntentQuestion[] = []
  for (const raw of value) {
    const entry = typeof raw === 'string' ? { question: raw } : raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
    if (!entry) continue
    const question = cleanItem(entry.question)
    if (!question || out.some((item) => item.question === question)) continue
    const answer = cleanText(entry.answer, INTENT_ANSWER_MAX_CHARS)
    out.push(answer ? { question, answer } : { question })
    if (out.length >= INTENT_LIST_MAX_ITEMS) break
  }
  return out
}

/**
 * Tolerant normalization used on read and before validation: never throws,
 * never invents. Returns null when the value cannot be an intent (no problem
 * or no outcome).
 */
export function normalizeSpecIntent(value: unknown): SpecIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const problem = cleanText(raw.problem, INTENT_TEXT_MAX_CHARS)
  const outcome = cleanText(raw.outcome, INTENT_TEXT_MAX_CHARS)
  if (!problem || !outcome) return null
  const hypothesis = cleanText(raw.hypothesis, INTENT_TEXT_MAX_CHARS)
  return {
    problem,
    outcome,
    ...(hypothesis ? { hypothesis } : {}),
    successSignals: cleanList(raw.successSignals),
    affects: cleanList(raw.affects),
    constraints: cleanList(raw.constraints),
    openQuestions: cleanQuestions(raw.openQuestions),
  }
}

/**
 * Validate a caller-supplied intent (HTTP, MCP, the intent-draft fence).
 * `null` clears the field. The error names the missing section.
 */
export function validateSpecIntent(value: unknown): SpecIntentValidation {
  if (value === null) return { ok: true, intent: null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'intent must be an object' }
  const raw = value as Record<string, unknown>
  for (const key of ['successSignals', 'affects', 'constraints', 'openQuestions'] as const) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) return { ok: false, error: `intent.${key} must be an array` }
  }
  if (!cleanText(raw.problem, INTENT_TEXT_MAX_CHARS)) return { ok: false, error: 'intent.problem is required' }
  if (!cleanText(raw.outcome, INTENT_TEXT_MAX_CHARS)) return { ok: false, error: 'intent.outcome is required' }
  return { ok: true, intent: normalizeSpecIntent(value)! }
}

/** Open questions still waiting for an answer. */
export function openIntentQuestions(intent: SpecIntent | null | undefined): number {
  return intent ? intent.openQuestions.filter((item) => !item.answer).length : 0
}

const HEADINGS = {
  problem: 'Problem',
  outcome: 'Outcome',
  hypothesis: 'Hypothesis',
  successSignals: 'How we will know',
  affects: 'Who and what it affects',
  constraints: 'Constraints',
  openQuestions: 'Open questions',
} as const

type IntentSection = keyof typeof HEADINGS

function sectionLines(intent: SpecIntent, level: string): string[] {
  const out: string[] = []
  const push = (section: IntentSection, body: string) => { out.push(`${level} ${HEADINGS[section]}`, '', body, '') }
  push('problem', intent.problem)
  push('outcome', intent.outcome)
  if (intent.hypothesis) push('hypothesis', intent.hypothesis)
  if (intent.successSignals.length) push('successSignals', intent.successSignals.map((item) => `- ${item}`).join('\n'))
  if (intent.affects.length) push('affects', intent.affects.map((item) => `- ${item}`).join('\n'))
  if (intent.constraints.length) push('constraints', intent.constraints.map((item) => `- ${item}`).join('\n'))
  if (intent.openQuestions.length) {
    push('openQuestions', intent.openQuestions.map((item) => item.answer
      ? `- ${item.question}\n  - Answer: ${item.answer.replace(/\n+/g, ' ')}`
      : `- ${item.question}`).join('\n'))
  }
  return out
}

/** The canonical `intent.md`: `# Intent: <title>` then one `##` per section. */
export function renderIntentMarkdown(intent: SpecIntent, title?: string | null): string {
  const heading = cleanItem(title ?? '') ? `# Intent: ${cleanItem(title ?? '')}` : '# Intent'
  return [heading, '', ...sectionLines(intent, '##')].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function sectionFor(heading: string): IntentSection | null {
  const key = heading.trim().toLowerCase().replace(/[:.]+$/, '')
  for (const [section, label] of Object.entries(HEADINGS) as Array<[IntentSection, string]>) {
    if (label.toLowerCase() === key) return section
  }
  if (key === 'success signals' || key === 'how we will know it worked') return 'successSignals'
  if (key === 'affects' || key === 'who it affects') return 'affects'
  return null
}

/**
 * Parse an `intent.md` (or the agent-facing block). Tolerates a missing
 * title, missing optional sections and unknown sections (ignored). Returns
 * null when problem or outcome is absent.
 */
export function parseIntentMarkdown(markdown: string): SpecIntent | null {
  const buckets = new Map<IntentSection, string[]>()
  let current: IntentSection | null = null
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line)
    if (heading) { current = sectionFor(heading[1]); continue }
    if (/^#\s/.test(line)) { current = null; continue }
    if (current) buckets.set(current, [...(buckets.get(current) ?? []), line])
  }
  const text = (section: IntentSection) => (buckets.get(section) ?? []).join('\n').trim()
  const items = (section: IntentSection) => (buckets.get(section) ?? []).filter((line) => /^\s*[-*+]\s+/.test(line)).map((line) => line.replace(/^\s*[-*+]\s+/, ''))
  const questions: SpecIntentQuestion[] = []
  for (const line of buckets.get('openQuestions') ?? []) {
    const answer = /^\s+[-*+]?\s*Answer:\s*(.+)$/i.exec(line)
    if (answer && questions.length) { questions[questions.length - 1].answer = answer[1]; continue }
    const question = /^[-*+]\s+(.+)$/.exec(line)
    if (question) questions.push({ question: question[1] })
  }
  return normalizeSpecIntent({
    problem: text('problem'),
    outcome: text('outcome'),
    hypothesis: text('hypothesis'),
    successSignals: items('successSignals'),
    affects: items('affects'),
    constraints: items('constraints'),
    openQuestions: questions,
  })
}

/** Heading of the block agents receive; also how a duplicate is detected. */
export const INTENT_AGENT_HEADING = '## Intent (source of truth for why and for the outcome, never for how)'

/** The intent block every agent receives ('' when the spec has no intent). */
export function renderIntentForAgents(intent: SpecIntent | null | undefined): string {
  if (!intent) return ''
  return [
    INTENT_AGENT_HEADING,
    '',
    ...sectionLines(intent, '###'),
    'Honour every constraint. Investigate the open questions instead of guessing. Reviewers: judge the work against the Outcome and "How we will know" as well as the acceptance criteria.',
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The description an agent receives: the intent block first, then the stored
 * description. A description that already carries the block (a re-read of an
 * agent briefing) is returned unchanged — never duplicated.
 */
export function descriptionWithIntent(description: string | null | undefined, intent: SpecIntent | null | undefined): string {
  const body = description ?? ''
  const block = renderIntentForAgents(intent)
  if (!block || body.includes(INTENT_AGENT_HEADING)) return body
  return body.trim() ? `${block}\n\n${body.trimStart()}` : block
}

export interface IntentAnswer {
  /** 0-based index into `openQuestions`. */
  index: number
  /** The question text the answer was written for (must match). */
  question?: string
  answer: string
}

/**
 * Merge answers produced at settlement into the intent: only into an
 * existing, still-open question at that index whose text matches (when
 * given). Problem, outcome, signals, affects and constraints never change.
 */
export function mergeIntentAnswers(intent: SpecIntent, answers: readonly IntentAnswer[]): SpecIntent {
  const openQuestions = intent.openQuestions.map((item) => ({ ...item }))
  for (const entry of answers) {
    if (!entry || !Number.isInteger(entry.index)) continue
    const target = openQuestions[entry.index]
    if (!target || target.answer) continue
    if (entry.question !== undefined && cleanItem(entry.question) !== target.question) continue
    const answer = cleanText(entry.answer, INTENT_ANSWER_MAX_CHARS)
    if (answer) target.answer = answer
  }
  return { ...intent, openQuestions }
}

/** The two readings of the request an intent-draft carries (the framing discipline). */
export interface IntentReadings {
  restated: string
  alternative: string
  /** The question whose answer picks between the readings. */
  discriminator: string
}

/** The operator agent's ```intent-draft snapshot: an intent plus its readings. */
export interface IntentDraft {
  /** Optional short spec title proposed by the agent. */
  title?: string
  intent: SpecIntent
  readings: IntentReadings
  /** The agent judges the intent settled: the card offers Explore and Delegate. */
  ready: boolean
}

/**
 * Validate one parsed ```intent-draft payload: a usable intent (problem and
 * outcome) and two non-empty, different readings with their discriminating
 * question. Shared by the server gate and the client card (same file).
 */
export function parseIntentDraft(value: unknown): IntentDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const intent = normalizeSpecIntent(raw)
  if (!intent) return null
  const readings = raw.readings && typeof raw.readings === 'object' && !Array.isArray(raw.readings) ? raw.readings as Record<string, unknown> : null
  if (!readings) return null
  const restated = cleanText(readings.restated, INTENT_TEXT_MAX_CHARS)
  const alternative = cleanText(readings.alternative, INTENT_TEXT_MAX_CHARS)
  const discriminator = cleanText(readings.discriminator, INTENT_ITEM_MAX_CHARS)
  // Byte-identical readings ARE the same reading: the one degenerate case
  // that can be judged deterministically (as for the legacy problem-frame).
  if (!restated || !alternative || !discriminator || restated === alternative) return null
  const title = cleanItem(raw.title, 200)
  return { ...(title ? { title } : {}), intent, readings: { restated, alternative, discriminator }, ready: raw.ready === true }
}
