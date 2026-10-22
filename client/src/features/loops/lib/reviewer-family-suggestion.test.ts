import { describe, expect, it } from 'vitest'
import { effectiveRoleProvider, suggestReviewerProvider } from './reviewer-family-suggestion'

const agents = (developer: string, reviewer: string) => ({ architect: { provider: developer }, developer: { provider: developer }, reviewer: { provider: reviewer } })

describe('suggestReviewerProvider', () => {
  it('needs at least two usable providers', () => {
    expect(suggestReviewerProvider(agents('claude', 'claude'), 'claude', [])).toBeNull()
    expect(suggestReviewerProvider(agents('claude', 'claude'), 'claude', ['claude'])).toBeNull()
    expect(suggestReviewerProvider(agents('claude', 'claude'), 'claude', ['claude', 'claude'])).toBeNull()
  })

  it('pairs Claude and Codex with each other first', () => {
    expect(suggestReviewerProvider(agents('claude', 'claude'), 'claude', ['local-qwen', 'claude', 'codex'])).toBe('codex')
    expect(suggestReviewerProvider(agents('codex', 'codex'), 'claude', ['local-qwen', 'codex', 'claude'])).toBe('claude')
  })

  it('falls back to Gemini, Kimi, then local engines in detection order', () => {
    expect(suggestReviewerProvider(agents('claude', 'claude'), 'claude', ['claude', 'kimi', 'gemini'])).toBe('gemini')
    expect(suggestReviewerProvider(agents('claude', 'claude'), 'claude', ['claude', 'kimi'])).toBe('kimi')
    expect(suggestReviewerProvider(agents('claude', 'claude'), 'claude', ['claude', 'rtx', 'mac'])).toBe('rtx')
    expect(suggestReviewerProvider(agents('rtx', 'rtx'), 'claude', ['rtx', 'mac', 'codex'])).toBe('codex')
  })

  it('resolves inherited roles to the project provider', () => {
    expect(suggestReviewerProvider(agents('inherit', 'inherit'), 'codex', ['claude', 'codex'])).toBe('claude')
    expect(suggestReviewerProvider(agents('inherit', 'codex'), 'codex', ['claude', 'codex'])).toBe('claude')
    expect(effectiveRoleProvider(undefined, 'codex')).toBe('codex')
  })

  it('stays silent when the reviewer already runs on another family', () => {
    expect(suggestReviewerProvider(agents('claude', 'codex'), 'claude', ['claude', 'codex'])).toBeNull()
    expect(suggestReviewerProvider(agents('inherit', 'claude'), 'codex', ['claude', 'codex'])).toBeNull()
  })
})
