import { expect, it } from 'vitest'
import { runtimeRetentionDecision, validateRuntimeRetentionPolicy, type RuntimeRetentionEvidence } from './agent-runtime-retention'
const now = Date.parse('2026-09-27T00:00:00Z')
const settled: RuntimeRetentionEvidence = { runId: 'run', disposition: 'settled', terminalAt: '2026-08-01T00:00:00Z', active: false, humanPending: false, interruptedWrites: false, deliveryPending: false, forkPending: false }
it.each(['settled', 'discarded'] as const)('collects an expired %s run only when every protection is explicitly absent', disposition => {
  expect(runtimeRetentionDecision({ ...settled, disposition }, { days: 30 }, now)).toEqual({ runId: 'run', collect: true, reasons: [] })
})
it.each([
  [{ disposition: 'recoverable' }, 'recoverable'], [{ active: true }, 'active'], [{ humanPending: true }, 'human_pending'],
  [{ interruptedWrites: true }, 'interrupted_writes'], [{ deliveryPending: true }, 'delivery_pending'], [{ forkPending: true }, 'fork_pending'],
  [{ terminalAt: null }, 'unknown_terminal_time'], [{ terminalAt: 'invalid' }, 'unknown_terminal_time'],
  [{ terminalAt: '2027-01-01T00:00:00Z' }, 'unknown_terminal_time'], [{ terminalAt: '2026-09-26T00:00:00Z' }, 'within_retention'],
] as const)('protects %j regardless of the age of other metadata', (fields, reason) => {
  expect(runtimeRetentionDecision({ ...settled, ...fields }, { days: 30 }, now)).toMatchObject({ collect: false, reasons: [reason] })
})
it('retains indefinitely by default policy and reports every independent blocker', () => {
  expect(runtimeRetentionDecision({ ...settled, active: true, deliveryPending: true }, { days: null }, now)).toMatchObject({ collect: false, reasons: ['disabled', 'active', 'delivery_pending'] })
})
it('does not treat missing authority flags as permission', () => {
  expect(runtimeRetentionDecision({ runId: 'unknown', terminalAt: settled.terminalAt } as RuntimeRetentionEvidence, { days: 1 }, now)).toMatchObject({ collect: false, reasons: ['recoverable', 'active', 'human_pending', 'interrupted_writes', 'delivery_pending', 'fork_pending'] })
})
it.each([null, {}, [], { days: 0 }, { days: -1 }, { days: 0.5 }, { days: 3651 }, { days: '30' }, { days: 30, force: true }])('rejects invalid policy %j', value => {
  expect(() => validateRuntimeRetentionPolicy(value)).toThrow()
})
it('uses the exact expiration boundary and rejects invalid clocks', () => {
  const evidence = { ...settled, terminalAt: new Date(now - 30 * 86_400_000).toISOString() }
  expect(runtimeRetentionDecision(evidence, { days: 30 }, now).collect).toBe(true)
  expect(runtimeRetentionDecision(evidence, { days: 30 }, now - 1).collect).toBe(false)
  expect(() => runtimeRetentionDecision(evidence, { days: 30 }, NaN)).toThrow('clock')
})

import { vi } from 'vitest'
import { collectRuntimeRetention, type RuntimeRetentionReservation } from './agent-runtime-retention'
function collection(evidence = settled) {
  const calls: string[] = []
  const reservation: RuntimeRetentionReservation = {
    evidence, quarantine: vi.fn(async () => { calls.push('quarantine'); return { token: 'owned-token' } }),
    expire: vi.fn(async () => { calls.push('expire') }), restore: vi.fn(async () => { calls.push('restore') }),
    remove: vi.fn(async () => { calls.push('remove') }), release: vi.fn(() => { calls.push('release') }),
  }
  const ports = { runIds: async () => ['run', 'run'], reserve: vi.fn(async () => reservation as RuntimeRetentionReservation | null), collectUnreferencedPackages: vi.fn(async () => { calls.push('packages'); return ['digest'] }) }
  return { calls, reservation, ports }
}
it('collects once in quarantine-expire-delete order, then rescans package references', async () => {
  const f = collection(), result = await collectRuntimeRetention(f.ports, { days: 30 }, { dryRun: false, now })
  expect(f.calls).toEqual(['quarantine', 'expire', 'remove', 'release', 'packages'])
  expect(result).toMatchObject({ runs: [{ runId: 'run', state: 'expired' }], packages: ['digest'], errors: [] })
})
it.each([true, false])('never mutates a protected run in dryRun=%s', async dryRun => {
  const f = collection({ ...settled, deliveryPending: true })
  expect(await collectRuntimeRetention(f.ports, { days: 30 }, { dryRun, now })).toMatchObject({ runs: [{ state: 'protected' }] })
  expect(f.calls).toEqual(['release', 'packages'])
  expect(f.ports.collectUnreferencedPackages).toHaveBeenCalledWith(dryRun)
})
it('previews eligible journals without moving or expiring them', async () => {
  const f = collection()
  expect(await collectRuntimeRetention(f.ports, { days: 30 }, { dryRun: true, now })).toMatchObject({ runs: [{ state: 'eligible' }] })
  expect(f.calls).toEqual(['release', 'packages'])
})
it('restores quarantine if durable expiration fails and skips package deletion', async () => {
  const f = collection(); vi.mocked(f.reservation.expire).mockRejectedValueOnce(Error('DB unavailable'))
  expect(await collectRuntimeRetention(f.ports, { days: 30 }, { dryRun: false, now })).toMatchObject({ runs: [{ state: 'error', error: 'DB unavailable' }] })
  expect(f.calls).toEqual(['quarantine', 'restore', 'release'])
})
it('leaves durable expiration intact when physical deletion fails', async () => {
  const f = collection(); vi.mocked(f.reservation.remove).mockRejectedValueOnce(Error('File busy'))
  expect(await collectRuntimeRetention(f.ports, { days: 30 }, { dryRun: false, now })).toMatchObject({ runs: [{ state: 'cleanup_pending' }] })
  expect(f.calls).toEqual(['quarantine', 'expire', 'release'])
})
it('refuses mismatched reservation identity and always releases ownership', async () => {
  const f = collection({ ...settled, runId: 'other' })
  expect(await collectRuntimeRetention(f.ports, { days: 30 }, { dryRun: false, now })).toMatchObject({ runs: [{ state: 'error' }] })
  expect(f.calls).toEqual(['release'])
})
it('never forces a busy reservation and reports a corrupt package scan', async () => {
  const f = collection(); f.ports.reserve.mockResolvedValueOnce(null)
  f.ports.collectUnreferencedPackages.mockRejectedValueOnce(Error('Corrupt pin'))
  expect(await collectRuntimeRetention(f.ports, { days: 30 }, { dryRun: false, now })).toMatchObject({ runs: [{ state: 'busy' }], packages: [], errors: ['Corrupt pin'] })
  expect(f.reservation.quarantine).not.toHaveBeenCalled()
})
