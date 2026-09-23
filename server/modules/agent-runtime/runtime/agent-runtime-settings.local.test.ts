// Desktop-only additive connection fields + the reserved CLI id guard + what
// reaches Core (byte-identical vendored schema ⇒ extras must be stripped).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { register, _clearForTests } from '../../../providers/registry'
import { claudeAdapter } from '../../../providers/claude-adapter'
import { syncLocalAdapters } from '../../../providers/local-adapter-registry'
import { validateRuntimeProviders, saveRuntimeProviders, loadRuntimeProviders, stripDesktopConnectionFields, coreConnectionFieldGates, forCoreRuntime, validateAgentRuntimeConfig, defaultAgentRuntimeConfig } from './agent-runtime-settings'
import { resolveEffectiveRuntimeConfig } from './agent-runtime-effective-config'

const cli = { id: 'claude', kind: 'cli' as const, cli: 'claude' as const }
const local = { id: 'local', kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'LOCAL_KEY' }
const rich = { ...local, label: 'LAN box', defaultModel: 'qwen3.5-9b:latest', rates: { inputPer1M: 0.1, outputPer1M: 0.4 }, supportsReasoningEffort: true }

describe('runtime provider connections — desktop additive fields', () => {
  let dir: string
  beforeEach(() => {
    _clearForTests(); register(claudeAdapter)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-providers-'))
    vi.spyOn(os, 'homedir').mockReturnValue(dir)
  })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); _clearForTests() })

  it('accepts label/defaultModel/rates/supportsReasoningEffort and round-trips them through save/load', () => {
    expect(validateRuntimeProviders([cli, rich])).toEqual([cli, rich])
    saveRuntimeProviders([cli, rich])
    expect(loadRuntimeProviders()).toEqual([cli, rich])
    // Legacy file loads unchanged.
    saveRuntimeProviders([cli, local])
    expect(loadRuntimeProviders()).toEqual([cli, local])
  })

  it.each([
    ['label too long', { label: 'x'.repeat(65) }, '/providers/1/label'],
    ['blank label', { label: '   ' }, '/providers/1/label'],
    ['label type', { label: 5 }, '/providers/1/label'],
    ['defaultModel leading dash', { defaultModel: '-m' }, '/providers/1/defaultModel'],
    ['defaultModel control char', { defaultModel: 'a\nb' }, '/providers/1/defaultModel'],
    ['defaultModel too long', { defaultModel: 'm'.repeat(257) }, '/providers/1/defaultModel'],
    ['rates negative', { rates: { inputPer1M: -1, outputPer1M: 0 } }, '/providers/1/rates/inputPer1M'],
    ['rates NaN', { rates: { inputPer1M: 0, outputPer1M: Number.NaN } }, '/providers/1/rates/outputPer1M'],
    ['rates missing key', { rates: { inputPer1M: 1 } }, '/providers/1/rates/outputPer1M'],
    ['rates extra key', { rates: { inputPer1M: 1, outputPer1M: 1, x: 1 } }, '/providers/1/rates'],
    ['rates array', { rates: [1, 2] }, '/providers/1/rates'],
    ['effort flag type', { supportsReasoningEffort: 'yes' }, '/providers/1/supportsReasoningEffort'],
  ])('rejects %s', (_label, patch, at) => {
    expect(() => validateRuntimeProviders([cli, { ...local, ...patch }])).toThrow(at)
  })

  it('rejects a connection id equal to a registered CLI adapter id, naming it', () => {
    expect(() => validateRuntimeProviders([{ ...local, id: 'claude' }])).toThrow("Provider id 'claude' is reserved for the claude CLI adapter")
    // A previously registered LOCAL adapter under the same id is fine (re-save).
    syncLocalAdapters([local])
    expect(validateRuntimeProviders([cli, local])).toHaveLength(2)
  })

  it('zero rates are legal (a free endpoint is honest, not a guess)', () => {
    expect(validateRuntimeProviders([cli, { ...local, rates: { inputPer1M: 0, outputPer1M: 0 } }])[1]).toMatchObject({ rates: { inputPer1M: 0, outputPer1M: 0 } })
  })

  it('stripDesktopConnectionFields yields the Core-shaped entries only', () => {
    expect(stripDesktopConnectionFields([cli, rich])).toEqual([cli, local])
    // The stripped list is what Core's key-allowlist validator accepts.
    const stripped = stripDesktopConnectionFields([cli, rich])[1] as Record<string, unknown>
    expect(Object.keys(stripped).sort()).toEqual(['apiKeyEnv', 'baseUrl', 'id', 'kind'])
  })
})

