import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { boundHostTaskResult, createHostTaskDispatcher, hostTaskDelay, HOST_TASK_OUTPUT_LIMIT_BYTES, listHostTaskDispatches, readHostTaskDispatch, type HostTaskRequest } from './host-task-dispatcher'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())
const request = (task = 'pr.checks'): HostTaskRequest => ({ task, input: {}, outcomes: ['green', 'red'], effect: 'read', candidate: { hash: 'h', verified: true } })

describe('host-task dispatcher', () => {
  it('persists the dispatch before acting and the result before resuming', async () => {
    let seen: unknown
    const dispatcher = createHostTaskDispatcher({ db, projectId: 'p1', handlers: { 'pr.checks': async () => { seen = readHostTaskDispatch(db, 'r1', 'i1'); return { outcome: 'green', output: { checks: 2 } } } } })
    expect(await dispatcher.dispatch({ runId: 'r1', interruptId: 'i1', request: request(), log: () => {} })).toEqual({ outcome: 'green', output: { checks: 2 } })
    expect(seen).toMatchObject({ status: 'running', attempts: 1, task: 'pr.checks' })
    expect(readHostTaskDispatch(db, 'r1', 'i1')).toMatchObject({ status: 'resolved', result_json: JSON.stringify({ outcome: 'green', output: { checks: 2 } }) })
  })

  it('replays a recorded result after a restart instead of repeating the effect', async () => {
    const handler = vi.fn(async () => ({ outcome: 'red' }))
    await createHostTaskDispatcher({ db, projectId: 'p1', handlers: { 'pr.checks': handler } }).dispatch({ runId: 'r1', interruptId: 'i1', request: request(), log: () => {} })
    const restarted = createHostTaskDispatcher({ db, projectId: 'p1', handlers: { 'pr.checks': handler } })
    expect(await restarted.dispatch({ runId: 'r1', interruptId: 'i1', request: request(), log: () => {} })).toEqual({ outcome: 'red' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('re-runs an interrupted dispatch (crash before the result) and counts the attempt', async () => {
    db.prepare(`INSERT INTO host_task_dispatches (run_id, interrupt_id, task, status, attempts, created_at, updated_at) VALUES ('r1','i1','pr.checks','running',1,'t','t')`).run()
    const dispatcher = createHostTaskDispatcher({ db, projectId: 'p1', handlers: { 'pr.checks': async () => ({ outcome: 'green' }) } })
    await dispatcher.dispatch({ runId: 'r1', interruptId: 'i1', request: request(), log: () => {} })
    expect(readHostTaskDispatch(db, 'r1', 'i1')).toMatchObject({ status: 'resolved', attempts: 2 })
    expect(listHostTaskDispatches(db, 'r1')).toHaveLength(1)
  })

  it('turns a throwing handler, an unknown task and an undeclared outcome into failed', async () => {
    const dispatcher = createHostTaskDispatcher({ db, projectId: 'p1', handlers: { 'pr.checks': async () => { throw new Error('gh: not logged in') }, 'pr.sync': async () => ({ outcome: 'purple' }) } })
    expect(await dispatcher.dispatch({ runId: 'r1', interruptId: 'a', request: request(), log: () => {} })).toEqual({ outcome: 'failed', output: { detail: 'gh: not logged in' } })
    expect(await dispatcher.dispatch({ runId: 'r1', interruptId: 'b', request: request('pr.unknown'), log: () => {} })).toMatchObject({ outcome: 'failed' })
    expect(await dispatcher.dispatch({ runId: 'r1', interruptId: 'c', request: request('pr.sync'), log: () => {} })).toMatchObject({ outcome: 'failed', output: { detail: expect.stringContaining('undeclared') } })
    expect(dispatcher.supports('pr.checks')).toBe(true)
    expect(dispatcher.supports('toString')).toBe(false)
  })

  it('cancels an in-flight handler without recording a result', async () => {
    const dispatcher = createHostTaskDispatcher({ db, projectId: 'p1', handlers: { 'pr.checks': async ({ signal }) => { await hostTaskDelay(60_000, signal); return { outcome: 'green' } } } })
    const pending = dispatcher.dispatch({ runId: 'r1', interruptId: 'i1', request: request(), log: () => {} })
    // A second dispatch of the same interrupt joins the first.
    expect(dispatcher.dispatch({ runId: 'r1', interruptId: 'i1', request: request(), log: () => {} })).toBe(pending)
    dispatcher.cancel('r1')
    await expect(pending).rejects.toThrow('host_task_cancelled')
    expect(readHostTaskDispatch(db, 'r1', 'i1')).toMatchObject({ status: 'running', result_json: null })
  })

  it('bounds outputs to what Core accepts', () => {
    expect(boundHostTaskResult({ outcome: 'green', output: 'x'.repeat(HOST_TASK_OUTPUT_LIMIT_BYTES + 10) }, ['green'])).toEqual({ outcome: 'green', output: { detail: expect.any(String), truncated: true } })
    expect(boundHostTaskResult({ outcome: 'failed' }, ['green'])).toEqual({ outcome: 'failed' })
  })
})
