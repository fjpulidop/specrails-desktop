import { beforeEach, describe, expect, it } from 'vitest'
import { createJob, initDb, type DbInstance } from '../../../db'
import { createLoopRun } from './loop-runs-store'
import {
  buildAttemptChains, chainHasAutomaticContinuation, readAttemptChain, readRunAttempts, readRunContinuations, recordRunContinuation, supersededAttemptSql,
} from './run-attempts'
import { listUnifiedJobs } from '../../execution/runtime/job-listing'
import { createProjectInboxSource } from '../../inbox/adapters/project-source'
import { createProjectLiveBoardSource } from '../../live-board/adapters/project-source'
import { serializeDiagnosis } from '../../recovery'

const NOW = Date.parse('2026-11-18T21:00:00.000Z')
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()
let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

const failure = serializeDiagnosis({ kind: 'incomplete_tasks', confidence: 'high', phase: 'tasks', rounds: null, resetAt: null, detail: 'unfinished', resumablePhase: null, blocker: null, incompleteTasks: ['5.2 Visual review'], source: 'desktop' })

/** One run row (and its job) that ended with `outcome`, optionally continuing `forkOf`. */
function run(id: string, opts: { forkOf?: string; outcome?: string | null; started: number; finished?: number; rail?: number }) {
  createLoopRun(db, { id, projectId: 'p1', loopId: 'factory:implement', loopName: 'Implement', railIndex: opts.rail ?? 0, ticketIds: [14], iterationLimit: 1, startedAt: at(opts.started) })
  createJob(db, { id, command: 'loop:factory:implement #14', owner: 'loop', started_at: at(opts.started) })
  const completed = opts.outcome !== null
  db.prepare("UPDATE loop_runs SET engine_version = 2, status = ?, final_outcome = ?, finished_at = ?, fork_of = ?, fork_cut_json = ?, failure_diagnosis = ? WHERE id = ?")
    .run(completed ? 'completed' : 'running', opts.outcome ?? null, completed ? at(opts.finished ?? opts.started - 5) : null, opts.forkOf ?? null,
      opts.forkOf ? JSON.stringify({ fromNodePath: 'developer', scopeId: 'root', visit: 1 }) : null, opts.outcome === 'failed' ? failure : null, id)
  db.prepare("UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?").run(opts.outcome === 'success' ? 'completed' : opts.outcome === null ? 'running' : 'failed', completed ? at(opts.finished ?? opts.started - 5) : null, id)
  if (opts.forkOf) db.prepare("INSERT INTO definition_fork_operations (project_id, source_run_id, request_id, child_run_id, request_json, adopted) VALUES ('p1', ?, ?, ?, '{}', 1)").run(opts.forkOf, `r-${id}`, id)
}

/** The user's #14: failed, continued twice (both failed), the third continuation delivered. */
function seedIssue14() {
  run('run-14', { outcome: 'failed', started: 120 })
  run('fork-a', { forkOf: 'run-14', outcome: 'failed', started: 90 })
  run('fork-b', { forkOf: 'fork-a', outcome: 'failed', started: 60 })
  run('fork-c', { forkOf: 'fork-b', outcome: 'success', started: 30 })
}

describe('attempt chains (pure)', () => {
  it('numbers attempts in start order from the root and names the latest', () => {
    const chains = buildAttemptChains([
      { id: 'c', fork_of: 'b', started_at: '3' }, { id: 'a', fork_of: null, started_at: '1' }, { id: 'b', fork_of: 'a', started_at: '2' }, { id: 'x', fork_of: null, started_at: '0' },
    ])
    expect(chains.get('c')).toEqual({ runId: 'c', rootRunId: 'a', attempt: 3, attempts: 3, latestRunId: 'c', previousRunId: 'b' })
    expect(chains.get('a')).toMatchObject({ attempt: 1, attempts: 3, latestRunId: 'c', previousRunId: null })
    expect(chains.get('x')).toMatchObject({ attempt: 1, attempts: 1, latestRunId: 'x' })
  })
  it('survives a parent outside the rows and a cycle', () => {
    expect(buildAttemptChains([{ id: 'b', fork_of: 'gone', started_at: '1' }]).get('b')).toMatchObject({ rootRunId: 'b', attempts: 1, previousRunId: null })
    const cyclic = buildAttemptChains([{ id: 'a', fork_of: 'b', started_at: '1' }, { id: 'b', fork_of: 'a', started_at: '2' }])
    expect(cyclic.size).toBe(2)
  })
  it('only accepts a plain SQL alias', () => {
    expect(() => supersededAttemptSql('r; DROP TABLE jobs')).toThrow()
  })
})