describe('resolveEffectiveRuntimeConfig with a local engine override', () => {
  beforeEach(() => { _clearForTests(); register(claudeAdapter) })
  afterEach(() => _clearForTests())

  const base = () => ({ ...defaultAgentRuntimeConfig({ path: '' }), providers: [...defaultAgentRuntimeConfig({ path: '' }).providers, rich] })

  it('maps provider + model onto all three roles and drops effort/escalation', () => {
    const input = validateAgentRuntimeConfig({ ...base(), agents: { architect: { provider: 'claude', model: 'opus', effort: 'high', escalation: { model: 'sonnet' } }, developer: { provider: 'claude' }, reviewer: { provider: 'claude' } } })
    const { config, origins } = resolveEffectiveRuntimeConfig(input, { repositoryIds: [], source: 'project-role', providerOverride: { provider: 'local', model: 'qwen3.5-9b:latest' } })
    for (const role of ['architect', 'developer', 'reviewer'] as const) {
      expect(config.agents[role]).toEqual({ provider: 'local', model: 'qwen3.5-9b:latest', effort: undefined, escalation: undefined })
      expect(origins[role]).toBe('explicit-launch-override')
    }
  })

  it('an override without a model falls back to the registered adapter default model', () => {
    syncLocalAdapters([rich])
    const { config } = resolveEffectiveRuntimeConfig(validateAgentRuntimeConfig(base()), { repositoryIds: [], source: 'default', providerOverride: { provider: 'local' } })
    expect(config.agents.developer.model).toBe('qwen3.5-9b:latest')
  })

  it('an unregistered local connection (kill switch) leaves the model unset', () => {
    const { config } = resolveEffectiveRuntimeConfig(validateAgentRuntimeConfig(base()), { repositoryIds: [], source: 'default', providerOverride: { provider: 'local' } })
    expect(config.agents.developer.model).toBeUndefined()
  })
})


describe('runtime provider connections — core compact-loop fields', () => {
  const compact = { ...local, agentLoop: 'free' as const, contextWindowTokens: 65536 }
  it('accepts agentLoop/contextWindowTokens, validates them, and strips them unless the core advertises compactAgentLoop', () => {
    expect(validateRuntimeProviders([cli, compact])).toEqual([cli, compact])
    expect(() => validateRuntimeProviders([cli, { ...local, agentLoop: 'turbo' }])).toThrow(/agentLoop/)
    expect(() => validateRuntimeProviders([cli, { ...local, contextWindowTokens: 100 }])).toThrow(/contextWindowTokens/)
    expect(() => validateRuntimeProviders([cli, { ...local, contextWindowTokens: 1.5 }])).toThrow(/contextWindowTokens/)
    expect(stripDesktopConnectionFields([cli, { ...rich, ...compact }])).toEqual([cli, local])
    expect(stripDesktopConnectionFields([cli, { ...rich, ...compact }], { coreCompactLoop: false })).toEqual([cli, local])
    // A compact-capable core also receives supportsReasoningEffort (it forwards it as reasoning_effort).
    expect(stripDesktopConnectionFields([cli, { ...rich, ...compact }], { coreCompactLoop: true })).toEqual([cli, { ...local, supportsReasoningEffort: true, agentLoop: 'free', contextWindowTokens: 65536 }])
  })
  it('accepts maxOutputTokens, validates it, and forwards it only to a core advertising compactOutputBudget', () => {
    const budgeted = { ...compact, maxOutputTokens: 12288 }
    expect(validateRuntimeProviders([cli, budgeted])).toEqual([cli, budgeted])
    expect(() => validateRuntimeProviders([cli, { ...local, maxOutputTokens: 512 }])).toThrow(/maxOutputTokens/)
    expect(() => validateRuntimeProviders([cli, { ...local, maxOutputTokens: '8192' }])).toThrow(/maxOutputTokens/)
    expect(stripDesktopConnectionFields([cli, { ...rich, ...budgeted }], { coreCompactLoop: true })).toEqual([cli, { ...local, supportsReasoningEffort: true, agentLoop: 'free', contextWindowTokens: 65536 }])
    expect(stripDesktopConnectionFields([cli, { ...rich, ...budgeted }], { coreCompactLoop: true, coreOutputBudget: true })).toEqual([cli, { ...local, supportsReasoningEffort: true, agentLoop: 'free', contextWindowTokens: 65536, maxOutputTokens: 12288 }])
    expect(coreConnectionFieldGates({ compactAgentLoop: 1, compactOutputBudget: 1 })).toEqual({ coreCompactLoop: true, coreOutputBudget: true })
    expect(coreConnectionFieldGates({ compactAgentLoop: 1 })).toEqual({ coreCompactLoop: true, coreOutputBudget: false })
    expect(coreConnectionFieldGates(undefined)).toEqual({ coreCompactLoop: false, coreOutputBudget: false })
  })
})

describe('per-role thinking switch', () => {
  const agent = { provider: 'claude' as const }
  const config = { schemaVersion: 1 as const, providers: [{ id: 'claude', kind: 'cli' as const, cli: 'claude' as const }], agents: { architect: agent, developer: { ...agent, thinking: 'on' as const }, reviewer: agent }, fixer: { ...agent, thinking: 'off' as const }, verification: [] }
  it('travels to a core advertising roleThinkingControl and is stripped from agents and fixer otherwise', () => {
    expect(forCoreRuntime(config, { roleThinkingControl: 1 })).toEqual(config)
    const stripped = forCoreRuntime(config, { compactAgentLoop: 1 })
    expect(stripped.agents.developer).toEqual(agent)
    expect(stripped.fixer).toEqual(agent)
    expect(stripped.agents.architect).toEqual(agent)
    expect(forCoreRuntime({ ...config, agents: { architect: agent, developer: agent, reviewer: agent }, fixer: undefined }, undefined).agents.developer).toEqual(agent)
  })
})
