import { expect, it, vi } from 'vitest'
import { finishDefinitionCancellation, type DefinitionCancellationPorts } from './definition-cancellation'
import type { DefinitionRunProbe } from './loop-definition-recovery'
function fixture() {
  let now = 0
  const state = (status: string, active = false) => ({ status, lease: active ? { active: true } : null }) as DefinitionRunProbe
  const ports: DefinitionCancellationPorts = { inspect: vi.fn().mockResolvedValue(state('cancelled')), cancel: vi.fn().mockResolvedValue(undefined), settle: vi.fn().mockResolvedValue(undefined), stopped: () => false, now: () => now, wait: async ms => { now += ms } }
  return { ports, state }
}
it('waits for the live writer before settling once', async () => {
  const { ports, state } = fixture()
  vi.mocked(ports.inspect).mockResolvedValueOnce(state('running', true)).mockResolvedValueOnce(state('cancelled'))
  await finishDefinitionCancellation(ports)
  expect(ports.settle).toHaveBeenCalledTimes(1)
  expect(ports.cancel).not.toHaveBeenCalled()
})
it('reissues the same cancellation after an expired writer disappears', async () => {
  const { ports, state } = fixture()
  vi.mocked(ports.inspect).mockResolvedValueOnce(state('running')).mockResolvedValueOnce(state('cancelled'))
  await finishDefinitionCancellation(ports)
  expect(ports.cancel).toHaveBeenCalledTimes(1)
  expect(ports.settle).toHaveBeenCalledTimes(1)
})
it('preserves a completed result that won the cancellation race', async () => {
  const { ports, state } = fixture()
  vi.mocked(ports.inspect).mockResolvedValue(state('succeeded'))
  await finishDefinitionCancellation(ports)
  expect(ports.cancel).not.toHaveBeenCalled()
  expect(ports.settle).toHaveBeenCalledOnce()
})
it('does not settle when observation is unavailable or the lease never ends', async () => {
  const { ports, state } = fixture()
  vi.mocked(ports.inspect).mockResolvedValue(state('unavailable'))
  await expect(finishDefinitionCancellation(ports)).rejects.toThrow('unavailable')
  vi.mocked(ports.inspect).mockResolvedValue(state('running', true))
  await expect(finishDefinitionCancellation(ports, 2000)).rejects.toThrow('lease')
  expect(ports.settle).not.toHaveBeenCalled()
})
it('leaves shutdown recovery to the next process without more effects', async () => {
  const { ports } = fixture()
  ports.stopped = () => true
  await finishDefinitionCancellation(ports)
  expect(ports.inspect).not.toHaveBeenCalled()
  expect(ports.settle).not.toHaveBeenCalled()
})
it('finalizes a failed attempt with no completion before replaying terminal events', async () => {
  const { ports, state } = fixture()
  vi.mocked(ports.inspect).mockResolvedValueOnce(state('failed')).mockResolvedValueOnce(state('cancelled'))
  await finishDefinitionCancellation(ports)
  expect(ports.cancel).toHaveBeenCalledOnce()
  expect(ports.settle).toHaveBeenCalledOnce()
})
