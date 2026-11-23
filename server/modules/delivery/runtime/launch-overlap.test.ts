import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, createJob, type DbInstance } from '../../../db'
import { createPrDelivery } from './rail-pr-store'
import { findLaunchOverlaps, writtenPaths } from './launch-overlap'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())

const specs: Record<number, { title: string; description: string }> = {
  1: { title: 'Add a discount helper', description: 'Add `applyDiscount` to src/cart.js with tests in test/cart.test.js.' },
  2: { title: 'Add a tax helper', description: 'Add `applyTax` to src/cart.js.' },
  3: { title: 'Format money', description: 'Add `formatMoney` to src/format.js.' },
  4: { title: 'Default quantity', description: 'Change total() so a missing qty counts once.' },
}
const getTicketSpec = (id: number) => specs[id]

function runOn(rail: number, runId: string, tickets: number[], writes: string[] = []): void {
  createJob(db, { id: runId, command: 'loop', started_at: new Date().toISOString(), owner: 'loop' } as never)
  db.prepare("INSERT INTO loop_runs (id, project_id, loop_id, rail_index, status, started_at, ticket_ids_json) VALUES (?, 'p1', 'factory:implement', ?, 'running', datetime('now'), ?)").run(runId, rail, JSON.stringify(tickets))
  writes.forEach((file, index) => db.prepare("INSERT INTO events (job_id, seq, event_type, payload) VALUES (?, ?, 'agent-event', ?)")
    .run(runId, index, JSON.stringify({ role: 'build', event: { kind: 'tool-start', tool: 'Edit', targetPaths: [`/home/.specrails/projects/p/worktrees/${runId}/ticket-${tickets[0]}/${file}`] } })))
}

describe('launch overlaps', () => {
  it('names running rails and pending deliveries sharing files, from specs and agent writes', () => {
    runOn(1, 'run-tax', [2])
    runOn(2, 'run-money', [3])
    runOn(3, 'run-qty', [4], ['src/cart.js', 'test/cart.test.js'])
    createPrDelivery(db, { railIndex: 4, loopId: null, railKey: 'k4', ticketIds: [2], baseBranch: 'main', loopName: 'L', originSurface: 'dashboard' })
    db.prepare("UPDATE rail_pr_deliveries SET decision = 'on_review' WHERE rail_index = 4").run()
    expect(findLaunchOverlaps({ db, railIndex: 0, ticketIds: [1], getTicketSpec })).toEqual([
      { railIndex: 1, state: 'running', title: 'Add a tax helper', files: ['src/cart.js'] },
      { railIndex: 3, state: 'running', title: 'Default quantity', files: ['src/cart.js', 'test/cart.test.js'] },
      { railIndex: 4, state: 'pending', title: 'Add a tax helper', files: ['src/cart.js'] },
    ])
    // Rails holding specs whose launch has not created a run yet (a Launch all burst) count too.
    db.prepare("INSERT INTO rails (rail_index, ticket_id, position, mode) VALUES (5, 3, 0, 'implement'), (6, 2, 0, 'implement')").run()
    expect(findLaunchOverlaps({ db, railIndex: 0, ticketIds: [1], getTicketSpec }).map((o) => [o.railIndex, o.state])).toEqual([[1, 'running'], [3, 'running'], [4, 'pending'], [6, 'running']])
    // The launching rail's own runs, and specs that name no file, never overlap.
    expect(findLaunchOverlaps({ db, railIndex: 1, ticketIds: [4], getTicketSpec })).toEqual([])
  })

  it('reads only writes inside the run\'s own worktree', () => {
    runOn(0, 'r1', [1], ['src/a.js'])
    db.prepare("INSERT INTO events (job_id, seq, event_type, payload) VALUES ('r1', 9, 'agent-event', ?)").run(JSON.stringify({ event: { kind: 'tool-start', tool: 'Edit', targetPaths: ['/home/.specrails/projects/p/worktrees/other/ticket-1/src/b.js'] } }))
    db.prepare("INSERT INTO events (job_id, seq, event_type, payload) VALUES ('r1', 10, 'agent-event', ?)").run(JSON.stringify({ event: { kind: 'tool-start', tool: 'Read', targetPaths: ['/home/.specrails/projects/p/worktrees/r1/ticket-1/src/c.js'] } }))
    expect(writtenPaths(db, ['r1'])).toEqual(['src/a.js'])
  })
})
