import { expect, it } from 'vitest'
import { initDb, createJob, appendEvent } from '../../../db'
import { isRecordedRuntimeEfficiencyEvent, runtimeEfficiencyEventLine } from './agent-runtime-events'
it('bounds and scopes advisory data and deduplicates persisted event IDs across continuations', () => {
  const db = initDb(':memory:')
  try {
    createJob(db, { id: 'run', command: 'implement', started_at: new Date().toISOString(), provider: 'agent-runtime' })
    const event = { type: 'runtime-efficiency-event', schemaVersion: 1, eventId: 'run:12', runId: 'run', attemptId: 'a1', kind: 'role-context', payload: { provider: 'local', model: 'base', promptBytes: 100, privatePrompt: 'do not forward' } }
    const line = runtimeEfficiencyEventLine(JSON.stringify(event), 'run')!
    expect(line).not.toContain('do not forward')
    expect(runtimeEfficiencyEventLine(JSON.stringify(event), 'other')).toBeNull()
    expect(runtimeEfficiencyEventLine(JSON.stringify({ ...event, payload: { promptBytes: -1 } }), 'run')).toBeNull()
    expect(isRecordedRuntimeEfficiencyEvent(db, 'run', line)).toBe(false)
    appendEvent(db, 'run', 1, { event_type: 'runtime-efficiency-event', source: 'stdout', payload: line })
    expect(isRecordedRuntimeEfficiencyEvent(db, 'run', line)).toBe(true)
  } finally { db.close() }
})

it('keeps a provider call usage (attribution input) and rejects malformed figures', () => {
  const event = { type: 'runtime-efficiency-event', schemaVersion: 1, eventId: 'run:3', runId: 'run', attemptId: 'a1', kind: 'role-context', payload: { provider: 'codex', model: 'gpt', usage: { costUsd: null, inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 4, secret: 'x' } } }
  const line = JSON.parse(runtimeEfficiencyEventLine(JSON.stringify(event), 'run')!)
  expect(line.payload.usage).toEqual({ costUsd: null, inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 4 })
  expect(runtimeEfficiencyEventLine(JSON.stringify({ ...event, payload: { provider: 'codex', usage: { inputTokens: -1 } } }), 'run')).toBeNull()
  expect(runtimeEfficiencyEventLine(JSON.stringify({ ...event, payload: { provider: 'codex', usage: [1] } }), 'run')).toBeNull()
})
