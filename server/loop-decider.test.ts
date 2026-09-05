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

  it('includes the spec so completeness is judged against full scope, not a self-reported claim', () => {
    const p = buildDeciderUserPrompt({
      goal: 'every behavior implemented',
      history: ['AI Step: VERIFICATION: PASS'],
      spec: { title: 'Flappy Bird', description: 'Bird falls under gravity; Space flaps; pipes scroll; score on pass.' },
    })
    expect(p).toContain('SPEC BEING IMPLEMENTED')
    expect(p).toContain('Flappy Bird')
    expect(p).toContain('pipes scroll')
    expect(p).toContain('do not stop just because a step claimed success')
    // the system prompt reinforces the same stance
    expect(buildDeciderSystemPrompt()).toContain('is NOT proof on its own')
  })

  it('omits the spec block when no spec is provided (back-compat)', () => {
    const p = buildDeciderUserPrompt({ goal: 'g', history: ['x'] })
    expect(p).not.toContain('SPEC BEING IMPLEMENTED')
  })

  it('caps a huge spec description', () => {
    const big = 'x'.repeat(5000)
    const p = buildDeciderUserPrompt({ goal: 'g', history: [], spec: { description: big } })
    expect(p).toContain('…')
    expect(p.length).toBeLessThan(3000)
  })

  it('judges every spec in a batch, retaining later tickets after a long first description', () => {
    const p = buildDeciderUserPrompt({
      goal: 'all complete', history: [],
      spec: { tickets: [
        { id: 1, title: 'API', description: 'x'.repeat(5000) + 'API acceptance criteria' },
        { id: 2, title: 'UI', description: 'Show the new data' },
        { id: 3, title: 'Tests', description: 'Add regression coverage' },
      ] },
    })
    expect(p).toContain('every listed spec must be complete')
    expect(p).toContain('API acceptance criteria')
    expect(p).toContain('Spec #2: UI')
    expect(p).toContain('Show the new data')
    expect(p).toContain('Spec #3: Tests')
    expect(p).toContain('Add regression coverage')
  })

  it('exposes a prompt version', () => {
    expect(DECIDER_PROMPT_VERSION).toBe(3)
  })
})

describe('parseDeciderDecision', () => {
  it('parses a clean stop decision', () => {
    const d = parseDeciderDecision('{"action":"stop","reasoning":"all green"}')
    expect(d).toEqual({ continue: false, blocked: false, reasoning: 'all green', parsed: true })
  })

  it('parses a blocked decision (halts on a human decision, not success)', () => {
    const d = parseDeciderDecision('{"action":"blocked","reasoning":"needs a scope call on Supabase"}')
    expect(d).toEqual({ continue: false, blocked: true, reasoning: 'needs a scope call on Supabase', parsed: true })
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
