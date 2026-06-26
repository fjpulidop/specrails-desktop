import { describe, it, expect } from 'vitest'
import {
  buildDeciderSystemPrompt,
  buildDeciderUserPrompt,
  parseDeciderDecision,
  DECIDER_PROMPT_VERSION,
} from './loop-decider'

describe('decider prompts', () => {
  it('system prompt is byte-stable (no timestamps/randomness)', () => {
    expect(buildDeciderSystemPrompt()).toBe(buildDeciderSystemPrompt())
    expect(buildDeciderSystemPrompt()).toContain('"action":"continue"|"stop"')
  })

  it('user prompt includes the goal and the history', () => {
    const p = buildDeciderUserPrompt({ goal: 'tests pass', history: ['AI: did x', 'Shell exit=1'] })
    expect(p).toContain('LOOP GOAL: tests pass')
    expect(p).toContain('AI: did x')
    expect(p).toContain('Shell exit=1')
  })

  it('user prompt handles empty history', () => {
    expect(buildDeciderUserPrompt({ goal: 'g', history: [] })).toContain('(no output yet)')
  })

  it('exposes a prompt version', () => {
    expect(DECIDER_PROMPT_VERSION).toBe(1)
  })
})

describe('parseDeciderDecision', () => {
  it('parses a clean stop decision', () => {
    const d = parseDeciderDecision('{"action":"stop","reasoning":"all green"}')
    expect(d).toEqual({ continue: false, reasoning: 'all green', parsed: true })
  })

  it('parses a continue decision', () => {
    const d = parseDeciderDecision('{"action":"continue","reasoning":"1 test still failing"}')
    expect(d.continue).toBe(true)
    expect(d.parsed).toBe(true)
  })

  it('extracts the decision even when wrapped in prose', () => {
    const d = parseDeciderDecision('Here is my verdict:\n{"action":"stop","reasoning":"done"}\nThanks!')
    expect(d.continue).toBe(false)
    expect(d.reasoning).toBe('done')
  })

  it('uses the LAST action object when several appear', () => {
    const d = parseDeciderDecision('{"action":"continue"} then finally {"action":"stop","reasoning":"ok"}')
    expect(d.continue).toBe(false)
  })

  it('is case-insensitive on the action value', () => {
    expect(parseDeciderDecision('{"action":"STOP","reasoning":"x"}').continue).toBe(false)
  })

  it('falls back to continue (parsed=false) on unparseable output', () => {
    const d = parseDeciderDecision('I think we should keep going but I am not sure')
    expect(d.continue).toBe(true)
    expect(d.parsed).toBe(false)
  })

  it('falls back to continue when action value is invalid', () => {
    const d = parseDeciderDecision('{"action":"maybe","reasoning":"x"}')
    expect(d.parsed).toBe(false)
    expect(d.continue).toBe(true)
  })
})
