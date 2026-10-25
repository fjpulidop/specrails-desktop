import { describe, it, expect } from 'vitest'
import { formatTokens } from '../format-tokens'
import { modelLabel } from '../model-label'

describe('formatTokens', () => {
  it('compacts with the active locale and never prints "5424.9k"', () => {
    expect(formatTokens(5_424_900, 'en')).toBe('5.4M')
    expect(formatTokens(1_234, 'en')).toBe('1.2K')
    expect(formatTokens(950, 'en')).toBe('950')
    expect(formatTokens(5_424_900, 'es')).not.toMatch(/\./)
    expect(formatTokens(5_424_900, 'es')).toMatch(/5,4/)
    expect(formatTokens(5_424_900, 'de')).toMatch(/5,4/)
  })
})

describe('modelLabel', () => {
  it.each([
    ['sonnet', 'Claude Sonnet'],
    ['opus', 'Claude Opus'],
    ['haiku', 'Claude Haiku'],
    ['sonnet[1m]', 'Claude Sonnet'],
    ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5'],
    ['claude-opus-4', 'Claude Opus 4'],
    ['claude-3-5-haiku-latest', 'Claude Haiku 3.5'],
    ['gpt-6.1-sol', 'GPT-6.1 Sol'],
    ['gpt-5-codex', 'GPT-5 Codex'],
    ['gpt-4o-mini', 'GPT-4o Mini'],
    ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
  ])('maps %s to %s', (slug, label) => {
    expect(modelLabel(slug)).toEqual({ text: label, known: true })
  })

  it('keeps unknown slugs verbatim and flags them', () => {
    expect(modelLabel('mystery-model-7b')).toEqual({ text: 'mystery-model-7b', known: false })
    expect(modelLabel(null)).toEqual({ text: '', known: false })
  })
})
