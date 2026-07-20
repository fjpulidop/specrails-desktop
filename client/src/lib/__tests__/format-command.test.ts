import { describe, expect, it } from 'vitest'
import { formatCommandForProvider } from '../format-command'

describe('formatCommandForProvider', () => {
  it('renders both SpecRails aliases with Kimi skill syntax', () => {
    expect(formatCommandForProvider('/specrails:implement #42', 'kimi'))
      .toBe('/skill:specrails-implement #42')
    expect(formatCommandForProvider('then /sr:batch-implement #7', 'kimi'))
      .toBe('then /skill:specrails-batch-implement #7')
  })

  it('retains Codex and Claude display contracts', () => {
    expect(formatCommandForProvider('/specrails:implement #42', 'codex'))
      .toBe('$implement #42')
    expect(formatCommandForProvider('/specrails:implement #42', 'claude'))
      .toBe('/specrails:implement #42')
  })
})
