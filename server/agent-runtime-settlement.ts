import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { appendEvent, type DbInstance } from './db'
import { checkCoreCompletion } from './core-execution'
import { readCoreCompletion } from './core-completion'
import { commitWorktreeAndVerify, defaultGitRunner } from './worktree-manager'
import { claimPrDeliveryOperation, releasePrDeliveryOperation, transitionClaimedDecision, getPrDelivery, toPrDeliverySnapshot, toRailPrStateMessage, type RailPrDeliveryRow } from './rail-pr-store'
import { refreshRepositoryDeliveryGroup } from './multi-repo-execution'
import type { WsMessage } from './types'

/** Complete the host's local settlement after Core recovery. Never pushes or merges. */
export async function settleRuntimeContinuation(input: {
  db: DbInstance; projectId: string; runId: string; contextPath: string; cwd: string; env: NodeJS.ProcessEnv; broadcast?: (message: WsMessage) => void
}, dependencies = { verify: checkCoreCompletion, git: defaultGitRunner, commit: commitWorktreeAndVerify }): Promise<void> {
  const { db, runId } = input
  const verified = dependencies.verify(input.contextPath, input.cwd, input.env, runId)
  if (!verified.valid) throw new Error(verified.reason ?? 'Core completion is not verified')
  const frozen = JSON.parse(fs.readFileSync(input.contextPath, 'utf8')) as { runId: string; repositories: Array<{ path: string }> }
  if (frozen.runId !== runId) throw new Error('Runtime identity changed')
  const all = (db.prepare('SELECT * FROM rail_pr_deliveries').all() as RailPrDeliveryRow[]).filter(row => toPrDeliverySnapshot(row).runIds.includes(runId))
  const parents = new Set(all.map(row => row.parent_delivery_id).filter((id): id is string => !!id))
  const rows = all.filter(row => !parents.has(row.id) && row.decision === 'implementation_failed')
  if (all.some(row => parents.has(row.id) && ['discarded', 'superseded', 'merged', 'completed'].includes(row.decision))) throw new Error('Delivery is no longer available for recovery')
  const token = randomUUID(), claimed: RailPrDeliveryRow[] = []
  const updates: Array<{ row: RailPrDeliveryRow; branches: ReturnType<typeof toPrDeliverySnapshot>['branches'] }> = []
  const gitText = async (args: string[], cwd: string) => {
    const result = await dependencies.git.run(args, cwd)
    if (result.code !== 0) throw new Error(`Cannot inspect recovered worktree: ${result.stderr}`)
    return result.stdout.trim()
  }
  try {
    // Claim the entire group before Git effects; a concurrent discard must win or lose atomically.
    db.transaction(() => {
      for (const row of all.filter(row => parents.has(row.id) || rows.includes(row))) {
        if (!claimPrDeliveryOperation(db, row.id, row.decision, 'recover-and-retry', token)) throw new Error('Delivery is busy; retry settlement after its current operation')
        claimed.push(row)
      }
    })()
    for (const row of rows) {
      if (row.pr_url) throw new Error('An existing PR requires explicit delivery recovery')
      if (!toPrDeliverySnapshot(row).branches.some(unit => unit.runId === runId)) throw new Error('Delivery has no branch recorded for this runtime')
      for (const unit of toPrDeliverySnapshot(row).branches.filter(unit => unit.runId === runId)) {
        if (!unit.worktreePath || !frozen.repositories.some(repo => repo.path === unit.worktreePath) || fs.realpathSync(unit.worktreePath) !== unit.worktreePath) throw new Error('Recovered worktree no longer matches the frozen runtime scope')
        if (await gitText(['branch', '--show-current'], unit.worktreePath) !== unit.branch) throw new Error('Recovered worktree branch changed')
      }
    }
    for (const row of rows) {
      const branches = toPrDeliverySnapshot(row).branches
      for (const unit of branches.filter(unit => unit.runId === runId)) {
        const result = await dependencies.commit(dependencies.git, unit.worktreePath!, `specrails: ticket-${unit.ticketId} recovered (run ${runId})`, unit.overlayExcludes ?? [])
        if (!result.clean || result.error) throw new Error(result.error ?? 'Recovered worktree still contains uncommitted changes')
        const sha = await gitText(['rev-parse', 'HEAD'], unit.worktreePath!)
        if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error('Invalid recovered commit')
        Object.assign(unit, { succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: sha !== unit.initialSha ? 'ready' : 'no_changes', finalSha: sha, changed: sha !== unit.initialSha, failureCode: null })
      }
      updates.push({ row, branches })
    }
    const finalCheck = dependencies.verify(input.contextPath, input.cwd, input.env, runId)
    if (!finalCheck.valid) throw new Error(finalCheck.reason ?? 'Candidate changed during settlement')
    const core = await readCoreCompletion(input)
    db.transaction(() => {
      for (const { row, branches } of updates) {
        const ready = branches.every(unit => unit.succeeded)
        const noChanges = ready && branches.every(unit => unit.changed === false)
        if (!transitionClaimedDecision(db, row.id, row.decision, noChanges ? 'no_changes' : 'on_review', token, {
          branches, implementationOutcome: ready ? 'succeeded' : 'partially_succeeded', deliveryOutcome: noChanges ? 'no_changes' : 'ready',
          statusCode: noChanges ? 'no_changes' : ready ? 'ready_for_review' : 'partial_success', statusDetail: null,
          ...(branches.length === 1 ? { deliverySha: branches[0].finalSha } : {}),
        })) throw new Error('Delivery changed during runtime settlement')
        for (const unit of branches.filter(unit => unit.runId === runId)) db.prepare("UPDATE rail_worktrees SET merge_state = 'built', updated_at = datetime('now') WHERE run_id = ? AND worktree_path = ?").run(runId, unit.worktreePath)
      }
      for (const parentId of parents) refreshRepositoryDeliveryGroup(db, parentId)
      db.prepare("UPDATE jobs SET status = 'completed', exit_code = 0 WHERE id = ?").run(runId)
      db.prepare("UPDATE loop_runs SET status = 'completed', final_outcome = 'success' WHERE id = ?").run(runId)
      let seq = (db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM events WHERE job_id = ?').get(runId) as { seq: number }).seq
      const lastStep = db.prepare("SELECT payload FROM events WHERE job_id = ? AND event_type = 'loop_step' ORDER BY seq DESC LIMIT 1").get(runId) as { payload: string } | undefined
      const lastEnd = db.prepare("SELECT payload FROM events WHERE job_id = ? AND event_type = 'loop_step_end' ORDER BY seq DESC LIMIT 1").get(runId) as { payload: string } | undefined
      if (lastStep && lastEnd) {
        const step = JSON.parse(lastStep.payload), end = JSON.parse(lastEnd.payload)
        // Supersede only this implementation step, never an unrelated shell/decider failure.
        if (step.kind === 'ai-step' && step.template === '{{cmd:implement}}' && end.index === step.index && end.nodeId === step.nodeId && end.status === 'failed') {
          const job = db.prepare('SELECT duration_ms FROM jobs WHERE id = ?').get(runId) as { duration_ms: number | null }
          appendEvent(db, runId, seq++, { event_type: 'loop_step_end', source: 'stdout', payload: JSON.stringify({ index: step.index, nodeId: step.nodeId, status: 'ok', exitCode: 0, durationMs: job.duration_ms ?? end.durationMs, recovered: true }) })
        }
      }
      const oldCompletion = db.prepare("SELECT payload FROM events WHERE job_id = ? AND event_type = 'loop_completion' ORDER BY seq DESC LIMIT 1").get(runId) as { payload: string } | undefined
      let previous: Record<string, unknown> = {}
      try { previous = oldCompletion ? JSON.parse(oldCompletion.payload) : {} } catch { /* old event format */ }
      const usage = db.prepare('SELECT total_cost_usd,num_turns FROM jobs WHERE id = ?').get(runId) as { total_cost_usd: number | null; num_turns: number | null }
      appendEvent(db, runId, seq, { event_type: 'loop_completion', source: 'stdout', payload: JSON.stringify({ ...previous, version: 1, execution: 'success', core, turns: usage.num_turns, costUsd: usage.total_cost_usd, recovered: true }) })
      appendEvent(db, runId, seq + 1, { event_type: 'log', source: 'stdout', payload: JSON.stringify({ line: '[runtime] Recovery verified and local delivery prepared for review. The original failed attempt remains in history. No PR was published.' }) })
    })()
  } finally { for (const row of claimed) releasePrDeliveryOperation(db, row.id, token) }
  for (const id of new Set([...updates.map(update => update.row.id), ...parents])) {
    const row = getPrDelivery(db, id)
    try { if (row) input.broadcast?.(toRailPrStateMessage(input.projectId, toPrDeliverySnapshot(row))) } catch { /* durable state remains authoritative */ }
  }
  const events = db.prepare('SELECT seq,event_type,source,payload,timestamp FROM events WHERE job_id = ? ORDER BY seq DESC LIMIT 3').all(runId) as Array<{ seq: number; event_type: string; source: string; payload: string; timestamp: string }>
  for (const event of events.reverse()) {
    try { input.broadcast?.({ type: 'event', projectId: input.projectId, jobId: runId, ...event }) } catch { /* replay remains available */ }
  }
}
