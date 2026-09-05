import { describe, it, expect } from 'vitest'
import { LOOP_RUN_MODELS, modelsForProvider, defaultModelForProvider } from '../loop-run-models'

describe('loop-run-models', () => {
  it('exposes an exact catalog for each provider', () => {
    expect(LOOP_RUN_MODELS.claude.map((m) => m.value)).toEqual(['sonnet', 'fable', 'opus', 'haiku'])
    expect(LOOP_RUN_MODELS.codex.map((m) => m.value)).toEqual([
      'gpt-5.5', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
      'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex',
    ])
    expect(LOOP_RUN_MODELS.gemini.map((m) => m.value)).toEqual([
      'gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite',
    ])
  })

  it('default model is each provider catalog first entry', () => {
    expect(defaultModelForProvider('claude')).toBe('sonnet')
    expect(defaultModelForProvider('codex')).toBe('gpt-5.5')
    expect(defaultModelForProvider('gemini')).toBe('gemini-3.5-flash')
  })

  it('returns an empty list / default for an unknown or missing provider', () => {
    expect(modelsForProvider('nope')).toEqual([])
    expect(modelsForProvider(undefined)).toEqual([])
    expect(defaultModelForProvider(null)).toBe('')
  })
})
