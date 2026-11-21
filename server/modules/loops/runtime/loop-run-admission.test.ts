import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, getJobEvents, type DbInstance } from '../../../db'
import { LoopRunManager, type LoopExecutors, type LoopRunRequest } from './loop-run-manager'
import { definitionRunNeverReachedCore, getLoopRun } from './loop-runs-store'
import { readRunHold, runHoldSources } from './loop-run-hold'
import { createRunAdmission } from '../../capacity'
import type { DefinitionRuntimeResult } from './loop-definition-run'
import type { WsMessage } from '../../../types'

// Capacity admission: a Core run over the machine's capacity starts queued,
// says what it waits for (log, hold, WS), starts by itself when a slot frees,
// and a run stopped while queued settles as stopped having run nothing.

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())

const request = (runId: string): LoopRunRequest => ({ runId, loopId: 'test-loop', projectId: 'p1', cwd: `/worktrees/${runId}`, provider: 'claude', model: 'haiku', graph: { nodes: [
  { id: 'start', type: 'start', position: { x: 0, y: 0 } },
  { id: 'a', type: 'core', position: { x: 0, y: 100 }, data: { kind: 'prompt', params: { text: 'Read', access: 'read', engine: { provider: 'claude' } } } },
  { id: 'end', type: 'core', position: { x: 0, y: 200 }, data: { kind: 'end', params: { outcome: 'success' } } }], edges: [{ id: 's', source: 'start', target: 'a' }, { id: 'e', source: 'a', target: 'end', label: 'next' }], config: { maxIterations: 3, timeoutMinutes: 0 } } })
const complete: DefinitionRuntimeResult = { text: 'done', runtimeStatus: 'succeeded', completion: { ok: true, verified: true, reasons: [] }, cost: 0, tokens: 0 }

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve))
  if (!condition()) throw new Error('timed out')
}

