import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopExecutors } from './loop-executors'
import { LoopRunManager, type LoopExecutors } from './loop-run-manager'
import { getFactoryLoop } from './loop-factory'
import { getJob, getJobEvents, initDb, type DbInstance } from './db'
import './providers'

vi.mock('./path-resolver', async importOriginal => ({
  ...await importOriginal<typeof import('./path-resolver')>(),
  resolveBundledNodeExe: () => process.execPath,
}))
const roots: string[] = []
const databases: DbInstance[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('implementation loop → installed Core status → durable outcome', () => {
  it.each([false, true])('uses the real runtime bridge after agent success (blocked=%s)', async blocked => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'loop-core-completion-'))); roots.push(cwd)
    const runtime = join(cwd, '.specrails', 'runtime'); mkdirSync(runtime, { recursive: true })
    const profile = join(cwd, 'profile.json')
    // Only the AI and the runtime's receipt are fixtures: the completion bridge
    // executes this status CLI with the same frozen context/profile as the step,
    // and the real engine persists its verdict over the agent's optimistic text.
    writeFileSync(join(runtime, 'pipeline.mjs'), `
      import { readFileSync } from 'node:fs';
      const args = process.argv.slice(2);
      const contextPath = args[args.indexOf('--context') + 1];
      if (args[0] !== 'status' || contextPath !== process.env.SPECRAILS_EXECUTION_CONTEXT
        || process.env.SPECRAILS_PROFILE_PATH !== ${JSON.stringify(profile)}) process.exit(2);
      const context = JSON.parse(readFileSync(contextPath, 'utf8'));
      console.log(JSON.stringify({
        schemaVersion: 1, runId: context.runId, resumePhase: ${JSON.stringify(blocked ? 'reviewer' : 'ship')},
        phases: Object.fromEntries(['architect', 'developer', 'reviewer', 'archive'].map(phase => [phase, { status: 'done' }])),
        completion: { implementation: 'complete', validation: ${JSON.stringify(blocked ? 'blocked' : 'verified')}, archive: 'done', delivery: 'pending-host' },
        verification: { valid: ${!blocked}, reasons: ${JSON.stringify(blocked ? ['Verification environment changed: npm'] : [])}, receipt: { kind: 'full', commands: [{ exitCode: 0 }] } }
      }));
    `)
    const production = createLoopExecutors({ env: {}, profilePathFor: () => profile })
    const executors: LoopExecutors = {
      runAiStep: vi.fn(async () => ({ text: 'All 127 tests pass. Implementation complete. VERIFICATION: PASS', tokens: 100 })),
      runDecider: vi.fn(), runShell: vi.fn(),
      validateCoreCompletion: production.validateCoreCompletion,
    }
    const db = initDb(':memory:'); databases.push(db)
    const result = await new LoopRunManager(db, () => undefined, executors).run({
      loopId: 'factory:implement', graph: getFactoryLoop('factory:implement')!.graph,
      projectId: 'project', cwd, provider: 'claude', model: 'sonnet', profileName: 'selected',
      spec: { id: 4, title: 'Local top 5 leaderboard', description: 'Persist the five best scores.' },
    })
    expect(result.outcome).toBe(blocked ? 'failed' : 'success')
    expect(getJob(db, result.runId)?.status).toBe(blocked ? 'failed' : 'completed')
    if (blocked) expect(getJobEvents(db, result.runId).some(event => event.payload.includes('Verification environment changed: npm'))).toBe(true)
  })
})
