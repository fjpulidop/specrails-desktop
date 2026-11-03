import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  INTENT_AGENT_HEADING,
  INTENT_LIST_MAX_ITEMS,
  INTENT_TEXT_MAX_CHARS,
  descriptionWithIntent,
  mergeIntentAnswers,
  normalizeSpecIntent,
  parseIntentDraft,
  openIntentQuestions,
  parseIntentMarkdown,
  renderIntentForAgents,
  renderIntentMarkdown,
  validateSpecIntent,
  type SpecIntent,
} from './intent'

const INTENT: SpecIntent = {
  problem: 'New users abandon setup because it asks for an API key before showing anything.',
  outcome: 'A new user sees a working project before any credential is requested.',
  hypothesis: 'We believe a credential-free first run will raise setup completion; we will know when completion passes 70%.',
  successSignals: ['A new user finishes setup in under 2 minutes', 'Setup completion above 70%'],
  affects: ['First-run users', 'The onboarding wizard'],
  constraints: ['No new runtime dependency', 'Works offline'],
  openQuestions: [{ question: 'Does the sample need network access?' }, { question: 'Which locale is the default?', answer: 'The OS locale.' }],
}

describe('validateSpecIntent', () => {
  it('accepts and normalizes a valid intent', () => {
    const result = validateSpecIntent({ ...INTENT, successSignals: ['- A new user finishes setup in under 2 minutes', 'A new user finishes setup in under 2 minutes', '  '] })
    expect(result).toEqual({ ok: true, intent: { ...INTENT, successSignals: ['A new user finishes setup in under 2 minutes'] } })
  })

  it('names the missing section', () => {
    expect(validateSpecIntent({ ...INTENT, problem: '  ' })).toEqual({ ok: false, error: 'intent.problem is required' })
    expect(validateSpecIntent({ ...INTENT, outcome: undefined })).toEqual({ ok: false, error: 'intent.outcome is required' })
    expect(validateSpecIntent({ ...INTENT, constraints: 'none' })).toEqual({ ok: false, error: 'intent.constraints must be an array' })
    expect(validateSpecIntent('text')).toEqual({ ok: false, error: 'intent must be an object' })
  })

  it('clears with null', () => {
    expect(validateSpecIntent(null)).toEqual({ ok: true, intent: null })
  })

  it('bounds oversized input instead of failing', () => {
    const intent = normalizeSpecIntent({ ...INTENT, problem: 'é'.repeat(INTENT_TEXT_MAX_CHARS + 50), affects: Array.from({ length: 40 }, (_, i) => `item ${i}`) })!
    expect(Array.from(intent.problem)).toHaveLength(INTENT_TEXT_MAX_CHARS)
    expect(intent.affects).toHaveLength(INTENT_LIST_MAX_ITEMS)
  })

  it('accepts open questions as strings and drops empty or duplicate ones', () => {
    expect(normalizeSpecIntent({ ...INTENT, openQuestions: ['Why?', { question: 'Why?' }, { answer: 'orphan' }, ''] })!.openQuestions).toEqual([{ question: 'Why?' }])
  })
})

describe('intent Markdown', () => {
  it('round-trips through the canonical form', () => {
    const markdown = renderIntentMarkdown(INTENT, 'Credential-free first run')
    expect(markdown.startsWith('# Intent: Credential-free first run\n\n## Problem\n')).toBe(true)
    expect(markdown).toContain('## How we will know\n\n- A new user finishes setup in under 2 minutes')
    expect(markdown).toContain('- Which locale is the default?\n  - Answer: The OS locale.')
    expect(parseIntentMarkdown(markdown)).toEqual(INTENT)
  })

  it('omits empty optional sections', () => {
    const markdown = renderIntentMarkdown({ problem: 'P', outcome: 'O', successSignals: [], affects: [], constraints: [], openQuestions: [] })
    expect(markdown).toBe('# Intent\n\n## Problem\n\nP\n\n## Outcome\n\nO\n')
  })

  it('tolerates hand edits: missing optional sections, unknown sections, synonyms', () => {
    const parsed = parseIntentMarkdown('## Problem\nSlow search\n\n## Notes\n- ignored\n\n## Outcome\nResults in 200 ms\n\n## Success signals\n* p95 under 200 ms\n')
    expect(parsed).toEqual({ problem: 'Slow search', outcome: 'Results in 200 ms', successSignals: ['p95 under 200 ms'], affects: [], constraints: [], openQuestions: [] })
  })

  it('returns null without problem or outcome', () => {
    expect(parseIntentMarkdown('## Problem\nOnly a problem\n')).toBeNull()
  })
})

