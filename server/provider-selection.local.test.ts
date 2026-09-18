import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { register, _clearForTests } from './providers/registry'
import { claudeAdapter } from './providers/claude-adapter'
import { codexAdapter } from './providers/codex-adapter'
import { syncLocalAdapters } from './providers/local-adapter-registry'
import { setDetectedProvidersSupplier, derivePrimaryProvider, isProviderEnabled, validateRequestedProvider, resolveProvider } from './provider-selection'

const local = { id: 'local', kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:8080/v1' }

describe('provider-selection with local engines', () => {
  beforeEach(() => { _clearForTests(); register(claudeAdapter); register(codexAdapter); syncLocalAdapters([local]) })
  afterEach(() => { setDetectedProvidersSupplier(null); _clearForTests() })

  it('accepts a DETECTED local id and rejects an undetected one with the "not installed" shape', () => {
    setDetectedProvidersSupplier(() => ['claude', 'local'])
    expect(isProviderEnabled({}, 'local')).toBe(true)
    expect(validateRequestedProvider({}, 'local')).toEqual({ ok: true, provider: 'local' })
    setDetectedProvidersSupplier(() => ['claude'])
    expect(isProviderEnabled({}, 'local')).toBe(false)
    expect(validateRequestedProvider({}, 'local')).toEqual({ ok: false, error: "provider 'local' is not installed for this project (installed: claude)" })
    expect(resolveProvider({}, 'local')).toBe('claude')
  })

  it('primary derivation never picks a local id while a CLI is detected', () => {
    setDetectedProvidersSupplier(() => ['local', 'codex'])
    expect(derivePrimaryProvider({ provider: 'local' })).toBe('codex')
    expect(derivePrimaryProvider({})).toBe('codex')
    setDetectedProvidersSupplier(() => ['claude', 'local'])
    expect(derivePrimaryProvider({ provider: 'local' })).toBe('claude')
    expect(validateRequestedProvider({ provider: 'local' }, undefined)).toEqual({ ok: true, provider: 'claude' })
  })

  it('a local-only machine may pick the local id', () => {
    setDetectedProvidersSupplier(() => ['local'])
    expect(derivePrimaryProvider({ provider: 'local' })).toBe('local')
    expect(derivePrimaryProvider({ provider: 'claude' })).toBe('local')
    expect(derivePrimaryProvider({})).toBe('local')
  })

  it('legacy row fallback (no supplier) keeps the stored primary', () => {
    expect(derivePrimaryProvider({ provider: 'kimi', providers: ['kimi'] })).toBe('kimi')
  })
})