function setup() {
  const admission = createRunAdmission({ limits: () => ({ maxRuns: 1, maxRunsPerProject: 1, perProvider: {}, cpuBusyLimit: 0.9, minAvailableMemoryMb: null, quotaReservePercent: 5 }),
    machine: () => ({ cpuBusy: null, availableMemoryMb: null }), quota: () => ({ usedPercent: null, rejected: false }) })
  const finish: Array<() => void> = []
  const runDefinition = vi.fn(() => new Promise<DefinitionRuntimeResult>((resolve) => { finish.push(() => resolve(complete)) }))
  const executors: LoopExecutors = { runDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
  const messages: WsMessage[] = []
  const manager = new LoopRunManager(db, (message) => messages.push(message), executors, undefined, { admission: () => admission })
  return { manager, admission, runDefinition, finish, messages }
}

const lines = (runId: string): string[] => getJobEvents(db, runId).filter((e) => e.event_type === 'log').map((e) => JSON.parse(e.payload).line as string)

describe('capacity admission of loop runs', () => {
  it('queues a run over capacity, says why, and starts it when the slot frees', async () => {
    const { manager, runDefinition, finish, messages } = setup()
    const first = manager.run(request('r1'))
    await until(() => runDefinition.mock.calls.length === 1)
    const second = manager.run(request('r2'))
    await until(() => manager.queuedFor('r2') !== null)
    expect(runDefinition).toHaveBeenCalledTimes(1)
    expect(manager.queuedFor('r2')).toMatchObject({ waitingFor: 'run_slots', position: 1 })
    expect(readRunHold(db, 'r2', runHoldSources({ loopRunManager: manager }))).toMatchObject({ kind: 'queued', waitingFor: 'run_slots', position: 1 })
    expect(lines('r2').some((line) => line.startsWith('⏳ Queued (1 in line): every run slot of this machine is working.'))).toBe(true)
    expect(messages).toContainEqual(expect.objectContaining({ type: 'loop.run_queued', loopRunId: 'r2', waitingFor: 'run_slots', position: 1 }))
    finish.shift()!()
    expect((await first).outcome).toBe('success')
    await until(() => runDefinition.mock.calls.length === 2)
    expect(manager.queuedFor('r2')).toBeNull()
    expect(readRunHold(db, 'r2', runHoldSources({ loopRunManager: manager }))).toBeNull()
    expect(lines('r2').some((line) => /^▶ Started after waiting \d+ s for capacity\.$/.test(line))).toBe(true)
    finish.shift()!()
    expect((await second).outcome).toBe('success')
  })

  it('a run cancelled while queued settles as stopped and never reaches Core', async () => {
    const { manager, runDefinition, finish } = setup()
    const first = manager.run(request('r1'))
    await until(() => runDefinition.mock.calls.length === 1)
    const second = manager.run(request('r2'))
    await until(() => manager.queuedFor('r2') !== null)
    manager.cancel('r2')
    expect((await second).outcome).toBe('stopped')
    expect(getLoopRun(db, 'r2')).toMatchObject({ status: 'completed', final_outcome: 'stopped' })
    expect(lines('r2')).toContain('■ Stopped while it waited for capacity; nothing ran.')
    finish.shift()!()
    await first
    expect(runDefinition).toHaveBeenCalledTimes(1)
  })

  it('a shutdown leaves the queued run to startup recovery and frees nothing twice', async () => {
    const { manager, runDefinition, admission } = setup()
    void manager.run(request('r1'))
    await until(() => runDefinition.mock.calls.length === 1)
    void manager.run(request('r2'))
    await until(() => manager.queuedFor('r2') !== null)
    manager.shutdown()
    await until(() => admission.snapshot().queued.length === 0)
    expect(getLoopRun(db, 'r2')?.status).toBe('running')
  })

  it('the API cancellation of a queued run (no Core context yet) ends its wait', async () => {
    const { manager, runDefinition, finish } = setup()
    const first = manager.run(request('r1'))
    await until(() => runDefinition.mock.calls.length === 1)
    const second = manager.run(request('r2'))
    await until(() => manager.queuedFor('r2') !== null)
    await manager.cancelDefinition('r2')
    expect((await second).outcome).toBe('stopped')
    finish.shift()!()
    await first
  })

  it('a run a restart stopped while queued starts afresh on Continue, or settles stopped on Stop', async () => {
    const { manager, runDefinition } = setup()
    void manager.run(request('r1'))
    await until(() => runDefinition.mock.calls.length === 1)
    void manager.run(request('r2'))
    void manager.run(request('r3'))
    await until(() => manager.queuedFor('r3') !== null)
    manager.shutdown()
    // Durable: queued in its log, no Core event, no Core context. The running one reached Core.
    expect(definitionRunNeverReachedCore(db, 'r3')).toBe(true)
    // Startup recovery pauses every run the restart cut off.
    db.prepare("UPDATE loop_runs SET status = 'paused', restart_reason = 'restart' WHERE id IN ('r2', 'r3')").run()
    // The routes release the dead process's claim first (as for every restart pause).
    db.prepare("DELETE FROM definition_execution_claims WHERE run_id IN ('r2', 'r3')").run()
    const next = setup()
    const resumed = next.manager.beginDefinitionResume('r2')
    await until(() => next.runDefinition.mock.calls.length === 1)
    // Fresh: no Core resume of a run Core never saw.
    expect((next.runDefinition.mock.calls[0] as unknown as [{ resume?: boolean }])[0].resume).toBeFalsy()
    next.finish.shift()!()
    expect((await resumed).outcome).toBe('success')
    expect((await next.manager.stopNeverStarted('r3')).outcome).toBe('stopped')
    expect(getLoopRun(db, 'r3')).toMatchObject({ status: 'completed', final_outcome: 'stopped' })
    expect(lines('r3')).toContain('■ Stopped before it started; nothing ran.')
    expect(next.runDefinition).toHaveBeenCalledTimes(1)
  })

  // Soak 2: a run held 100 min on a question kept its project's only slot, so the project's other
  // rail waited the whole time although nothing ran. A hold gives the slot back; its end takes one again.
  it('a run held on a question gives its slot back, and queues for one again when answered', async () => {
    const { admission, finish } = setup()
    let r1Calls = 0
    const question = { id: 'q1', nodePath: 'ask', kind: 'question' as const }
    const runDefinition = vi.fn((input: { runId: string }) => {
      if (input.runId === 'r1' && r1Calls++ === 0) return Promise.resolve<DefinitionRuntimeResult>({ text: '', runtimeStatus: 'paused', pendingInterrupts: [question] })
      return new Promise<DefinitionRuntimeResult>((resolve) => { finish.push(() => resolve(complete)) })
    })
    const held = new LoopRunManager(db, () => {}, { runDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() } as unknown as LoopExecutors, undefined, { admission: () => admission })
    const first = held.run(request('r1'))
    await until(() => held.isPaused('r1'))
    // Held: r1 holds no slot, so r2 (same project, one slot) starts at once.
    expect(admission.snapshot().active.map((run: { runId: string }) => run.runId)).toEqual([])
    const second = held.run(request('r2'))
    await until(() => runDefinition.mock.calls.length === 2)
    expect(held.queuedFor('r2')).toBeNull()
    // Answered while r2 works: r1 waits for a slot, with the queued hold, log line and card.
    expect(held.sendInteractiveTurn('r1', 'A', { interruptId: 'q1' })).toBe(true)
    await until(() => held.queuedFor('r1') !== null)
    expect(readRunHold(db, 'r1', runHoldSources({ loopRunManager: held }))).toMatchObject({ kind: 'queued', waitingFor: 'run_slots' })
    expect(lines('r1').some((line) => line.startsWith('⏳ Queued (1 in line)'))).toBe(true)
    expect(runDefinition).toHaveBeenCalledTimes(2)
    finish.shift()!()
    expect((await second).outcome).toBe('success')
    // The slot frees: r1 continues (Core resumes with the answer) and settles; nothing is held after.
    await until(() => runDefinition.mock.calls.length === 3)
    expect(lines('r1').some((line) => /^▶ Continues after waiting \d+ s for capacity\.$/.test(line))).toBe(true)
    finish.shift()!()
    expect((await first).outcome).toBe('success')
    expect(admission.snapshot().active).toEqual([])
  })

  it('a held run stopped while it queues for its slot again settles stopped and Core never continues', async () => {
    const { admission, finish } = setup()
    let r1Calls = 0
    const runDefinition = vi.fn((input: { runId: string }) => {
      if (input.runId === 'r1' && r1Calls++ === 0) return Promise.resolve<DefinitionRuntimeResult>({ text: '', runtimeStatus: 'paused', pendingInterrupts: [{ id: 'q1', nodePath: 'ask', kind: 'question' }] })
      return new Promise<DefinitionRuntimeResult>((resolve) => { finish.push(() => resolve(complete)) })
    })
    const held = new LoopRunManager(db, () => {}, { runDefinition, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() } as unknown as LoopExecutors, undefined, { admission: () => admission })
    const first = held.run(request('r1'))
    await until(() => held.isPaused('r1'))
    const second = held.run(request('r2'))
    await until(() => runDefinition.mock.calls.length === 2)
    expect(held.sendInteractiveTurn('r1', 'yes', { interruptId: 'q1' })).toBe(true)
    await until(() => held.queuedFor('r1') !== null)
    held.cancel('r1')
    expect((await first).outcome).toBe('stopped')
    expect(lines('r1')).toContain('■ Stopped while it waited for capacity to continue.')
    finish.shift()!()
    await second
    expect(runDefinition).toHaveBeenCalledTimes(2)
    expect(admission.snapshot().active).toEqual([])
  })
})
