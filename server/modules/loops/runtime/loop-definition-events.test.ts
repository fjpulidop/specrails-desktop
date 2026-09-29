import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createJob, getJob, getJobEvents, initDb, type DbInstance } from '../../../db'
import { createLoopRun, getLoopRun, saveDefinitionRun } from './loop-runs-store'
import { createDefinitionEventProjection, readDefinitionUsage } from './loop-definition-events'
import type { LoopRunRequest } from './loop-run-manager'

const runId = 'recorded-core-v2'
const events = readFileSync(new URL('./__fixtures__/core-v2-events.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
const metadata = JSON.parse(readFileSync(new URL('./__fixtures__/core-v2-events.meta.json', import.meta.url), 'utf8'))
let db: DbInstance
beforeEach(() => {
  db = initDb(':memory:')
  createLoopRun(db, { id: runId, projectId: 'p1', loopId: 'fixture', iterationLimit: 30, startedAt: '2026-09-26T20:00:00Z' })
  createJob(db, { id: runId, command: 'loop: fixture', owner: 'loop', started_at: '2026-09-26T20:00:00Z' })
  saveDefinitionRun(db, runId, { request: { runId, projectId: 'p1', loopId: 'fixture', cwd: '/fixture', provider: 'fixture', model: 'fixture', graph: { nodes: [], edges: [], config: { maxIterations: 30, timeoutMinutes: 0 } } } as LoopRunRequest })
})
afterEach(() => db.close())

it('projects recorded Core parallel/pause/resume events with conserved integer allocation and unknown billing', () => {
  let sequence = 0
  const project = createDefinitionEventProjection({ db, runId, projectId: 'p1', ticketIds: [20, 10], nextSequence: () => ++sequence, broadcast: () => {} })
  events.slice(0, metadata.pausedEventCount).forEach(project)
  const paused = getJobEvents(db, runId).filter(event => event.event_type === 'loop_step_end').map(event => JSON.parse(event.payload))
  expect(paused.some(event => event.status === 'paused' && event.nodePath === 'ask')).toBe(true)
  // A new projection is the process-restart seam. Core's captured resume stream
  // contains the original events again; no test-manufactured replay envelopes.
  const resumed = createDefinitionEventProjection({ db, runId, projectId: 'p1', ticketIds: [10, 20], nextSequence: () => ++sequence, broadcast: () => {} })
  events.slice(metadata.pausedEventCount).forEach(resumed)
  const usage = readDefinitionUsage(db, runId)
  expect(usage).toMatchObject({ cost: metadata.finalUsage.knownCostUsd, costUnknown: true, tokensIn: metadata.finalUsage.inputTokens, tokensOut: metadata.finalUsage.outputTokens, cacheRead: 2, cacheCreateUnknown: true })
  expect(getJob(db, runId)).toMatchObject({ total_cost_usd: null, tokens_in: 10, tokens_out: 6, tokens_cache_read: 2, tokens_cache_create: null })
  expect(getLoopRun(db, runId)?.core_event_cursor).toBe(metadata.finalCursor)
  const rows = db.prepare('SELECT tokens_in,tokens_out,total_cost_usd FROM ai_invocations ORDER BY id').all() as Array<{ tokens_in: number; tokens_out: number; total_cost_usd: number | null }>
  expect(rows).toHaveLength(metadata.physicalCalls * 2)
  expect(rows.map(row => row.tokens_in).sort()).toEqual([2, 2, 3, 3])
  expect(rows.map(row => row.tokens_out).sort()).toEqual([1, 1, 2, 2])
  expect(rows.filter(row => row.total_cost_usd === null)).toHaveLength(2)
  const stored = getJobEvents(db, runId)
  expect(stored.filter(event => event.event_type === 'workflow-event' || event.event_type === 'runtime-efficiency-event')).toHaveLength(metadata.finalCursor)
  const branches = stored.filter(event => event.event_type === 'loop_step').map(event => JSON.parse(event.payload)).filter(event => event.nodePath === 'reviews/read')
  expect(branches).toHaveLength(2)
  expect(new Set(branches.map(event => event.scopeId)).size).toBe(2)
  expect(new Set(branches.map(event => event.attemptId)).size).toBe(2)
  expect(branches.every(event => /^[a-f0-9]{32}$/.test(event.traceId))).toBe(true)
  expect(stored.filter(event => event.event_type === 'loop_step_end').map(event => JSON.parse(event.payload)).filter(event => event.nodePath === 'ask').map(event => event.status)).toEqual(['paused', 'ok'])
  const stable = db.prepare('SELECT * FROM ai_invocations ORDER BY id').all()
  events.forEach(resumed)
  expect(db.prepare('SELECT * FROM ai_invocations ORDER BY id').all()).toEqual(stable)
})
