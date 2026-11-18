import { describe, expect, it } from 'vitest'
import { initDb } from '../../../db'
import { createLoopRunEvents } from './loop-run-events'
import type { LoopRunHost, LoopRunState } from './loop-run-context'

function harness() {
  const host = { db: initDb(':memory:'), options: {}, now: () => 0, emit: () => {}, activeStepRecovery: () => undefined } as unknown as LoopRunHost
  const state = { seq: 0, stepNum: 0, openStep: null } as unknown as LoopRunState
  return { state, events: createLoopRunEvents(host, 'run-1', state) }
}

describe('port collisions in run output', () => {
  it('records the latest collision of a plain log line with the step that printed it', () => {
    const { state, events } = harness()
    events.emitStep('shell', 'Verify', 'verify', 1)
    events.logLine('> vite preview')
    events.logLine('Error: listen EADDRINUSE: address already in use :::4173', 'stderr')
    expect(state.portConflict).toMatchObject({ port: 4173, stepId: 'verify' })
  })

  it('reads runtime receipts but never the agent conversation', () => {
    const { state, events } = harness()
    events.emitStep('ai', 'Implement', 'implement', 1)
    events.onRawLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Error: listen EADDRINUSE: address already in use :::3000' }] } }))
    expect(state.portConflict).toBeUndefined()
    events.onRawLine(JSON.stringify({ type: 'runtime-verification', failureSummary: ['Error: listen EADDRINUSE: address already in use :::3000'] }))
    expect(state.portConflict).toMatchObject({ port: 3000, stepId: 'implement' })
  })
})
