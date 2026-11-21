import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, getJobEvents, type DbInstance } from '../../../db'
import { LoopRunManager, type LoopExecutors, type LoopRunRequest } from './loop-run-manager'
import { getLoopRun, markDefinitionRestart } from './loop-runs-store'
import { deriveRunHold, readRunHold, runHoldSources } from './loop-run-hold'
import { readUserPause, saveUserPause, userPauseRequestId } from './loop-user-pauses'
import { createRunAdmission } from '../../capacity'
import type { DefinitionRuntimeResult } from './loop-definition-run'
import type { WsMessage } from '../../../types'

// The person's Pause of a running Core definition run: Core finishes the step in
// progress and parks at the next step boundary; the run holds as paused by you,
// gives its capacity slot back, survives a restart as paused and continues in place
// (the same run, no fork) only on the person's Resume.

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())

const at = '2026-11-21T10:00:00.000Z'
const request = (runId: string): LoopRunRequest => ({ runId, loopId: 'implement', projectId: 'p1', cwd: `/worktrees/${runId}`, provider: 'claude', model: 'haiku', railIndex: 0, ticketId: 4, graph: { nodes: [
  { id: 'start', type: 'start', position: { x: 0, y: 0 } },
  { id: 'a', type: 'core', position: { x: 0, y: 100 }, data: { kind: 'prompt', params: { text: 'Read', access: 'read', engine: { provider: 'claude' } } } },
  { id: 'end', type: 'core', position: { x: 0, y: 200 }, data: { kind: 'end', params: { outcome: 'success' } } }], edges: [{ id: 's', source: 'start', target: 'a' }, { id: 'e', source: 'a', target: 'end', label: 'next' }], config: { maxIterations: 3, timeoutMinutes: 0 } } })
const prepared = (runId: string) => ({ contextPath: `/frozen/${runId}/context.json`, runtimeDirectory: `/frozen/${runId}`, configPath: '/frozen/config.json', definitionPath: '/frozen/definition.json', definitionHash: 'a'.repeat(64), definition: {}, context: {} })
const succeeded: DefinitionRuntimeResult = { text: 'done', runtimeStatus: 'succeeded', completion: { ok: true, verified: true, reasons: [] }, cost: 0, tokens: 0 }
const stepStarted = (runId: string) => ({ type: 'workflow-event', event: { id: `${runId}:1`, runId, sequence: 1, type: 'step_started', nodePath: 'developer', scopeId: 'root', visit: 1, attempt: 1, attemptId: 'attempt-1', timestamp: at } })

async function until(condition: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve))
  if (!condition()) throw new Error(`timed out waiting for ${label}`)
}

/** A fake retained Core: the first invocation works until a pause request lands, then
 *  exits paused on it (or finishes when `finishFirst`); a resume finishes the run. */
function fakeCore(opts: { unsupported?: boolean; finishFirst?: boolean; pauseOutcome?: string } = {}) {
  let landed: ((requestId: string) => void) | null = null
  const pauseLanded = new Promise<string>((resolve) => { landed = resolve })
  let releaseFirst: () => void = () => {}
  const pauseDefinition = vi.fn(async (input: { runId: string; contextPath: string; requestId: string; reason: string }) => {
    if (opts.unsupported) throw new Error('engine_unsupported: Retained Core does not support cooperative pause')
    landed!(input.requestId)
    return { outcome: opts.pauseOutcome ?? 'requested' }
  })
  const supportsPause = vi.fn(async () => !opts.unsupported)
  const runDefinition = vi.fn(async (input: Parameters<NonNullable<LoopExecutors['runDefinition']>>[0]) => {
    if (input.resume) return succeeded
    input.onPrepared?.(prepared(input.runId))
    input.onRuntimeEvent(stepStarted(input.runId))
    if (opts.finishFirst) { await new Promise<void>((resolve) => { releaseFirst = resolve }); return succeeded }
    const requestId = await pauseLanded // Core finishes the step in progress, then honours the pause.
    return { text: '', runtimeStatus: 'paused', pendingInterrupts: [], pause: { requestId, reason: 'requested', at } } satisfies DefinitionRuntimeResult
  })
  const executors: LoopExecutors = { runDefinition, pauseDefinition, supportsPause, runAiStep: vi.fn(), runShell: vi.fn(), runDecider: vi.fn() }
  return { executors, runDefinition, pauseDefinition, supportsPause, finishFirst: () => releaseFirst() }
}

