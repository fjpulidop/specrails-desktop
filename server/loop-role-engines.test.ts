import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setDetectedProvidersSupplier } from './provider-selection'
import { syncLocalAdapters } from './providers/local-adapter-registry'
import { unregisterAdapter } from './providers/registry'
import { LOOP_ROLES, LoopRoleEnginesError, ROLES_ENGINE, loadLoopRoleEngines, loopRoleEnginesPath, resolveLoopRoleEngine, saveLoopRoleEngines, validateLoopRoleEngines } from './loop-role-engines'

// A legacy (non-relocated) project: the loop-role file lives under <repo>/.specrails/.
function project(dir: string) {
  return { id: 'p1', slug: 'p1', path: dir, provider: 'claude', providers: ['claude', 'codex', 'local'] }
}

describe('loop role engines (hybrid-role-engines)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'loop-roles-'))
    syncLocalAdapters([{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'qwen' }])
    setDetectedProvidersSupplier(() => ['claude', 'codex', 'local'])
  })
  afterEach(() => {
    setDetectedProvidersSupplier(null)
    unregisterAdapter('local')
    rmSync(dir, { recursive: true, force: true })
  })

  it('exposes the sentinel and the two loop roles', () => {
    expect(ROLES_ENGINE).toBe('roles')
    expect([...LOOP_ROLES]).toEqual(['verifier', 'decider'])
  })

  it('validates roles against the detected providers and the provider catalog', () => {
    const p = project(dir)
    expect(validateLoopRoleEngines({ verifier: { provider: 'claude', model: 'sonnet', effort: 'low' }, decider: { provider: 'local', model: 'anything' } }, p))
      .toEqual({ verifier: { provider: 'claude', model: 'sonnet', effort: 'low' }, decider: { provider: 'local', model: 'anything' } })
    expect(validateLoopRoleEngines({}, p)).toEqual({})
    expect(validateLoopRoleEngines({ verifier: null }, p)).toEqual({})
    expect(() => validateLoopRoleEngines({ architect: { provider: 'claude' } }, p)).toThrow(LoopRoleEnginesError)
    expect(() => validateLoopRoleEngines({ verifier: { provider: 'gemini' } }, p)).toThrow(/gemini|not/)
    expect(() => validateLoopRoleEngines({ verifier: { provider: 'claude', model: 'gpt-nope' } }, p)).toThrow(/not valid/)
    expect(() => validateLoopRoleEngines({ verifier: { provider: 'claude', effort: 'HIGH!' } }, p)).toThrow(/effort/)
    expect(() => validateLoopRoleEngines({ verifier: { provider: 'claude', extra: 1 } }, p)).toThrow(/unknown fields/)
    expect(() => validateLoopRoleEngines([], p)).toThrow(LoopRoleEnginesError)
  })

  it('round-trips through the per-project file and tolerates a missing or corrupt file', () => {
    const p = project(dir)
    expect(loadLoopRoleEngines(p)).toEqual({})
    saveLoopRoleEngines(p, { decider: { provider: 'codex', model: 'gpt-5.4-mini' } })
    expect(loopRoleEnginesPath(p)).toBe(path.join(dir, '.specrails', 'loop-role-engines.json'))
    expect(loadLoopRoleEngines(p)).toEqual({ decider: { provider: 'codex', model: 'gpt-5.4-mini' } })
  })

  it('resolves a role to its engine, falling back to the rail when the provider is gone', () => {
    const p = project(dir)
    const fallback = { provider: 'claude', model: 'opus', effort: 'high' as const }
    expect(resolveLoopRoleEngine(p, 'decider', fallback, {})).toEqual(fallback)
    expect(resolveLoopRoleEngine(p, 'decider', fallback, { decider: { provider: 'claude', model: 'haiku', effort: 'low' } })).toEqual({ provider: 'claude', model: 'haiku', effort: 'low' })
    // A stale model falls back to the adapter default; a stale effort is dropped.
    const resolved = resolveLoopRoleEngine(p, 'verifier', fallback, { verifier: { provider: 'claude', model: 'no-such', effort: 'ultra' } })
    expect(resolved.provider).toBe('claude')
    expect(resolved.model).not.toBe('no-such')
    expect(resolved.effort).toBeUndefined()
    // A local engine without the opt-in never carries effort.
    expect(resolveLoopRoleEngine(p, 'verifier', fallback, { verifier: { provider: 'local', model: 'qwen', effort: 'high' } })).toEqual({ provider: 'local', model: 'qwen' })
    // Provider no longer detected ⇒ the rail's engine.
    setDetectedProvidersSupplier(() => ['claude'])
    expect(resolveLoopRoleEngine(p, 'decider', fallback, { decider: { provider: 'codex' } })).toEqual(fallback)
  })
})
