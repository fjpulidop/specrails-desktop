import { describe, it, expect } from 'vitest'
import {
  isSmashCapable,
  providerSupportsSection,
  sectionVisibleForProviders,
  isMultiProvider,
  providerLabel,
  providerSupportsReasoningEffort,
} from '../provider-capabilities'

describe('isSmashCapable', () => {
  it('returns true for claude', () => {
    expect(isSmashCapable('claude')).toBe(true)
  })

  it('returns false for codex', () => {
    expect(isSmashCapable('codex')).toBe(false)
  })

  it('returns false for null (provider not yet resolved)', () => {
    expect(isSmashCapable(null)).toBe(false)
  })

  it('returns false for undefined (provider not yet resolved)', () => {
    expect(isSmashCapable(undefined)).toBe(false)
  })

  it('returns false for an unknown provider string', () => {
    expect(isSmashCapable('openai')).toBe(false)
    expect(isSmashCapable('gemini')).toBe(false)
    expect(isSmashCapable('')).toBe(false)
  })
})

describe('providerSupportsSection', () => {
  it('always-visible sections return true for claude', () => {
    expect(providerSupportsSection('claude', 'dashboard')).toBe(true)
    expect(providerSupportsSection('claude', 'jobs')).toBe(true)
    expect(providerSupportsSection('claude', 'analytics')).toBe(true)
    expect(providerSupportsSection('claude', 'code')).toBe(true)
    expect(providerSupportsSection('claude', 'settings')).toBe(true)
  })

  it('always-visible sections return true for codex', () => {
    expect(providerSupportsSection('codex', 'dashboard')).toBe(true)
    expect(providerSupportsSection('codex', 'jobs')).toBe(true)
    expect(providerSupportsSection('codex', 'analytics')).toBe(true)
    expect(providerSupportsSection('codex', 'code')).toBe(true)
    expect(providerSupportsSection('codex', 'settings')).toBe(true)
  })

  it('always-visible sections return true for unknown / null / undefined', () => {
    expect(providerSupportsSection(null, 'dashboard')).toBe(true)
    expect(providerSupportsSection(undefined, 'jobs')).toBe(true)
    expect(providerSupportsSection('openai', 'analytics')).toBe(true)
  })

  it('claude supports agents and integrations', () => {
    expect(providerSupportsSection('claude', 'agents')).toBe(true)
    expect(providerSupportsSection('claude', 'integrations')).toBe(true)
  })

  it('codex does NOT support agents, but DOES support integrations (Jira)', () => {
    expect(providerSupportsSection('codex', 'agents')).toBe(false)
    // integrations now hosts the provider-agnostic Jira card → visible on Codex.
    expect(providerSupportsSection('codex', 'integrations')).toBe(true)
  })

  it('null/undefined does NOT support the claude-only agents section', () => {
    expect(providerSupportsSection(null, 'agents')).toBe(false)
    expect(providerSupportsSection(undefined, 'agents')).toBe(false)
    // integrations is no longer claude-only.
    expect(providerSupportsSection(undefined, 'integrations')).toBe(true)
  })

  it('unknown provider does NOT support the claude-only agents section', () => {
    expect(providerSupportsSection('openai', 'agents')).toBe(false)
    expect(providerSupportsSection('', 'integrations')).toBe(true)
  })
})

describe('sectionVisibleForProviders', () => {
  it('always-visible sections are true for any provider list', () => {
    for (const section of ['dashboard', 'jobs', 'analytics', 'code', 'settings'] as const) {
      expect(sectionVisibleForProviders(section, ['claude'])).toBe(true)
      expect(sectionVisibleForProviders(section, ['codex'])).toBe(true)
      expect(sectionVisibleForProviders(section, ['claude', 'codex'])).toBe(true)
    }
  })

  it('claude-only project shows agents and integrations', () => {
    expect(sectionVisibleForProviders('agents', ['claude'])).toBe(true)
    expect(sectionVisibleForProviders('integrations', ['claude'])).toBe(true)
  })

  it('codex-only project hides agents but shows integrations (Jira)', () => {
    expect(sectionVisibleForProviders('agents', ['codex'])).toBe(false)
    expect(sectionVisibleForProviders('integrations', ['codex'])).toBe(true)
  })

  it('[claude, codex] multi-provider hides agents (intersection) but shows integrations', () => {
    expect(sectionVisibleForProviders('agents', ['claude', 'codex'])).toBe(false)
    expect(sectionVisibleForProviders('integrations', ['claude', 'codex'])).toBe(true)
  })

  it('empty array defaults to claude (everything visible)', () => {
    expect(sectionVisibleForProviders('agents', [])).toBe(true)
    expect(sectionVisibleForProviders('integrations', [])).toBe(true)
  })

  it('null defaults to claude (everything visible)', () => {
    expect(sectionVisibleForProviders('agents', null)).toBe(true)
    expect(sectionVisibleForProviders('integrations', null)).toBe(true)
  })

  it('undefined defaults to claude (everything visible)', () => {
    expect(sectionVisibleForProviders('agents', undefined)).toBe(true)
    expect(sectionVisibleForProviders('integrations', undefined)).toBe(true)
  })
})

describe('isMultiProvider', () => {
  it('returns false for a single-provider list', () => {
    expect(isMultiProvider(['claude'])).toBe(false)
    expect(isMultiProvider(['codex'])).toBe(false)
  })

  it('returns true for more than one provider', () => {
    expect(isMultiProvider(['claude', 'codex'])).toBe(true)
    expect(isMultiProvider(['claude', 'codex', 'openai'])).toBe(true)
  })

  it('returns false for an empty array', () => {
    expect(isMultiProvider([])).toBe(false)
  })

  it('returns false for null', () => {
    expect(isMultiProvider(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isMultiProvider(undefined)).toBe(false)
  })
})

describe('providerLabel', () => {
  it('returns "Claude" for provider "claude"', () => {
    expect(providerLabel('claude')).toBe('Claude')
  })

  it('returns "Codex" for provider "codex"', () => {
    expect(providerLabel('codex')).toBe('Codex')
  })

  it('returns "Gemini" for provider "gemini"', () => {
    expect(providerLabel('gemini')).toBe('Gemini')
  })

  it('returns the raw string for an unknown provider', () => {
    expect(providerLabel('openai')).toBe('openai')
    expect(providerLabel('')).toBe('')
  })

  it('returns "Claude" for null (backward-compat default)', () => {
    expect(providerLabel(null)).toBe('Claude')
  })

  it('returns "Claude" for undefined (backward-compat default)', () => {
    expect(providerLabel(undefined)).toBe('Claude')
  })
})

describe('providerSupportsReasoningEffort', () => {
  it('codex supports it (native -c model_reasoning_effort)', () => {
    expect(providerSupportsReasoningEffort('codex')).toBe(true)
  })
  it('claude supports it (soft thinking-directive)', () => {
    expect(providerSupportsReasoningEffort('claude')).toBe(true)
  })
  it('gemini does NOT (no per-invocation CLI mechanism)', () => {
    expect(providerSupportsReasoningEffort('gemini')).toBe(false)
  })
  it('unknown / null / undefined → false (hide rather than offer a no-op)', () => {
    expect(providerSupportsReasoningEffort('mystery')).toBe(false)
    expect(providerSupportsReasoningEffort(null)).toBe(false)
    expect(providerSupportsReasoningEffort(undefined)).toBe(false)
  })
})
