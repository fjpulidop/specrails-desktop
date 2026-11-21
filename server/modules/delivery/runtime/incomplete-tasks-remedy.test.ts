import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { createLoopRun, saveDefinitionRun, type LoopRunRequest } from '../../loops/runtime/loop-runs-store'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import { serializeDiagnosis } from '../../recovery'
import { IncompleteTasksRemedyError, prepareIncompleteTasksFork } from './incomplete-tasks-remedy'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function fixture(options: { tagged: boolean; kind?: string; unblocked?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remedy-')); dirs.push(root)
  const pipeline = path.join(root, '.specrails', 'pipeline', 'run-1'), worktree = path.join(root, 'wt')
  fs.mkdirSync(pipeline, { recursive: true }); fs.mkdirSync(path.join(worktree, 'openspec', 'changes', 'runtime-abc'), { recursive: true })
  fs.writeFileSync(path.join(pipeline, 'desktop-context.json'), JSON.stringify({ runId: 'run-1', artifactRoot: worktree }))
  fs.writeFileSync(path.join(pipeline, 'agent-runtime-request.json'), JSON.stringify({ change: 'runtime-abc' }))
  const tasks = path.join(worktree, 'openspec', 'changes', 'runtime-abc', 'tasks.md')
  fs.writeFileSync(tasks, '- [x] 1.1 Build it\n- [ ] 4.1 README: visual-review note\n')
  const db: DbInstance = initDb(':memory:')
  createLoopRun(db, { id: 'run-1', projectId: 'project', loopId: 'factory:implement', iterationLimit: 12, startedAt: '2026-11-18T18:00:00Z' })
  const request: LoopRunRequest = { runId: 'run-1', projectId: 'project', loopId: 'factory:implement', cwd: worktree, provider: 'claude', model: 'sonnet',
    graph: { nodes: [], edges: [], config: { maxIterations: 12, timeoutMinutes: 0 } } }
  const nodes = { developer: { params: {} }, tasks: { params: {} }, unblock: { params: { prompt: options.tagged ? 'add the [human] tag right after its task number' : 'tick it in tasks.md' } } }
  saveDefinitionRun(db, 'run-1', { request, contextPath: path.join(pipeline, 'desktop-context.json'), definition: { nodes } })
  db.prepare('UPDATE loop_runs SET failure_diagnosis=? WHERE id=?').run(serializeDiagnosis({ kind: (options.kind ?? 'incomplete_tasks') as never, confidence: 'high', phase: 'implementation-stalled', rounds: null, resetAt: null,
    detail: null, resumablePhase: null, blocker: null, incompleteTasks: ['4.1 README: visual-review note'], source: 'desktop' }), 'run-1')
  const scopes = [{ nodePath: 'developer', scopeId: 'root', kind: 'role-turn', status: 'succeeded', attemptId: 'a', visits: 2 }, { nodePath: 'tasks', scopeId: 'root', kind: 'artifact-contract', status: 'succeeded', attemptId: 'b', visits: 2 },
    ...(options.unblocked ? [{ nodePath: 'unblock-tasks', scopeId: 'root', kind: 'artifact-contract', status: 'succeeded', attemptId: 'c', visits: 1 }] : [])]
  const probe = { runId: 'run-1', engineVersion: 2, status: 'failed', resumable: false, lease: null, recoverableSteps: [], pendingInterrupts: [], completion: null, scopes, coreRevision: 1, eventCursor: 1, probedAt: '' } as DefinitionRunProbe
  return { db, probe, tasks }
}

describe('incomplete tasks remedies', () => {
  it('continue to review: tags what is left on a Core that understands the tag, then re-checks tasks where the run last did', () => {
    const f = fixture({ tagged: true, unblocked: true })
    const request = prepareIncompleteTasksFork(f.db, 'run-1', 'continue-to-review', f.probe)
    expect(request).toMatchObject({ fromNodePath: 'unblock-tasks', scopeId: 'root', visit: 1, state: { $vars: { humanChecks: ['4.1 README: visual-review note'] } } })
    expect(fs.readFileSync(f.tasks, 'utf8')).toBe('- [x] 1.1 Build it\n- [ ] 4.1 [human] README: visual-review note\n')
    // Idempotent per run and remedy: a second click forks once.
    expect(prepareIncompleteTasksFork(f.db, 'run-1', 'continue-to-review', f.probe).requestId).toBe(request.requestId)
  })
  it('continue to review on an older Core ticks the task and keeps it in humanChecks', () => {
    const f = fixture({ tagged: false })
    expect(prepareIncompleteTasksFork(f.db, 'run-1', 'continue-to-review', f.probe)).toMatchObject({ fromNodePath: 'tasks', visit: 2, state: { $vars: { humanChecks: ['4.1 README: visual-review note'] } } })
    expect(fs.readFileSync(f.tasks, 'utf8')).toContain('- [x] 4.1 README: visual-review note')
  })
  it('retry with the browser restarts the developer with fresh budgets and edits nothing', () => {
    const f = fixture({ tagged: true })
    expect(prepareIncompleteTasksFork(f.db, 'run-1', 'retry-with-browser', f.probe)).toMatchObject({ fromNodePath: 'developer', visit: 2,
      state: { $vars: { implementationAttempts: 0, unblockAttempts: 0, lastImplementationHash: '' } } })
    expect(fs.readFileSync(f.tasks, 'utf8')).toContain('- [ ] 4.1 README')
  })
  it('refuses another diagnosis or a run that is still active', () => {
    const other = fixture({ tagged: true, kind: 'tests_failed' })
    expect(() => prepareIncompleteTasksFork(other.db, 'run-1', 'continue-to-review', other.probe)).toThrow(IncompleteTasksRemedyError)
    const live = fixture({ tagged: true })
    expect(() => prepareIncompleteTasksFork(live.db, 'run-1', 'retry-with-browser', { ...live.probe, status: 'running' })).toThrow(/Only a failed run/)
  })
})
