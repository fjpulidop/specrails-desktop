import { describe, it, expect, beforeEach } from 'vitest'
import { modelsForProvider, defaultModelForProvider, registerDynamicModelCatalog, resetDynamicModelCatalogs } from '../loop-run-models'
import { isLocalEngineId, providerSupportsToolPolicy, providerSupportsPureOutput, providerSupportsProfiles, providerSupportsStructuredActions, providerSupportsReasoningEffort, providerSupportsFreestyle, providerSupportsCustomModelAliases, providerLabel } from '../provider-capabilities'
import { isRuntimeProvidersResponse, runtimeProviderDisplayName, isLocalRuntimeProvider, isAgentRuntimeSettingsResponse } from '../agent-runtime'
import { FEATURE_LOCAL_ENGINES, isLocalEnginesEnabled } from '../feature-flags'

beforeEach(() => resetDynamicModelCatalogs())

describe('local engine fallbacks', () => {
  it('modelsForProvider never throws for an unknown id and reads the dynamic catalog once registered', () => {
    expect(modelsForProvider('lan-box')).toEqual([])
    registerDynamicModelCatalog('lan-box', ['qwen', 'qwen', ' ', 'llama'])
    expect(modelsForProvider('lan-box')).toEqual([{ value: 'qwen', label: 'qwen' }, { value: 'llama', label: 'llama' }])
    expect(defaultModelForProvider('lan-box')).toBe('qwen')
    // Static catalogs win over dynamic ones; empty registration clears.
    registerDynamicModelCatalog('claude', ['x'])
    expect(modelsForProvider('claude')[0].value).toBe('sonnet')
    registerDynamicModelCatalog('lan-box', [])
    expect(modelsForProvider('lan-box')).toEqual([])
    registerDynamicModelCatalog('', ['x'])
    expect(modelsForProvider('')).toEqual([])
  })

  it('treats unknown ids as local engines with the runner capability block', () => {
    expect(isLocalEngineId('lan-box')).toBe(true)
    expect(isLocalEngineId('claude')).toBe(false)
    expect(isLocalEngineId('')).toBe(false)
    expect(isLocalEngineId(null)).toBe(false)
    expect(providerSupportsCustomModelAliases('lan-box')).toBe(true)
    expect(providerSupportsStructuredActions('lan-box')).toBe(false)
    expect(providerSupportsProfiles('lan-box')).toBe(false)
    expect(providerSupportsFreestyle('lan-box')).toBe(true)
    expect(providerSupportsReasoningEffort('lan-box')).toBe(false)
    expect(providerSupportsToolPolicy('lan-box', 'none')).toBe(true)
    expect(providerSupportsToolPolicy('lan-box', 'read-only')).toBe(true)
    expect(providerSupportsPureOutput('lan-box')).toBe(true)
    expect(providerSupportsToolPolicy(null, 'none')).toBe(false)
    expect(providerLabel('lan-box')).toBe('lan-box')
  })

  it('validates the runtime-providers response shape and derives display names', () => {
    expect(isRuntimeProvidersResponse({ providers: [{ id: 'a', kind: 'cli', cli: 'claude' }] })).toBe(true)
    expect(isRuntimeProvidersResponse({ providers: [{ id: 'a', kind: 'cli' }], status: {} })).toBe(true)
    expect(isRuntimeProvidersResponse({ providers: [{ id: 'a', kind: 'weird' }] })).toBe(false)
    expect(isRuntimeProvidersResponse({ providers: [], status: 'x' })).toBe(false)
    expect(isRuntimeProvidersResponse(null)).toBe(false)
    expect(isRuntimeProvidersResponse({})).toBe(false)
    const local = { id: 'local', kind: 'openai-compatible' as const, baseUrl: 'http://x', label: ' LAN ' }
    expect(isLocalRuntimeProvider(local)).toBe(true)
    expect(runtimeProviderDisplayName(local)).toBe('LAN')
    expect(runtimeProviderDisplayName({ ...local, label: '  ' })).toBe('local')
    expect(runtimeProviderDisplayName({ id: 'claude', kind: 'cli', cli: 'claude' })).toBe('claude')
    // Additive fields do not break the settings guard.
    expect(isAgentRuntimeSettingsResponse({ configured: true, runtimeAvailable: true, config: { schemaVersion: 1, enabled: true, providers: [{ ...local, defaultModel: 'm', rates: { inputPer1M: 1, outputPer1M: 2 } }], verification: [], agents: { architect: { provider: 'local' }, developer: { provider: 'local' }, reviewer: { provider: 'local' } } } })).toBe(true)
  })

  it('exposes the local engines client flag (default on)', () => {
    expect(FEATURE_LOCAL_ENGINES).toBe(true)
    expect(isLocalEnginesEnabled()).toBe(true)
  })
})
