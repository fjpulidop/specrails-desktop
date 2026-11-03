// Pure parsing of a generate-spec LLM response (the `## Spec Title` /
// `## Labels` / `## Estimated Complexity` / `## Short Summary` markdown
// contract the spec-generation system prompt requests). No IO.
import { clampShortSummary } from './ticket-store'
import { extractOutOfScopeSection } from '../domain/non-goals'
import { normalizeSpecIntent, type IntentAnswer, type SpecIntent } from '../domain/intent'

/**
 * Strip the metadata sections (Spec Title, Labels, Estimated Complexity,
 * Short Summary) from a generate-spec LLM response so they don't end up
 * duplicated inside the ticket's description — they're already parsed into
 * dedicated fields and re-rendered by the UI.
 */
export function stripSpecMetadataSections(buffer: string): string {
  return buffer
    .replace(/##\s*Spec Title\s*\n+[^\n]*\n*/i, '')
    .replace(/##\s*Labels\s*\n+(?:[^\n]+(?:\n(?!##)[^\n]+)*)\n*/i, '')
    .replace(/##\s*Estimated Complexity\s*\n+(?:[^\n]+(?:\n(?!##)[^\n]+)*)\n*/i, '')
    .replace(/##\s*Short Summary\s*\n+(?:[^\n]+(?:\n(?!##)[^\n]+)*)\n*/i, '')
    .trim()
}

/**
 * Extract the `## Short Summary` section body from a generate-spec response.
 * Returns the raw multi-line string (the ticket-store `clampShortSummary`
 * helper applies trim, control-strip, and the 240-char hard cap before
 * persistence). Returns `null` when the section is missing or empty.
 */
export function extractShortSummary(buffer: string): string | null {
  const m = buffer.match(/##\s*Short Summary\s*\n+((?:(?!##)[^\n]+(?:\n(?!##)[^\n]+)*))/i)
  if (!m) return null
  const body = m[1].trim()
  return body.length > 0 ? body : null
}

export interface GeneratedSpec {
  title: string
  /** Mapped from `## Estimated Complexity` (low → low, high/very → high, else medium). */
  priority: 'low' | 'medium' | 'high'
  /** Always starts with the `spec-proposal` marker label. */
  labels: string[]
  shortSummary: string | null
  /** The response minus metadata sections and the `## Out of Scope` section
   *  (keeps Problem Statement, Proposed Solution, Acceptance Criteria,
   *  Technical Considerations). */
  description: string
  /** The `## Out of Scope` bullets, moved to the ticket's `nonGoals` field
   *  (feedback-2026-10 task 3.2). Empty when the model wrote none. */
  nonGoals: string[]
  /** The `## Intent` JSON block of an intent-first generation (intent-mode); null when absent or unusable. */
  intent: SpecIntent | null
  /** The `## Intent Answers` JSON block of a settlement rewrite: answers to the kept intent's open questions. */
  intentAnswers: IntentAnswer[]
}

const INTENT_SECTION_RE = /##\s*Intent\s*\n+```(?:json)?[^\S\n]*\n([\s\S]*?)\n```[^\n]*\n*/i
const INTENT_ANSWERS_SECTION_RE = /##\s*Intent Answers\s*\n+```(?:json)?[^\S\n]*\n([\s\S]*?)\n```[^\n]*\n*/i

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/**
 * Pull the `## Intent` and `## Intent Answers` JSON sections (intent-mode) out
 * of a generate-spec response. They are protocol, never spec content: the
 * returned buffer no longer carries them.
 */
export function extractIntentSections(buffer: string): { buffer: string; intent: SpecIntent | null; intentAnswers: IntentAnswer[] } {
  const answersMatch = buffer.match(INTENT_ANSWERS_SECTION_RE)
  let rest = answersMatch ? buffer.replace(answersMatch[0], '') : buffer
  const intentMatch = rest.match(INTENT_SECTION_RE)
  if (intentMatch) rest = rest.replace(intentMatch[0], '')
  const answers = parseJson(answersMatch?.[1])
  const intentAnswers = Array.isArray(answers)
    ? answers.filter((entry): entry is IntentAnswer => !!entry && typeof entry === 'object' && Number.isInteger((entry as IntentAnswer).index) && typeof (entry as IntentAnswer).answer === 'string')
      .map((entry) => ({ index: entry.index, answer: entry.answer, ...(typeof entry.question === 'string' ? { question: entry.question } : {}) }))
    : []
  return { buffer: rest, intent: normalizeSpecIntent(parseJson(intentMatch?.[1])), intentAnswers }
}

/** True when the response carries the `## Spec Title` contract heading. */
export function hasGeneratedSpecTitle(buffer: string): boolean {
  return /##\s*Spec Title/i.test(buffer)
}

/**
 * Parse a generate-spec response into ticket fields. `fallbackTitle` is used
 * when the `## Spec Title` section is absent (the route uses the idea's first
 * 80 characters).
 */
export function parseGeneratedSpec(response: string, fallbackTitle: string): GeneratedSpec {
  const { buffer, intent, intentAnswers } = extractIntentSections(response)
  const titleMatch = buffer.match(/##\s*Spec Title\s*\n+(.+)/)
  const title = titleMatch ? titleMatch[1].trim() : fallbackTitle

  const complexityMatch = buffer.match(/##\s*Estimated Complexity\s*\n+(\w+)/)
  const complexity = complexityMatch ? complexityMatch[1].toLowerCase() : 'medium'
  const priority = complexity === 'low' ? 'low' : complexity === 'high' || complexity === 'very' ? 'high' : 'medium'

  // Comma- or newline-separated tags, normalised to lowercase kebab-case.
  // `spec-proposal` is always retained as the marker label.
  const labelsMatch = buffer.match(/##\s*Labels\s*\n+([^\n]+(?:\n(?!##)[^\n]+)*)/)
  const modelLabels: string[] = labelsMatch
    ? labelsMatch[1]
        .replace(/[\[\]]/g, '')
        .split(/[,\n]/)
        .map((s) => s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))
        .filter((s) => s.length > 0 && s.length <= 32)
        .slice(0, 6)
    : []
  const labels = Array.from(new Set(['spec-proposal', ...modelLabels]))

  const { description, nonGoals } = extractOutOfScopeSection(stripSpecMetadataSections(buffer))
  return {
    title,
    priority,
    labels,
    shortSummary: clampShortSummary(extractShortSummary(buffer)),
    description,
    nonGoals,
    intent,
    intentAnswers,
  }
}
