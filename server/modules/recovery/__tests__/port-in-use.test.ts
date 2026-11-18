import { describe, expect, it } from 'vitest'
import { deriveFailureDiagnosis, parseStoredDiagnosis, presentFailureDiagnosis, serializeDiagnosis } from '../domain'

const conflict = { port: 3000, line: 'Error: listen EADDRINUSE: address already in use :::3000', stepId: 'verify' }

describe('port_in_use diagnosis', () => {
  it('names a port collision in the failing step instead of an unknown cause', () => {
    const d = deriveFailureDiagnosis({ outcome: 'failed', stepId: 'verify', errorText: 'verify exited 1', portConflict: conflict })
    expect(d).toMatchObject({ kind: 'port_in_use', confidence: 'high', port: 3000, phase: 'verify', source: 'desktop' })
    expect(d.detail).toContain('EADDRINUSE')
  })

  it('overrides Core\'s tests_failed, keeping its phase and rounds', () => {
    const d = deriveFailureDiagnosis({
      outcome: 'failed', stepId: 'run', portConflict: { ...conflict, stepId: 'run' },
      core: { kind: 'tests_failed', confidence: 'high', phase: 'verifier', rounds: 2, resumablePhase: 'fixer' },
    })
    expect(d).toMatchObject({ kind: 'port_in_use', phase: 'verifier', rounds: 2, resumablePhase: 'fixer', source: 'core', port: 3000 })
  })

  it('never overrides a more fundamental cause', () => {
    expect(deriveFailureDiagnosis({ outcome: 'failed', stepId: 'run', portConflict: { ...conflict, stepId: 'run' }, core: { kind: 'provider_limit', confidence: 'high' } }).kind).toBe('provider_limit')
    expect(deriveFailureDiagnosis({ outcome: 'failed', stepId: 'verify', portConflict: conflict, providerLimit: { message: 'limit' } }).kind).toBe('provider_limit')
    expect(deriveFailureDiagnosis({ outcome: 'stalled', stallReason: 'idle_timeout', stepId: 'verify', portConflict: conflict }).kind).toBe('tool_inactivity')
  })

  it('ignores a collision printed by another step (the agent worked around it)', () => {
    const d = deriveFailureDiagnosis({ outcome: 'failed', stepId: 'review', portConflict: conflict })
    expect(d.kind).toBe('unknown')
  })

  it('ranks resume and retry before the logs, and survives storage with its port', () => {
    const d = deriveFailureDiagnosis({ outcome: 'failed', stepId: 'verify', portConflict: conflict })
    expect(presentFailureDiagnosis(d).remedies).toEqual(['resume', 'retry', 'open-logs'])
    expect(parseStoredDiagnosis(serializeDiagnosis(d))).toMatchObject({ kind: 'port_in_use', port: 3000, source: 'desktop' })
  })

  it('drops an invalid port from a stored record', () => {
    const raw = JSON.stringify({ kind: 'port_in_use', confidence: 'high', port: 70000, source: 'desktop' })
    expect(parseStoredDiagnosis(raw)).toMatchObject({ kind: 'port_in_use', port: null })
  })
})
