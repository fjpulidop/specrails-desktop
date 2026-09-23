import { describe, it, expect, afterEach } from 'vitest'
import { getModelsForProvider, getProviderDefault, isValidModelForProvider } from './spec-models'
import { syncLocalAdapters } from '../../../providers/local-adapter-registry'
import { unregisterAdapter } from '../../../providers/registry'
import { setCachedProbe, _resetForTests } from '../../../local-engine-detection'
import '../../../providers'

describe('spec-models with a dynamically registered local engine', () => {
  afterEach(() => { unregisterAdapter('local'); _resetForTests() })

  it('reads the adapter catalog + default for unknown-but-registered ids, empty for unknown ids', () => {
    expect(getModelsForProvider('local')).toEqual([])
    expect(getProviderDefault('local')).toBe('')
    syncLocalAdapters([{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://h/v1', defaultModel: 'qwen' }])
    expect(getModelsForProvider('local')).toEqual([{ value: 'qwen', label: 'qwen' }])
    expect(getProviderDefault('local')).toBe('qwen')
    setCachedProbe('local', { reachable: true, installed: true, executable: true, authState: 'authenticated', models: ['a', 'qwen'], latencyMs: 1 })
    expect(getModelsForProvider('local').map((m) => m.value)).toEqual(['a', 'qwen'])
    expect(isValidModelForProvider('a', 'local')).toBe(true)
    expect(isValidModelForProvider('off/catalog:v1', 'local')).toBe(true) // customModelAliases
    expect(isValidModelForProvider('-bad', 'local')).toBe(false)
    // CLI catalogs are untouched.
    expect(getProviderDefault('claude')).toBe('sonnet')
  })
})