describe('agent briefing', () => {
  it('prepends the intent once and keeps the description', () => {
    const description = descriptionWithIntent('## Acceptance Criteria\n- works', INTENT)
    expect(description.startsWith(INTENT_AGENT_HEADING)).toBe(true)
    expect(description).toContain('### Constraints\n\n- No new runtime dependency')
    expect(description).toContain('Reviewers: this block is context, never a requirement')
    expect(description.endsWith('## Acceptance Criteria\n- works')).toBe(true)
    expect(descriptionWithIntent(description, INTENT)).toBe(description)
  })

  it('leaves specs without an intent unchanged', () => {
    expect(descriptionWithIntent('body', undefined)).toBe('body')
    expect(descriptionWithIntent(null, null)).toBe('')
    expect(renderIntentForAgents(null)).toBe('')
    expect(descriptionWithIntent('', INTENT)).toBe(renderIntentForAgents(INTENT))
  })
})

describe('mergeIntentAnswers', () => {
  it('answers only open questions at a matching index and never edits other sections', () => {
    const merged = mergeIntentAnswers(INTENT, [
      { index: 0, question: 'Does the sample need network access?', answer: 'No, it ships bundled.' },
      { index: 1, answer: 'Overwritten?' },
      { index: 7, answer: 'out of range' },
    ])
    expect(merged.openQuestions).toEqual([
      { question: 'Does the sample need network access?', answer: 'No, it ships bundled.' },
      { question: 'Which locale is the default?', answer: 'The OS locale.' },
    ])
    expect({ ...merged, openQuestions: [] }).toEqual({ ...INTENT, openQuestions: [] })
    expect(openIntentQuestions(INTENT)).toBe(1)
    expect(openIntentQuestions(merged)).toBe(0)
  })

  it('ignores an answer written for a different question', () => {
    expect(mergeIntentAnswers(INTENT, [{ index: 0, question: 'Another question', answer: 'x' }])).toEqual(INTENT)
  })
})

describe('client copy', () => {
  it('client/src/features/specs/lib/spec-intent.ts is byte-identical', () => {
    const server = readFileSync(join(__dirname, 'intent.ts'), 'utf8')
    const client = readFileSync(join(__dirname, '../../../../client/src/features/specs/lib/spec-intent.ts'), 'utf8')
    expect(client).toBe(server)
  })
})

describe('parseIntentDraft', () => {
  const readings = { restated: 'Show a working sample first', alternative: 'Make the API key optional everywhere', discriminator: 'Is this about first run only?' }
  it('accepts an intent with two different readings', () => {
    expect(parseIntentDraft({ ...INTENT, title: ' First run ', readings, ready: true })).toEqual({ title: 'First run', intent: INTENT, readings, ready: true })
    expect(parseIntentDraft({ ...INTENT, readings })!.ready).toBe(false)
  })
  it('rejects a missing intent section, missing or identical readings', () => {
    expect(parseIntentDraft({ ...INTENT, problem: '', readings })).toBeNull()
    expect(parseIntentDraft({ ...INTENT })).toBeNull()
    expect(parseIntentDraft({ ...INTENT, readings: { ...readings, discriminator: ' ' } })).toBeNull()
    expect(parseIntentDraft({ ...INTENT, readings: { ...readings, alternative: readings.restated } })).toBeNull()
    expect(parseIntentDraft([])).toBeNull()
  })
})
