import type { DefinitionRunProbe } from './loop-definition-recovery'

export interface DefinitionCancellationPorts {
  inspect(): Promise<DefinitionRunProbe>
  /** Idempotent Core inbox request; also finalizes an expired writer's cancellation. */
  cancel(): Promise<void>
  settle(): Promise<void>
  stopped(): boolean
  now(): number
  wait(milliseconds: number): Promise<void>
}

/** Acknowledgement is not settlement. Wait for Core to release its writer lease
 * before Desktop replays terminal events and closes the original delivery. */
export async function finishDefinitionCancellation(ports: DefinitionCancellationPorts, timeoutMs = 90_000): Promise<void> {
  const deadline = ports.now() + timeoutMs
  for (;;) {
    if (ports.stopped()) return // Startup recovery retains the durable Core intent.
    const state = await ports.inspect()
    if (ports.stopped()) return
    if (state.status === 'unavailable') throw new Error('Cancellation was accepted, but retained Core status is unavailable')
    if (!state.lease?.active) {
      if (!['cancelled', 'succeeded'].includes(state.status) && !state.completion) {
        // A writer can disappear after inbox admission. Core owns converting
        // its expired lease and durable cancel request into terminal truth.
        await ports.cancel()
      } else {
        await ports.settle()
        return
      }
    }
    if (ports.now() >= deadline) throw new Error('Cancellation is durable; Core has not released its execution lease yet')
    await ports.wait(Math.min(1000, Math.max(1, deadline - ports.now())))
  }
}
