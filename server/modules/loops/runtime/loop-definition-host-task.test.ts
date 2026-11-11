import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, getJobEvents, type DbInstance } from '../../../db'
import { createHostTaskDispatcher, hostTaskDelay, readHostTaskDispatch } from '../../agent-runtime/runtime/host-task-dispatcher'
import { LoopRunManager, type LoopExecutors, type LoopRunRequest } from './loop-run-manager'
import { runDefinitionLoop, type DefinitionLoopInvocation, type DefinitionRuntimeResult } from './loop-definition-run'
import type { WsMessage } from '../../../types'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())
function request(): LoopRunRequest { return { runId: 'r1', loopId: 'factory:pr-ci', projectId: 'p1', cwd: '/repo', provider: 'claude', model: 'sonnet', graph: { nodes: [
  { id: 'start', type: 'start', position: { x: 0, y: 0 } }, { id: 'checks', type: 'core', position: { x: 0, y: 100 }, data: { kind: 'host-task', params: { task: 'pr.checks', input: {}, outcomes: ['green'], effect: 'read' } } },
  { id: 'end', type: 'core', position: { x: 0, y: 200 }, data: { kind: 'end', params: { outcome: 'success' } } }], edges: [{ id: 's', source: 'start', target: 'checks' }, { id: 'g', source: 'checks', target: 'end', label: 'green' }, { id: 'f', source: 'checks', target: 'end', label: 'failed' }], config: { maxIterations: 3, timeoutMinutes: 0 } } } }
const paused = (id = 'int-1'): DefinitionRuntimeResult => ({ text: '', runtimeStatus: 'paused', pendingInterrupts: [{ id, nodePath: 'checks', kind: 'host-task',
  value: { kind: 'host-task', task: 'pr.checks', input: {}, outcomes: ['green'], effect: 'read', candidate: { hash: 'h', verified: false }, nodePath: 'checks' } }] })
const done: DefinitionRuntimeResult = { text: 'done', runtimeStatus: 'succeeded', completion: { ok: true, verified: false, reasons: [] } }
const executors = (run: LoopExecutors['runDefinition']): LoopExecutors => ({ runDefinition: run, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() })

describe('host tasks in the Loop Manager', () => {
  it('resolves a machine interrupt through the dispatcher and resumes Core with --host-result, never asking a person', async () => {
    const calls: DefinitionLoopInvocation[] = []
    const run = vi.fn(async (input: DefinitionLoopInvocation) => { calls.push(input); return calls.length === 1 ? paused() : done })
    const messages: WsMessage[] = []
    const dispatcher = createHostTaskDispatcher({ db, projectId: 'p1', handlers: { 'pr.checks': async () => ({ outcome: 'green', output: { checks: 1 } }) } })
    const manager = new LoopRunManager(db, message => messages.push(message), executors(run), undefined, { hostTasks: () => dispatcher })
    const result = await manager.run(request())
    expect(result.outcome).toBe('success')
    expect(calls[1]).toMatchObject({ resume: true, interruptId: 'int-1', hostResult: { outcome: 'green', output: { checks: 1 } } })
    expect(messages.filter(message => message.type === 'job.interactive' || message.type === 'loop.run_paused')).toEqual([])
    expect(manager.pendingInterrupts?.('r1') ?? []).toEqual([])
    const events = getJobEvents(db, 'r1').map(event => event.event_type)
    expect(events).toEqual(expect.arrayContaining(['host_task_started', 'host_task_finished']))
    expect(readHostTaskDispatch(db, 'r1', 'int-1')).toMatchObject({ status: 'resolved' })
  })

  it('fails the node (not the person) when no dispatcher is bound', async () => {
    const calls: DefinitionLoopInvocation[] = []
    const run = vi.fn(async (input: DefinitionLoopInvocation) => { calls.push(input); return calls.length === 1 ? paused() : done })
    await new LoopRunManager(db, () => {}, executors(run)).run(request())
    expect(calls[1]).toMatchObject({ hostResult: { outcome: 'failed' } })
  })

  it('Stop while waiting on the host aborts the handler and cancels the run', async () => {
    const run = vi.fn(async () => paused())
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    const dispatcher = createHostTaskDispatcher({ db, projectId: 'p1', handlers: { 'pr.checks': async ({ signal }) => { started(); await hostTaskDelay(60_000, signal); return { outcome: 'green' } } } })
    const manager = new LoopRunManager(db, () => {}, executors(run), undefined, { hostTasks: () => dispatcher })
    const running = manager.run(request())
    await waiting
    manager.cancel('r1')
    expect((await running).outcome).toBe('stopped')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('runDefinitionLoop host-task routing', () => {
  it('prefers a machine interrupt and refuses to run one without a resolver', async () => {
    const ports = { invoke: vi.fn(async () => paused()), isCancelled: () => false, remainingMs: () => undefined, onLine: () => {}, onRuntimeEvent: () => {}, onSpawn: () => {}, onInvocationEnd: () => {},
      awaitHumanDecision: vi.fn(async () => ({ action: 'stop' as const })) }
    await expect(runDefinitionLoop(request(), 'r1', ports)).rejects.toThrow('host_task_unsupported')
    expect(ports.awaitHumanDecision).not.toHaveBeenCalled()
  })
})
