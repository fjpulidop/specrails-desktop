import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DbInstance } from '../../../db'
import { claimDefinitionExecution, getLoopRun, readDefinitionExecutionClaim, readDefinitionForkTarget } from '../../loops/runtime/loop-runs-store'
import { collectUnreferencedRuntimePackages } from './agent-runtime-package'
import { runtimeJournalQuarantine, recoverRuntimeQuarantine } from './agent-runtime-retention-quarantine'
import { readRuntimeExpiration } from './agent-runtime-retention-records'
import type { RuntimeRetentionPolicy, RuntimeRetentionPorts } from './agent-runtime-retention'

interface RetentionCoreState {
  runId: string; status: string; engineVersion?: number
  lease?: { active: boolean } | null
  pendingInterrupts?: unknown[]
  pendingQuestion?: unknown; pendingApproval?: unknown
  recoverableSteps?: unknown[]
  steps: Record<string, { status: string }>
}
export interface RuntimeRetentionHost {
  db: DbInstance
  projectId: string
  pipelineRoot: string
  active(runId: string): boolean
  /** Validates the original context synchronously before an execution claim. */
  scope(runId: string): { repositoryMounts: string[]; inspect(): Promise<RetentionCoreState | null> }
}
function terminalTime(value: string | null): string | null {
  if (!value) return null
  return /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value
}
function deliveryState(db: DbInstance, runId: string): { pending: boolean; discarded: boolean } {
  const rows = db.prepare('SELECT run_ids,decision,operation_token FROM rail_pr_deliveries').all() as Array<{ run_ids: string; decision: string; operation_token: string | null }>
  const relevant = rows.filter(row => {
    const ids = JSON.parse(row.run_ids)
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Unknown delivery run ownership')
    return ids.includes(runId)
  })
  return { pending: relevant.some(row => row.operation_token !== null || !['completed', 'merged', 'discarded', 'superseded'].includes(row.decision)),
    discarded: relevant.length > 0 && relevant.every(row => ['discarded', 'superseded'].includes(row.decision)) }
}
export function runtimeRetentionHostPorts(host: RuntimeRetentionHost, policy: RuntimeRetentionPolicy, now: number): RuntimeRetentionPorts {
  const owner = 'retention:' + randomUUID()
  return {
    async runIds() {
      // Children settle later than parents. Expire a child before reconsidering
      // its parent's lineage; unexpired descendants continue protecting it.
      return (host.db.prepare("SELECT id FROM loop_runs WHERE project_id=? AND status='completed' ORDER BY finished_at DESC,id").all(host.projectId) as Array<{ id: string }>)
        .map(row => row.id).filter(id => !readRuntimeExpiration(host.db, id) && fs.existsSync(path.join(host.pipelineRoot, id, 'agent-runtime-request.json')))
    },
    async reserve(runId) {
      if (host.active(runId)) return null
      const scope = host.scope(runId)
      const claim = claimDefinitionExecution(host.db, runId, { owner, repositoryMounts: scope.repositoryMounts })
      if (!claim.ok) return null
      try {
        const state = await scope.inspect(), row = getLoopRun(host.db, runId)
        if (!state || state.runId !== runId || !row || row.project_id !== host.projectId || readDefinitionExecutionClaim(host.db, runId)?.owner !== owner) throw new Error('Runtime retention authority changed')
        const job = host.db.prepare('SELECT status FROM jobs WHERE id=?').get(runId) as { status: string } | undefined
        const delivery = deliveryState(host.db, runId)
        const terminal = ['succeeded', 'cancelled', 'failed'].includes(state.status)
        const settled = row.status === 'completed' && job?.status === 'completed' && row.final_outcome === 'success' && state.status === 'succeeded'
        const discarded = row.status === 'completed' && delivery.discarded && terminal
        const fork = readDefinitionForkTarget(host.db, runId)
        const evidence = {
          runId, disposition: settled ? 'settled' as const : discarded ? 'discarded' as const : 'recoverable' as const,
          terminalAt: terminalTime(row.finished_at), active: host.active(runId) || row.status !== 'completed' || !terminal || state.lease?.active === true || state.engineVersion === 2 && state.lease === undefined,
          humanPending: state.engineVersion === 2 && !Array.isArray(state.pendingInterrupts) || !!state.pendingQuestion || !!state.pendingApproval || !!state.pendingInterrupts?.length,
          interruptedWrites: state.engineVersion === 2 && !Array.isArray(state.recoverableSteps) || !!state.recoverableSteps?.length || Object.values(state.steps).some(step => ['running', 'interrupted', 'paused'].includes(step.status)),
          deliveryPending: delivery.pending || !job || !['completed', 'failed', 'canceled', 'cancelled'].includes(job.status),
          forkPending: !!fork && !readRuntimeExpiration(host.db, fork),
        }
        return { evidence, ...runtimeJournalQuarantine(host.db, host.pipelineRoot, {
          runId, expiredAt: new Date(now).toISOString(), disposition: discarded ? 'discarded' : 'settled', previousStatus: state.status,
          summary: { status: state.status, engineVersion: state.engineVersion ?? 1, nextStep: null, historical: true },
        }), release: claim.release }
      } catch (error) { claim.release(); throw error }
    },
    async collectUnreferencedPackages(dryRun) {
      return policy.days === null ? [] : collectUnreferencedRuntimePackages(host.pipelineRoot, { dryRun, minimumAgeMs: policy.days * 86_400_000, now })
    },
  }
}
export function recoverHostRuntimeRetention(host: Pick<RuntimeRetentionHost, 'db' | 'pipelineRoot' | 'active'>) {
  return recoverRuntimeQuarantine(host.db, host.pipelineRoot, runId => {
    if (host.active(runId)) return null
    const claim = claimDefinitionExecution(host.db, runId, { owner: 'retention-recovery:' + randomUUID(), repositoryMounts: [] })
    return claim.ok ? claim.release : null
  })
}
