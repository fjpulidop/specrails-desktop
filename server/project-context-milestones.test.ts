import { describe, it, expect } from 'vitest'
import { initDb } from './db'
import { createLoopRun, pauseLoopRun } from './modules/loops/runtime/loop-runs-store'
import { listChainRuns } from './project-context-milestones'

describe('listChainRuns (chain reconciliation input)', () => {
  it('lists every run carrying the specs — any origin — with its pause reason, lineage and fork adoption', () => {
    const db = initDb(':memory:')
    const mk = (id: string, ticketIds: number[], startedAt: string) =>
      createLoopRun(db, { id, projectId: 'p1', loopId: 'factory:implement', railIndex: 3, ticketIds, ticketId: ticketIds[0], iterationLimit: 1, startedAt })
    mk('chain-6', [6], '2026-11-21T07:44:00.000Z')
    mk('manual-6', [6], '2026-11-21T12:03:00.000Z')
    mk('other-8', [8], '2026-11-21T12:04:00.000Z')
    mk('pair', [7, 9], '2026-11-21T12:05:00.000Z')
    pauseLoopRun(db, 'manual-6', undefined, 'user_paused')
    db.prepare("UPDATE loop_runs SET fork_of = 'chain-6', engine_version = 2 WHERE id = 'manual-6'").run()
    db.prepare("INSERT INTO definition_fork_operations (project_id, source_run_id, request_id, child_run_id, request_json, adopted) VALUES ('p1', 'chain-6', 'f1', 'manual-6', '{}', 1)").run()
    const runs = listChainRuns(db, 'p1', [6, 9], new Map([['job-9', { railIndex: 5, ticketIds: [9] }], ['job-8', { railIndex: 6, ticketIds: [8] }]]))
    expect(runs.map((r) => r.id)).toEqual(['pair', 'manual-6', 'chain-6', 'job-9'])
    expect(runs.find((r) => r.id === 'manual-6')).toMatchObject({ status: 'paused', pauseReason: 'user_paused', forkOf: 'chain-6', engineVersion: 2, ticketIds: [6] })
    // The source of an adopted Continue fork no longer owns the execution.
    expect(runs.find((r) => r.id === 'chain-6')!.status).toBe('superseded')
    expect(runs.find((r) => r.id === 'job-9')).toMatchObject({ status: 'running', railIndex: 5 })
    expect(listChainRuns(db, 'p1', [])).toEqual([])
  })
})
