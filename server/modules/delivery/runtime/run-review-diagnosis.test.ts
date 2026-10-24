import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import { createLoopRun } from '../../loops/runtime/loop-runs-store'
import { readRunReviewDiagnosis } from './run-review-diagnosis'
import { createPrDelivery, transitionDecision } from './rail-pr-store'
import type { DeliverySettleEvidence } from './delivery-evidence'

const dbs: DbInstance[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

function db(loopId: string, engineVersion: 1 | 2, runId = 'run-1'): DbInstance {
  const instance = initDb(':memory:')
  dbs.push(instance)
  createLoopRun(instance, { id: runId, projectId: 'p1', loopId, iterationLimit: 1, startedAt: '2026-10-22T12:00:00.000Z' })
  instance.prepare('UPDATE loop_runs SET engine_version = ? WHERE id = ?').run(engineVersion, runId)
  return instance
}

const derivation = { schemaVersion: 1, change: 'visual-effects', files: 9, explained: 6, unexplainedFiles: ['src/fx/shake.ts', 'src/fx/flash.ts', 'src/fx/trail.ts'], tasks: 4, requirementsAdded: 2, requirementsModified: 0, confidence: 'medium', transcriptTurnsUsed: 12 }

function definitionProbe(runId: string): DefinitionRunProbe {
  return {
    runId, engineVersion: 2, status: 'failed', resumable: false, lease: null, recoverableSteps: [], pendingInterrupts: [], completion: null, coreRevision: 2, eventCursor: 5, probedAt: 'now',
    scopes: [
      { nodePath: 'derive', scopeId: 'root', kind: 'derive-change', status: 'succeeded', attemptId: 'd1', output: { derivation } },
      { nodePath: 'verify', scopeId: 'root', kind: 'verify', status: 'succeeded', attemptId: 'v1', output: { receiptId: 'r', commands: [{ command: 'npm test', exitCode: 1 }, { command: 'npm run lint', exitCode: 0 }] } },
      { nodePath: 'review', scopeId: 'root', kind: 'implementation-step', status: 'succeeded', attemptId: 'rv1',
        output: { phase: 'reviewer', approved: false, score: 58, issues: Array.from({ length: 14 }, (_, i) => `issue ${i}`), summary: 'Line one\nLine two\n\nLine three\nLine four\nLine five\nLine six' } },
    ],
  }
}

describe('readRunReviewDiagnosis', () => {
  it('definition (engine 2) Flow → Spec run: reviewer verdict, failing checks and derivation coverage from the retained run', async () => {
    const instance = db('factory:flow-spec', 2)
    const probe = vi.fn(async (runIds: string[]) => new Map(runIds.map((id) => [id, definitionProbe(id)])))
    const diagnosis = await readRunReviewDiagnosis({ db: instance, runId: 'run-1', pipelineDir: '/nonexistent', probe })
    expect(probe).toHaveBeenCalledWith(['run-1'])
    expect(diagnosis).toMatchObject({
      source: 'retained-run',
      review: { approved: false, score: 58, summary: 'Line one\nLine two\nLine three\nLine four\nLine five', scopedReviewCount: 1 },
      failingChecks: [{ command: 'npm test', exitCode: 1 }],
      derivation: { change: 'visual-effects', files: 9, explained: 6, unexplainedFiles: ['src/fx/shake.ts', 'src/fx/flash.ts', 'src/fx/trail.ts'], confidence: 'medium' },
      flowOutcome: 'review',
    })
    // The harvest bounds the reviewer's issues (6); the diagnosis never re-parses them.
    expect(diagnosis!.review!.issues).toEqual(['issue 0', 'issue 1', 'issue 2', 'issue 3', 'issue 4', 'issue 5'])
  })

  it('legacy (engine 1) run: reads the reviewer checkpoint from the pipeline dir; no derivation outside Flow → Spec', async () => {
    const instance = db('factory:implement', 1)
    const pipelineDir = mkdtempSync(join(tmpdir(), 'review-diagnosis-'))
    const runDir = join(pipelineDir, 'run-1')
    mkdirSync(join(runDir, 'agent-workflow', 'run-1'), { recursive: true })
    writeFileSync(join(runDir, 'state.json'), JSON.stringify({ verification: { commands: [] }, acceptance: { checks: [], findings: [] } }))
    writeFileSync(join(runDir, 'agent-workflow', 'run-1', 'checkpoint.json'), JSON.stringify({ state: { steps: { reviewer: { output: { approved: false, score: 41, issues: ['Missing tests for the Options screen'], summary: 'Not ready' } } } } }))
    const probe = vi.fn(async () => new Map<string, DefinitionRunProbe>())
    const diagnosis = await readRunReviewDiagnosis({ db: instance, runId: 'run-1', pipelineDir, probe })
    expect(probe).not.toHaveBeenCalled()
    expect(diagnosis).toMatchObject({ source: 'retained-run', review: { approved: false, score: 41, issues: ['Missing tests for the Options screen'], summary: 'Not ready' }, failingChecks: [], derivation: null, flowOutcome: null })
  })

  it('prefers the delivery settle evidence when it holds the verdict (no probe)', async () => {
    const instance = db('factory:flow-spec', 2)
    createPrDelivery(instance, { id: 'delivery-1', railIndex: 0, loopId: 'factory:flow-spec', railKey: '0-factory:flow-spec', ticketIds: [8], baseBranch: 'main', loopName: 'Flow → Spec', originSurface: 'agent-chat', originConversationId: 'conv-1' })
    instance.prepare('UPDATE rail_pr_deliveries SET run_ids = ? WHERE id = ?').run(JSON.stringify(['run-1']), 'delivery-1')
    transitionDecision(instance, 'delivery-1', 'building', 'implementation_failed', {
      implementationOutcome: 'failed',
      settleEvidence: { schemaVersion: 1, harvest: 'ok', harvestedAt: 'now', units: [{ ticketId: 8, runId: 'run-1', sentinel: 'absent', sentinelDetail: null, verifyTail: null, confidence: null,
        runtime: { commands: [], checks: [], findings: [], review: { approved: false, score: 58, aspects: {}, issues: ['Tag the tests'], summary: 'Blocked' } } }] } as DeliverySettleEvidence,
    })
    const probe = vi.fn(async () => new Map<string, DefinitionRunProbe>())
    expect(await readRunReviewDiagnosis({ db: instance, runId: 'run-1', pipelineDir: '/nonexistent', probe })).toMatchObject({ source: 'settle-evidence', review: { score: 58, issues: ['Tag the tests'] }, flowOutcome: 'review' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('null when no source carries runtime evidence; never throws', async () => {
    const instance = db('factory:implement', 2)
    expect(await readRunReviewDiagnosis({ db: instance, runId: 'run-1', pipelineDir: '/nonexistent', probe: async () => new Map() })).toBeNull()
    expect(await readRunReviewDiagnosis({ db: instance, runId: 'run-1', pipelineDir: '/nonexistent', probe: async () => { throw new Error('core gone') } })).toBeNull()
  })
})