describe('attempt chains (one project database)', () => {
  it('places every run of #14 in one chain and leaves a lone run out', () => {
    seedIssue14()
    run('other', { outcome: 'failed', started: 50, rail: 1 })
    const attempts = readRunAttempts(db, ['run-14', 'fork-c', 'other'])
    expect(attempts.get('fork-c')).toMatchObject({ attempt: 4, attempts: 4, rootRunId: 'run-14', latestRunId: 'fork-c', previousRunId: 'fork-b' })
    expect(attempts.get('run-14')).toMatchObject({ attempt: 1, latestRunId: 'fork-c' })
    expect(attempts.has('other')).toBe(false)
  })

  it('reads the chain with each attempt\'s step and how it was continued', () => {
    seedIssue14()
    recordRunContinuation(db, { runId: 'fork-a', sourceRunId: 'run-14', remedy: 'continue', mode: 'fork', fromStep: 'developer', cause: 'incomplete_tasks', guidance: 'browser guidance', automatic: true })
    const chain = readAttemptChain(db, 'fork-b')!
    expect(chain.attempt).toBe(3)
    expect(chain.attempts.map((item) => [item.runId, item.attempt, item.outcome, item.fromStep])).toEqual([
      ['run-14', 1, 'failed', null], ['fork-a', 2, 'failed', 'developer'], ['fork-b', 3, 'failed', 'developer'], ['fork-c', 4, 'success', 'developer'],
    ])
    expect(chain.attempts[1].continuations).toEqual([expect.objectContaining({ automatic: true, guidance: 'browser guidance', cause: 'incomplete_tasks' })])
    expect(readAttemptChain(db, 'nope')).toBeNull()
  })

  it('bounds automatic continuation to one per chain', () => {
    seedIssue14()
    expect(chainHasAutomaticContinuation(db, 'fork-b')).toBe(false)
    recordRunContinuation(db, { runId: 'fork-a', sourceRunId: 'run-14', remedy: 'continue', mode: 'fork', fromStep: 'developer', cause: null, guidance: null, automatic: true })
    for (const id of ['run-14', 'fork-a', 'fork-b', 'fork-c']) expect(chainHasAutomaticContinuation(db, id)).toBe(true)
    recordRunContinuation(db, { runId: 'fork-c', sourceRunId: 'fork-c', remedy: 'continue', mode: 'resume', fromStep: null, cause: null, guidance: null, automatic: false })
    expect(readRunContinuations(db, ['fork-c']).get('fork-c')).toHaveLength(1)
  })
})

describe('one counting rule for every surface', () => {
  it('jobs lists show the chain once, as its latest attempt, and fold the rest', () => {
    seedIssue14()
    const listed = listUnifiedJobs(db, { limit: 50, offset: 0 })
    expect(listed.jobs.map((job) => job.id)).toEqual(['fork-c'])
    expect(listed.total).toBe(1)
    expect(listUnifiedJobs(db, { limit: 50, offset: 0, status: 'failed' }).total).toBe(0)
    expect(listUnifiedJobs(db, { limit: 50, offset: 0, attempts: 'all' }).total).toBe(4)
  })

  it('the inbox lists no earlier attempt and names the delivered attempt', () => {
    seedIssue14()
    run('fork-c2', { outcome: 'failed', started: 10, rail: 2 })
    const items = createProjectInboxSource({ project: { id: 'p1', name: 'Alpha' }, db }, () => NOW).collect()
    expect(items.map((item) => item.subjectId)).toEqual(['fork-c2'])
    expect(items[0].attempt).toBeUndefined()
  })

  it('a chain whose latest attempt also failed is one inbox item: attempt 3 of 3', () => {
    run('run-14', { outcome: 'failed', started: 120 })
    run('fork-a', { forkOf: 'run-14', outcome: 'failed', started: 90 })
    run('fork-b', { forkOf: 'fork-a', outcome: 'failed', started: 60 })
    const items = createProjectInboxSource({ project: { id: 'p1', name: 'Alpha' }, db }, () => NOW).collect()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ subjectId: 'fork-b', kind: 'failed', attempt: { number: 3, of: 3 } })
  })

  it('the live board shows one card for the chain, as its latest attempt', () => {
    seedIssue14()
    const day = { from: new Date(NOW - 86_400_000).toISOString(), to: new Date(NOW + 60_000).toISOString() }
    const facts = createProjectLiveBoardSource({ project: { id: 'p1', name: 'Alpha' }, db }).collect(day)
    const runs = facts.filter((item) => item.status.source === 'loop-run')
    expect(runs.map((item) => item.sourceId)).toEqual(['fork-c'])
    expect(runs[0].attempt).toEqual({ number: 4, of: 4 })
  })

  it('an attempt still in progress takes the chain over too', () => {
    run('run-14', { outcome: 'failed', started: 120 })
    run('fork-a', { forkOf: 'run-14', outcome: null, started: 10 })
    expect(listUnifiedJobs(db, { limit: 50, offset: 0 }).jobs.map((job) => job.id)).toEqual(['fork-a'])
    expect(createProjectInboxSource({ project: { id: 'p1', name: 'Alpha' }, db }, () => NOW).collect()).toEqual([])
  })

  it('a fork nobody adopted leaves the failed attempt pending', () => {
    run('run-14', { outcome: 'failed', started: 120 })
    db.prepare("INSERT INTO definition_fork_operations (project_id, source_run_id, request_id, child_run_id, request_json, adopted) VALUES ('p1', 'run-14', 'r', 'fork-x', '{}', 0)").run()
    expect(listUnifiedJobs(db, { limit: 50, offset: 0 }).jobs.map((job) => job.id)).toEqual(['run-14'])
    expect(createProjectInboxSource({ project: { id: 'p1', name: 'Alpha' }, db }, () => NOW).collect().map((item) => item.subjectId)).toEqual(['run-14'])
  })
})
