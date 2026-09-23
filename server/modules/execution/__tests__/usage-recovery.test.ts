import { describe, expect, it } from 'vitest'
import { recoverJobUsage, type JobUsage, type UsageRecoveryPorts } from '..'

type Event = { kind: string; usage: JobUsage; estimated?: boolean; id?: string }
function evidence(events: Event[]): UsageRecoveryPorts<Event> {
  return {
    *events(mode, after = -1) {
      for (const [seq, event] of events.entries()) {
        if (mode === 'results' && event.kind !== 'result') continue
        if (mode === 'tail' && seq <= after) continue
        yield { seq, event_type: event.kind, payload: String(seq) }
      }
    },
    parse: payload => [events[Number(payload)]],
    normalize: event => ({ result: event.usage, estimated: event.estimated ?? false }),
    messageId: event => event.id,
    malformedEvent: () => {},
  }
}
describe('durable usage recovery through ports', () => {
  it('deduplicates message snapshots and preserves missing terminal evidence', () => {
    const result = recoverJobUsage(evidence([
      { kind: 'other', id: 'message', estimated: true, usage: { tokens_in: 5, total_cost_usd: 0.2 } },
      { kind: 'other', id: 'message', estimated: true, usage: { tokens_in: 8, total_cost_usd: 0.3 } },
      { kind: 'result', usage: { tokens_out: 4, tokens_in: undefined } },
    ]), null, false)
    expect(result).toMatchObject({ authoritative: true, estimated: true,
      result: { tokens_in: 8, tokens_out: 4, total_cost_usd: 0.3 } })
  })
  it('prefers billed terminal cost over estimated snapshots', () => {
    const result = recoverJobUsage(evidence([
      { kind: 'other', estimated: true, usage: { total_cost_usd: 0.4 } },
      { kind: 'result', usage: { total_cost_usd: 0.1 } },
    ]), null, false)
    expect(result).toMatchObject({ estimated: false, result: { total_cost_usd: 0.1 } })
  })
  it('adds interactive turn deltas and unfinished tail evidence exactly once', () => {
    const result = recoverJobUsage(evidence([
      { kind: 'result', usage: { total_cost_usd: 1, tokens_in: 2, num_turns: 1 } },
      { kind: 'result', usage: { total_cost_usd: 3, tokens_in: 4, num_turns: 2 } },
      { kind: 'other', id: 'tail', estimated: true, usage: { tokens_in: 1, total_cost_usd: 0.5 } },
    ]), 'model', true)
    expect(result).toMatchObject({ authoritative: false, estimated: true,
      result: { tokens_in: 7, total_cost_usd: 3.5 } })
  })
  it('propagates storage failures to the owner of the recovery transaction', () => {
    const ports = evidence([])
    ports.events = function* () { throw new Error('database closed') }
    expect(() => recoverJobUsage(ports, null, false)).toThrow('database closed')
  })
})