function oneSlotAdmission() {
  return createRunAdmission({ limits: () => ({ maxRuns: 1, maxRunsPerProject: 1, perProvider: {}, cpuBusyLimit: 0.9, minAvailableMemoryMb: null, quotaReservePercent: 5 }),
    machine: () => ({ cpuBusy: null, availableMemoryMb: null }), quota: () => ({ usedPercent: null, rejected: false }) })
}

const lines = (runId: string): string[] => getJobEvents(db, runId).filter((e) => e.event_type === 'log').map((e) => JSON.parse(e.payload).line as string)

describe('the person\'s Pause of a Core definition run', () => {
  it('pauses at the next step boundary, holds as paused by you, gives the slot back, and resumes the same run in place', async () => {
    const core = fakeCore()
    const admission = oneSlotAdmission()
    const messages: WsMessage[] = []
    const manager = new LoopRunManager(db, (m) => messages.push(m), core.executors, undefined, { admission: () => admission })
    const running = manager.run(request('r1'))
    await until(() => manager.userPauseControl('r1') === 'pause', 'pause control')
    expect(core.supportsPause).toHaveBeenCalledWith({ runId: 'r1', contextPath: '/frozen/r1/context.json' })

    const asked = await manager.requestUserPause('r1')
    expect(asked).toMatchObject({ status: 'pausing', requestId: expect.stringMatching(/^desktop-user-pause:r1:1:[0-9a-z]+$/) })
    expect(core.pauseDefinition).toHaveBeenCalledWith({ runId: 'r1', contextPath: '/frozen/r1/context.json', requestId: (asked as { requestId: string }).requestId, reason: 'requested' })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'loop.pause_requested', loopRunId: 'r1' }))

    await until(() => manager.userPause('r1'), 'user pause')
    expect(manager.userPauseControl('r1')).toBe('resume')
    expect(getLoopRun(db, 'r1')).toMatchObject({ status: 'paused', restart_reason: 'user_paused', final_outcome: null })
    expect(readRunHold(db, 'r1', runHoldSources({ loopRunManager: manager }))).toMatchObject({ kind: 'paused', byYou: true })
    expect(readUserPause(db, 'r1')).toMatchObject({ requestId: (asked as { requestId: string }).requestId, pausedAt: expect.any(String) })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'loop.run_paused', loopRunId: 'r1', pauseKind: 'user_paused' }))
    expect(lines('r1').some((line) => line.includes('Paused by you'))).toBe(true)
    // D6: a held run does no work, so it holds no capacity slot.
    expect(admission.snapshot().active).toEqual([])
    // A message is not a Resume, and a second Pause is a no-op.
    expect(manager.sendInteractiveTurn('r1', 'go on')).toBe(false)
    expect(await manager.requestUserPause('r1')).toEqual({ status: 'paused' })
    expect(core.pauseDefinition).toHaveBeenCalledTimes(1)

    expect(manager.resumeUserPause('r1')).toBe(true)
    expect((await running).outcome).toBe('success')
    // In place: the same run id resumed through Core (no fork, no fresh run).
    expect(core.runDefinition).toHaveBeenCalledTimes(2)
    expect(core.runDefinition.mock.calls[1][0]).toMatchObject({ runId: 'r1', resume: true })
    expect(getLoopRun(db, 'r1')).toMatchObject({ status: 'completed', final_outcome: 'success', restart_reason: null })
    expect(readUserPause(db, 'r1')).toBeNull()
    expect(lines('r1').some((line) => line.includes('Resumed by you'))).toBe(true)
    expect(getJobEvents(db, 'r1').filter((e) => e.event_type === 'run-user-pause').map((e) => JSON.parse(e.payload).state)).toEqual(['paused', 'resumed'])
    // The resume took a slot again and the settlement released it.
    expect(admission.snapshot().active).toEqual([])
    expect(manager.userPauseControl('r1')).toBeNull()
  })

  it('takes its slot again on Resume, queued like a launch while another run holds it', async () => {
    const core = fakeCore()
    const admission = oneSlotAdmission()
    const finish: Array<() => void> = []
    const runDefinition = vi.fn(async (input: Parameters<NonNullable<LoopExecutors['runDefinition']>>[0]) => {
      if (input.runId === 'r1') return core.runDefinition(input)
      return new Promise<DefinitionRuntimeResult>((resolve) => { finish.push(() => resolve(succeeded)) })
    })
    const manager = new LoopRunManager(db, () => {}, { ...core.executors, runDefinition }, undefined, { admission: () => admission })
    const first = manager.run(request('r1'))
    await until(() => manager.userPauseControl('r1') === 'pause')
    await manager.requestUserPause('r1')
    await until(() => manager.userPause('r1'))
    // The freed slot lets the project's other run start at once.
    const second = manager.run(request('r2'))
    await until(() => runDefinition.mock.calls.some(([input]) => input.runId === 'r2'))
    expect(manager.resumeUserPause('r1')).toBe(true)
    await until(() => manager.queuedFor('r1') !== null, 'queued for its slot')
    finish.shift()!()
    expect((await second).outcome).toBe('success')
    expect((await first).outcome).toBe('success')
    expect(admission.snapshot().active).toEqual([])
  })

  it('every Pause request id is unique: per request, and across a restart that resets the counter', async () => {
    expect(userPauseRequestId('r1', 1, 1000)).not.toBe(userPauseRequestId('r1', 1, 2000))
    expect(userPauseRequestId('r1', 1, 1000)).not.toBe(userPauseRequestId('r1', 2, 1000))
    const ids: string[] = []
    for (const clock of [1000, 5000]) {
      const core = fakeCore()
      const manager = new LoopRunManager(db, () => {}, core.executors, () => clock)
      const runId = `u${clock}`
      const running = manager.run(request(runId))
      await until(() => manager.userPauseControl(runId) === 'pause')
      ids.push(((await manager.requestUserPause(runId)) as { requestId: string }).requestId)
      await until(() => manager.userPause(runId))
      manager.resumeUserPause(runId)
      await running
    }
    expect(new Set(ids).size).toBe(2)
  })

  it('stays paused by you over a restart, and is never treated as a plain restart pause', async () => {
    const core = fakeCore()
    const manager = new LoopRunManager(db, () => {}, core.executors)
    void manager.run(request('r1'))
    await until(() => manager.userPauseControl('r1') === 'pause')
    await manager.requestUserPause('r1')
    await until(() => manager.userPause('r1'))
    manager.shutdown()
    // Startup recovery retains it as every run the restart found: paused, reason restart.
    markDefinitionRestart(db, 'r1')
    expect(getLoopRun(db, 'r1')).toMatchObject({ status: 'paused', restart_reason: 'restart' })
    expect(readUserPause(db, 'r1')).not.toBeNull()
    expect(readRunHold(db, 'r1')).toMatchObject({ kind: 'paused', byYou: true })
  })

  it('says "Resumed by you" in its log when the person resumes it after a restart', async () => {
    const core = fakeCore()
    const first = new LoopRunManager(db, () => {}, core.executors)
    void first.run(request('r1'))
    await until(() => first.userPauseControl('r1') === 'pause')
    await first.requestUserPause('r1')
    await until(() => first.userPause('r1'))
    first.shutdown()
    markDefinitionRestart(db, 'r1')
    const messages: WsMessage[] = []
    const second = new LoopRunManager(db, (m) => messages.push(m), core.executors)
    expect((await second.beginDefinitionResume('r1')).outcome).toBe('success')
    const resumedLines = lines('r1').filter((line) => line.includes('Resumed by you'))
    expect(resumedLines).toHaveLength(1)
    // It follows the pause line, and the narrated log gets its structured mirror.
    expect(lines('r1').findIndex((line) => line.includes('Resumed by you'))).toBeGreaterThan(lines('r1').findIndex((line) => line.includes('Paused by you')))
    const states = getJobEvents(db, 'r1').filter((e) => e.event_type === 'run-user-pause').map((e) => JSON.parse(e.payload).state)
    expect(states).toEqual(['paused', 'resumed'])
    expect(messages).toContainEqual(expect.objectContaining({ type: 'log', processId: 'r1', line: expect.stringContaining('Resumed by you') }))
    second.shutdown()
  })

  it('a plain restart resume says nothing about the person', async () => {
    const core = fakeCore({ finishFirst: true })
    const first = new LoopRunManager(db, () => {}, core.executors)
    void first.run(request('r1'))
    await until(() => core.runDefinition.mock.calls.length === 1)
    first.shutdown()
    markDefinitionRestart(db, 'r1')
    // The restart's own claim is released as the resume route does before it resumes.
    db.prepare('DELETE FROM definition_execution_claims WHERE run_id = ?').run('r1')
    const second = new LoopRunManager(db, () => {}, core.executors)
    core.finishFirst()
    await second.beginDefinitionResume('r1')
    expect(lines('r1').some((line) => line.includes('by you'))).toBe(false)
    second.shutdown()
  })

  it('a restart while it is still finishing its step keeps the person\'s Pause', async () => {
    const core = fakeCore({ finishFirst: true })
    const manager = new LoopRunManager(db, () => {}, core.executors)
    void manager.run(request('r1'))
    await until(() => manager.userPauseControl('r1') === 'pause')
    await manager.requestUserPause('r1')
    expect(manager.userPauseControl('r1')).toBe('pausing')
    expect(readRunHold(db, 'r1', runHoldSources({ loopRunManager: manager }))).toBeNull() // still working
    manager.shutdown()
    markDefinitionRestart(db, 'r1')
    expect(readRunHold(db, 'r1')).toMatchObject({ kind: 'paused', byYou: true })
  })

  it('a run that finishes before it reaches a step boundary settles normally and drops the request', async () => {
    const core = fakeCore({ finishFirst: true })
    const manager = new LoopRunManager(db, () => {}, core.executors)
    const running = manager.run(request('r1'))
    await until(() => manager.userPauseControl('r1') === 'pause')
    await manager.requestUserPause('r1')
    core.finishFirst()
    expect((await running).outcome).toBe('success')
    expect(readUserPause(db, 'r1')).toBeNull()
    expect(manager.userPauseControl('r1')).toBeNull()
  })

  it('Stop while paused settles the run stopped and drops the record', async () => {
    const core = fakeCore()
    const manager = new LoopRunManager(db, () => {}, core.executors)
    const running = manager.run(request('r1'))
    await until(() => manager.userPauseControl('r1') === 'pause')
    await manager.requestUserPause('r1')
    await until(() => manager.userPause('r1'))
    manager.cancel('r1')
    expect((await running).outcome).toBe('stopped')
    expect(core.runDefinition).toHaveBeenCalledTimes(1)
    expect(readUserPause(db, 'r1')).toBeNull()
  })

  it('offers no Pause when the run\'s Core cannot pause, and says so when asked', async () => {
    const core = fakeCore({ unsupported: true, finishFirst: true })
    const manager = new LoopRunManager(db, () => {}, core.executors)
    const running = manager.run(request('r1'))
    await until(() => core.supportsPause.mock.calls.length === 1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(manager.userPauseControl('r1')).toBeNull()
    expect(await manager.requestUserPause('r1')).toEqual({ status: 'unsupported' })
    expect(core.pauseDefinition).not.toHaveBeenCalled()
    core.finishFirst()
    await running
    expect(await manager.requestUserPause('r1')).toEqual({ status: 'not_running' })
  })

  it('offers no Pause for a legacy (engine 1) run', async () => {
    const executors: LoopExecutors = { runAiStep: vi.fn(async () => ({ text: 'x', cost: 0, tokens: 1, provider: 'claude', model: 'haiku' })), runShell: vi.fn(), runDecider: vi.fn(), pauseDefinition: vi.fn() }
    const manager = new LoopRunManager(db, () => {}, executors)
    const legacy: LoopRunRequest = { runId: 'l1', loopId: 'l', projectId: 'p1', cwd: '/repo', provider: 'claude', model: 'haiku', graph: { nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } }, { id: 'a', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'p' } }, { id: 'e', type: 'end', position: { x: 0, y: 2 } }],
    edges: [{ id: 'e1', source: 's', target: 'a' }, { id: 'e2', source: 'a', target: 'e' }], config: { maxIterations: 1, timeoutMinutes: 0 } } }
    const running = manager.run(legacy)
    expect(manager.userPauseControl('l1')).toBeNull()
    expect(await manager.requestUserPause('l1')).toEqual({ status: 'not_running' })
    await running
  })
})

