// Separate host process: the parent kills it and its Core child without cleanup.
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { initDb, getJob } from '../../../../db.ts'
import { LoopRunManager } from '../loop-run-manager.ts'
import { createLoopExecutors } from '../loop-executors.ts'
import { probeDefinitionRun, toDefinitionStates } from '../loop-definition-recovery.ts'
import { readDefinitionRun, readDefinitionExecutionClaim, reconcileOrphanLoopRuns, getLoopRun } from '../loop-runs-store.ts'
import { createDefinitionEventProjection } from '../loop-definition-events.ts'

const [root, action] = process.argv.slice(2)
const request = JSON.parse(readFileSync(path.join(root, 'request.json'), 'utf8'))
const db = initDb(path.join(root, 'project.sqlite'))
const executors = createLoopExecutors({ env: process.env })
const invoke = executors.runDefinition
executors.runDefinition = async input => { process.stderr.write('Preparing retained runtime\n'); const result = await invoke({ ...input,
  onPrepared(metadata) { process.stderr.write('Retained runtime prepared\n'); input.onPrepared?.(metadata) },
  onSpawn(child) { process.stderr.write('Core process spawned\n'); input.onSpawn?.(child) },
  onLine(line, source) { process.stderr.write(line + '\n'); input.onLine?.(line, source) }, onRuntimeEvent(event) {
  appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify(event) + '\n')
  input.onRuntimeEvent(event)
} }); process.stderr.write(JSON.stringify(result) + '\n'); return result }
const manager = new LoopRunManager(db, () => {}, executors)
const save = (name, value) => writeFileSync(path.join(root, name + '.json'), JSON.stringify(value))
const context = { db, cwd: request.cwd, env: process.env }
try {
  if (action === 'start') {
    const paused = setInterval(() => { if (manager.isPaused(request.runId)) save('paused', true) }, 20)
    try { save('unexpected-result', await manager.run(request)) } finally { clearInterval(paused) }
  } else {
    const frozen = readDefinitionRun(db, request.runId)
    assert.ok(frozen, 'Desktop must retain the original launch')
    let probe = await probeDefinitionRun(context, request.runId)
    assert.notEqual(probe.status, 'unavailable', JSON.stringify(probe))
    save('initial-probe', probe)
    const reconcile = () => reconcileOrphanLoopRuns(db, new Date().toISOString(), undefined, toDefinitionStates(new Map([[request.runId, probe]])))
    reconcile()
    if (probe.lease?.active) {
      assert.ok(readDefinitionExecutionClaim(db, request.runId))
      await assert.rejects(manager.resumeDefinition(request.runId), /runtime_run_active/)
      await sleep(Math.max(0, probe.lease.expiresAt - Date.now() + 150))
      probe = await probeDefinitionRun(context, request.runId)
      assert.equal(probe.lease?.active, false)
      reconcile()
    }
    assert.equal(readDefinitionExecutionClaim(db, request.runId), undefined)
    assert.deepEqual(readDefinitionRun(db, request.runId).request, frozen.request)
    save('recovery-probe', probe)
    const interrupt = probe.pendingInterrupts[0]
    const result = await manager.resumeDefinition(request.runId, {
      ...(interrupt ? { interruptId: interrupt.id, answer: 'Complete the frozen request' } : {}),
      recover: probe.recoverableSteps.map(step => step.attemptId),
    })
    const invocations = () => db.prepare('SELECT * FROM ai_invocations ORDER BY id').all()
    const beforeReplay = invocations()
    let sequence = db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM events WHERE job_id=?').get(request.runId).next
    const project = createDefinitionEventProjection({ db, runId: request.runId, projectId: request.projectId, ticketIds: [], nextSequence: () => sequence++, broadcast() {} })
    const events = readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.eventId || event.type === 'workflow-event')
    for (let replay = 0; replay < 2; replay++) for (const event of events) project(event)
    assert.deepEqual(invocations(), beforeReplay, 'Durable replay must not duplicate physical invocations')
    save('result', { result, run: getLoopRun(db, request.runId), job: getJob(db, request.runId), invocations: invocations(), probe: await probeDefinitionRun(context, request.runId), claim: readDefinitionExecutionClaim(db, request.runId) ?? null })
  }
} finally { manager.shutdown(); db.close() }
