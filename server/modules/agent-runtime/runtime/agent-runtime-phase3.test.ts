import { describe, expect, it, vi } from 'vitest'
import { applyPhase3RuntimeSwitches, BASELINE_CHARACTERIZATION_FAILED, runtimeErrorText } from './agent-runtime-bridge'
import type { RuntimeConfig } from './agent-runtime-settings'
import { corePhase3Capabilities, phase3CapabilitiesFrom } from './core-capabilities'

vi.mock('./agent-runtime-loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-runtime-loader')>()),
  loadCoreAgentRuntime: vi.fn(async () => ({ api: { capabilities: { specTrace: 1, baselineOnTouch: 1, rulesInventory: 0 } } })),
}))
import { loadCoreAgentRuntime } from './agent-runtime-loader'

const base = (): RuntimeConfig => ({ schemaVersion: 1, enabled: true, providers: [], agents: {} as RuntimeConfig['agents'], verification: [] })

describe('phase-3 runtime switches (contract 5.7)', () => {
  it('forwards baselineOnTouch only when Core announces it and the project enabled it', () => {
    const on = base()
    applyPhase3RuntimeSwitches(on, { baselineOnTouch: 1 }, { baselineOnTouch: true })
    expect(on.baselineOnTouch).toBe(true)
    const off = base()
    applyPhase3RuntimeSwitches(off, { baselineOnTouch: 1 }, { baselineOnTouch: false })
    expect('baselineOnTouch' in off).toBe(false)
    const older = { ...base(), baselineOnTouch: true }
    applyPhase3RuntimeSwitches(older, {}, { baselineOnTouch: true })
    expect('baselineOnTouch' in older).toBe(false)
  })

  it('strips architect.clarifications for a Core without the capability, keeping other architect keys', () => {
    const mixed: RuntimeConfig = { ...base(), architect: { onLowConfidence: 'proceed', clarifications: 'always-proceed' } }
    applyPhase3RuntimeSwitches(mixed, {}, undefined)
    expect(mixed.architect).toEqual({ onLowConfidence: 'proceed' })
    const only: RuntimeConfig = { ...base(), architect: { clarifications: 'always-proceed' } }
    applyPhase3RuntimeSwitches(only, {}, undefined)
    expect('architect' in only).toBe(false)
    const supported: RuntimeConfig = { ...base(), architect: { clarifications: 'always-proceed' } }
    applyPhase3RuntimeSwitches(supported, { architectClarifications: 1 }, undefined)
    expect(supported.architect).toEqual({ clarifications: 'always-proceed' })
  })

  it('spells out the baseline blocker and passes other errors through', () => {
    expect(runtimeErrorText({ code: BASELINE_CHARACTERIZATION_FAILED, message: 'search.test.ts failed' })).toMatch(/^Baseline blocked: .* Core: search\.test\.ts failed$/)
    expect(runtimeErrorText({ code: BASELINE_CHARACTERIZATION_FAILED })).not.toContain('Core:')
    expect(runtimeErrorText({ code: 'other', message: 'plain' })).toBe('plain')
    expect(runtimeErrorText(undefined)).toBeUndefined()
  })
})

describe('phase-3 Core capabilities', () => {
  it('projects the runtime api map and reads nothing as unsupported', async () => {
    expect(phase3CapabilitiesFrom({ architectClarifications: 1, specTrace: 2, baselineOnTouch: '1' })).toEqual({ architectClarifications: true, specTrace: false, baselineOnTouch: false, rulesInventory: false })
    expect(phase3CapabilitiesFrom(undefined)).toEqual({ architectClarifications: false, specTrace: false, baselineOnTouch: false, rulesInventory: false })
    expect(await corePhase3Capabilities()).toEqual({ architectClarifications: false, specTrace: true, baselineOnTouch: true, rulesInventory: false })
    vi.mocked(loadCoreAgentRuntime).mockRejectedValueOnce(new Error('no core'))
    expect(await corePhase3Capabilities()).toEqual({ architectClarifications: false, specTrace: false, baselineOnTouch: false, rulesInventory: false })
  })
})