describe('the paused-by-you hold', () => {
  const facts = { loopStatus: 'paused', restartReason: null, checkpoint: null, retainedLimit: null, live: null, restartPending: false, lastActivityAt: at }
  it('derives from the live pause, the pause reason and the retained record', () => {
    expect(deriveRunHold({ ...facts, loopStatus: 'running', live: { budget: false, limit: null, userPause: true, pending: [] } })).toMatchObject({ kind: 'paused', byYou: true })
    expect(deriveRunHold({ ...facts, restartReason: 'user_paused' })).toMatchObject({ kind: 'paused', byYou: true })
    expect(deriveRunHold({ ...facts, restartReason: 'restart', retainedUserPause: true })).toMatchObject({ kind: 'paused', byYou: true })
    // A plain restart pause still reads as a restart, and a budget pause wins over the person's.
    expect(deriveRunHold({ ...facts, restartReason: 'restart' })).toMatchObject({ kind: 'restart' })
    expect(deriveRunHold({ ...facts, restartReason: 'restart', retainedBudget: true, retainedUserPause: true })).toMatchObject({ kind: 'budget' })
    expect(deriveRunHold({ ...facts, restartReason: 'restart' })?.byYou).toBeUndefined()
  })

  it('reads the retained record only for a paused run', () => {
    saveUserPause(db, 'nope', { requestId: 'x', requestedAt: at })
    expect(readRunHold(db, 'nope')).toBeNull()
  })
})
