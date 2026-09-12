import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { initDb, createJob, appendEvent } from './db'
import { createPrDelivery, transitionDecision, getPrDelivery } from './rail-pr-store'
import { settleRuntimeContinuation } from './agent-runtime-settlement'
import { readCoreCompletion } from './core-completion'
vi.mock('./core-completion', () => ({ readCoreCompletion: vi.fn(async () => ({
  change: 'notes', recordedAt: '2026-09-12T00:00:00Z',
  completion: { implementation: 'complete', validation: 'verified', archive: 'done', delivery: 'pending-host', reasons: [] },
  exceptions: [], checks: [], findings: [], phases: [],
})) }))

it.each([true, false])('reconciles only verified results (verified=%s), retaining failure history and usage', async valid => {
  const db = initDb(':memory:'), root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-settle-')))
  const contextPath = path.join(root, 'context.json')
  fs.writeFileSync(contextPath, JSON.stringify({ runId: 'run', repositories: [{ path: root }] }))
  createJob(db, { id: 'run', command: 'loop:implement', started_at: new Date().toISOString(), owner: 'loop' })
  db.prepare("UPDATE jobs SET status = 'failed', total_cost_usd = 9.39 WHERE id = 'run'").run()
  createPrDelivery(db, { id: 'delivery', railIndex: 3, loopId: 'implement', railKey: '3-implement', ticketIds: [4], baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard' })
  transitionDecision(db, 'delivery', 'building', 'implementation_failed', { runIds: ['run'], branches: [{ runId: 'run', ticketId: 4, branch: 'feat/notes', succeeded: false, initialSha: 'a'.repeat(40), worktreePath: root }], implementationOutcome: 'failed', deliveryOutcome: 'blocked' })
  appendEvent(db, 'run', 0, { event_type: 'loop_step', source: 'stdout', payload: JSON.stringify({ index: 1, nodeId: 'main', kind: 'ai-step', template: '{{cmd:implement}}' }) })
  appendEvent(db, 'run', 1, { event_type: 'loop_step_end', source: 'stdout', payload: JSON.stringify({ index: 1, nodeId: 'main', status: 'failed', durationMs: 200 }) })
  const commit = vi.fn().mockResolvedValue({ clean: true, staged: true, committed: true, dirty: [] })
  const git = { run: vi.fn(async (args: string[]) => ({ code: 0, stdout: args[0] === 'branch' ? 'feat/notes' : 'b'.repeat(40), stderr: '' })) }
  const input = { db, projectId: 'p', runId: 'run', contextPath, cwd: root, env: {} }
  try {
    const action = settleRuntimeContinuation(input, { verify: () => ({ valid, reason: valid ? undefined : 'Stale receipt' }), git, commit })
    if (!valid) {
      await expect(action).rejects.toThrow('Stale receipt')
      expect(commit).not.toHaveBeenCalled()
      expect(getPrDelivery(db, 'delivery')?.decision).toBe('implementation_failed')
    } else {
      await action
      expect(getPrDelivery(db, 'delivery')).toMatchObject({ decision: 'on_review', implementation_outcome: 'succeeded', delivery_outcome: 'ready', status_detail: null, operation_token: null })
      expect(db.prepare("SELECT status,total_cost_usd FROM jobs WHERE id='run'").get()).toEqual({ status: 'completed', total_cost_usd: 9.39 })
      await settleRuntimeContinuation(input, { verify: () => ({ valid: true }), git, commit })
      expect(commit).toHaveBeenCalledTimes(1)
      const ends = db.prepare("SELECT payload FROM events WHERE job_id='run' AND event_type='loop_step_end' ORDER BY seq").all() as Array<{payload:string}>
      expect(ends.map(e => JSON.parse(e.payload).status)).toEqual(['failed', 'ok'])
      const completion = db.prepare("SELECT payload FROM events WHERE job_id='run' AND event_type='loop_completion' ORDER BY seq DESC LIMIT 1").get() as {payload:string}
      expect(JSON.parse(completion.payload).core).toEqual(await readCoreCompletion(input))
    }
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
