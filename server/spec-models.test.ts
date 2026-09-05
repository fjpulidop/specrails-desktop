import { describe, it, expect } from 'vitest'
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  GEMINI_MODELS,
  KIMI_MODELS,
  getModelsForProvider,
  getProviderDefault,
  isValidModelForProvider,
} from './spec-models'

describe('spec-models', () => {
  it('claude default is in claude allow-list', () => {
    expect(isValidModelForProvider(getProviderDefault('claude'), 'claude')).toBe(true)
  })

  it('codex default is in codex allow-list', () => {
    expect(isValidModelForProvider(getProviderDefault('codex'), 'codex')).toBe(true)
  })

  it('accepts Astra for spec generation without changing the Codex default', () => {
    expect(isValidModelForProvider('gpt-6-astra', 'codex')).toBe(true)
    expect(getModelsForProvider('codex')[0]).toEqual({ value: 'gpt-6-astra', label: 'GPT-6 Astra' })
    expect(getProviderDefault('codex')).toBe('gpt-5.5')
    expect(isValidModelForProvider('gpt-6-astra', 'claude')).toBe(false)
  })

  it('rejects cross-provider models', () => {
    expect(isValidModelForProvider('sonnet', 'codex')).toBe(false)
    expect(isValidModelForProvider('gpt-5.4-mini', 'claude')).toBe(false)
  })

  it('rejects empty / non-string values', () => {
    expect(isValidModelForProvider('', 'claude')).toBe(false)
    expect(isValidModelForProvider(undefined, 'claude')).toBe(false)
    expect(isValidModelForProvider(null, 'claude')).toBe(false)
    expect(isValidModelForProvider(42, 'claude')).toBe(false)
  })

  it('getModelsForProvider returns the matching list', () => {
    expect(getModelsForProvider('claude')).toBe(CLAUDE_MODELS)
    expect(getModelsForProvider('codex')).toBe(CODEX_MODELS)
  })

  it('serves the gemini catalog + default (not the claude fallback)', () => {
    expect(getModelsForProvider('gemini')).toBe(GEMINI_MODELS)
    expect(getProviderDefault('gemini')).toBe('gemini-3.5-flash')
    expect(isValidModelForProvider('gemini-3.5-flash', 'gemini')).toBe(true)
    expect(isValidModelForProvider('sonnet', 'gemini')).toBe(false)
  })

  it('serves the official Kimi catalog with K3 as default', () => {
    expect(getModelsForProvider('kimi')).toBe(KIMI_MODELS)
    expect(getProviderDefault('kimi')).toBe('k3')
    expect(isValidModelForProvider('k3', 'kimi')).toBe(true)
    // Kimi aliases are user-configured names. A token that happens to match
    // another provider's official alias is still a valid Kimi custom alias.
    expect(isValidModelForProvider('sonnet', 'kimi')).toBe(true)
  })

  it('accepts only safe off-catalog aliases for providers that advertise them', () => {
    const alias = 'moonshot-team/private-coder:v2'
    expect(isValidModelForProvider(alias, 'kimi')).toBe(true)
    expect(isValidModelForProvider(alias, 'claude')).toBe(false)
    expect(isValidModelForProvider('--yolo', 'kimi')).toBe(false)
    expect(isValidModelForProvider('moonshot team/coder', 'kimi')).toBe(false)
  })

  it('does not silently substitute Claude for an unknown provider', () => {
    expect(getModelsForProvider('mystery')).toEqual([])
    expect(getProviderDefault('mystery')).toBe('')
  })
})
