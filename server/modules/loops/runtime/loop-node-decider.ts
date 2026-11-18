/**
 * Legacy `decider` node executor: closes one iteration with a structured,
 * read-only AI verdict over the run history and spec, records it, and routes
 * continue/stop/blocked — enforcing maxIterations, the failed-pass repair
 * rule and the non-convergence (unchanged working tree) guard.
 */
import { executionManifestPrompt } from '../../delivery/runtime/multi-repo-execution-store'
import { interpolateSpec } from './loop-graph'
import { resolveConstants } from './loop-constants'
import { buildDeciderSystemPrompt, buildDeciderUserPrompt } from './loop-decider'
import { updateLoopRunCounters } from './loop-runs-store'
import { recordStepResult, stageAiAccounting } from './loop-run-ledger'
import { awaitHumanDecision } from './loop-run-pauses'
import { DISPOSED, next, runCounters, settle, type LoopNodeFrame, type LoopRunContext, type NodeStep } from './loop-run-context'
import type { LoopNode } from './loop-graph'

const NO_PROGRESS_LIMIT = 2

export interface DeciderRouting {
  byId: Map<string, LoopNode>
  /** The first step of the body (the start node's successor). */
  firstStepId: string | undefined
}

// Non-convergence guard: if two consecutive 'continue' iterations
// leave the working tree byte-identical, the loop isn't progressing
// (e.g. verify keeps passing a baseline while the feature is never
// written) — abort `stalled` rather than cycle to the cap.
async function workingTreeUnchanged(ctx: LoopRunContext): Promise<boolean> {
  const { host, req, state } = ctx
  const dirs = req.executionManifest?.repositories.map((repo) => repo.worktreePath) ?? [req.repoDir ?? req.cwd]
  const hashes = await Promise.all(dirs.map((dir) => host.executors.repoStateHash!(dir)))
  const hash = hashes.some((value) => value === null) ? null : JSON.stringify(hashes)
  // null = couldn't read the tree → skip (never let null match null).
  if (hash === null) return false
  if (hash === state.lastRepoHash) {
    state.consecutiveNoProgress += 1
    if (state.consecutiveNoProgress >= NO_PROGRESS_LIMIT) return true
  } else {
    state.consecutiveNoProgress = 0
  }
  state.lastRepoHash = hash
  return false
}

export async function executeDeciderNode(ctx: LoopRunContext, frame: LoopNodeFrame, routing: DeciderRouting): Promise<NodeStep> {
  const { host, req, runId, state } = ctx
  const { emitStep, emitStepEnd, logLine } = ctx.events
  const { maxIterations } = ctx.limits
  const { node, succs, label } = frame
  if (state.iteration >= maxIterations) return settle('max-iterations')
  state.iteration += 1
  const goal = resolveConstants(interpolateSpec(String(node.data?.goal ?? 'The loop goal is met.'), req.spec), ctx.constMap)
  // `iteration` was just incremented — it IS this pass's 1-based number.
  emitStep('decider', `🔍 ${label || 'Loop Decider'} (iteration ${state.iteration}${req.deciderEngine ? `, ${req.deciderEngine.provider}/${req.deciderEngine.model}` : ''})`, node.id, state.iteration)
  logLine(`Goal: ${goal}`)
  // BUG-32: capture the real Decider start BEFORE the await (see AI step).
  const deciderStart = new Date(host.now()).toISOString()
  const deciderRecoveryKey = stageAiAccounting(
    ctx, 'decider', node.id, `loop:${runId}:decider`, deciderStart,
  )
  let dec = await host.executors.runDecider({
    systemPrompt: buildDeciderSystemPrompt(),
    // Give the Decider the spec so it can verify completeness against the
    // FULL scope instead of trusting a step's self-reported success.
    userPrompt: [executionManifestPrompt(req.executionManifest), buildDeciderUserPrompt({ goal, history: ctx.history, spec: req.spec })].filter(Boolean).join('\n\n'),
    provider: req.deciderEngine?.provider ?? frame.provider,
    model: req.deciderEngine?.model ?? frame.model,
    effort: req.deciderEngine ? req.deciderEngine.effort : frame.effort,
    cwd: req.cwd,
    repoDir: req.repoDir, executionManifest: req.executionManifest,
    onLine: logLine,
    onRawLine: ctx.events.onRawLine,
    onSpawn: (c) => host.setActiveChild(runId, c),
    timeoutMs: Math.min(3 * 60_000, Math.max(1, state.deadline - host.now())),
  })
  if (host.isDisposed()) return DISPOSED
  host.clearActiveChild(runId)
  if ((!dec.parsed || state.passFailed) && !dec.blocked && !dec.continue) {
    dec = { ...dec, continue: true, reasoning: `A required step failed in this pass; repair and verify before completion. ${dec.reasoning}` }
  }
  // A parseable Decider verdict means this AI invocation (SAME
  // provider/model) succeeded → the provider is alive, so clear any
  // ai-step failure streak. This stops a false fail-fast abort when an
  // ai-step blips but the provider is demonstrably up. (When the provider
  // is truly down the Decider also fails → parsed=false → no reset.)
  if (dec.parsed) state.consecutiveAiFailures = 0
  const verdictWord = dec.blocked ? 'blocked' : dec.continue ? 'continue' : 'stop'
  // BUG-03: a Decider that couldn't parse a verdict (dec.parsed === false)
  // is a failed AI invocation — record it as such, not as success.
  recordStepResult(
    ctx,
    `loop:${runId}:decider`,
    { ...dec, failed: !dec.parsed },
    deciderStart,
    deciderRecoveryKey,
  )
  host.clearActiveStepRecovery(runId)
  logLine(`Decision: ${verdictWord} — ${dec.reasoning}`)
  // The verdict line above is the decider step's last output. `decision`
  // is the route actually taken (an unparseable verdict defaults to
  // continue AND flags the step failed — mirrors record()'s status).
  emitStepEnd({
    status: dec.parsed ? 'ok' : 'failed',
    durationMs: dec.durationMs,
    decision: dec.continue ? 'continue' : 'stop',
  })
  ctx.history.push(`Decider: ${verdictWord} — ${dec.reasoning}`)
  updateLoopRunCounters(host.db, runId, runCounters(state))
  host.emit({
    type: 'loop.run_progress',
    projectId: req.projectId,
    loopRunId: runId,
    iteration: state.iteration,
    activeNode: node.id,
    reasoning: dec.reasoning,
  })
  // Route by the edge's explicit `branch` (the Decider's two named
  // source handles: 'continue' / 'stop'). Legacy graphs authored before
  // labeled branches carry no `branch` — fall back to the original
  // successor-node-type heuristic (continue → first non-end, stop →
  // first end) so old loops keep running identically.
  const out = req.graph.edges.filter((e) => e.source === node.id)
  const branchTarget = (b: 'continue' | 'stop'): string | undefined =>
    out.find((e) => e.branch === b)?.target
  const ends = succs.filter((n) => n.type === 'end')
  const conts = succs.filter((n) => n.type !== 'end')
  // BLOCKED: the loop is stuck on a human decision — halt now with a
  // dedicated outcome (NOT success) and surface the question. This is
  // the fix for the verify→fix cycle spinning on an unanswered scope
  // question the loop can't resolve on its own.
  if (dec.blocked) {
    const decision = await awaitHumanDecision(ctx, dec.reasoning)
    if (decision.action === 'stop') return settle('stopped')
    const target = branchTarget('continue') ?? conts[0]?.id ?? routing.firstStepId
    if (!target) return settle('failed')
    state.justContinued = true
    return next(target)
  }
  if (dec.continue && host.executors.repoStateHash && await workingTreeUnchanged(ctx)) {
    logLine(`\n■ Loop stalled — ${state.consecutiveNoProgress + 1} iterations changed nothing in the working tree; stopping instead of cycling.`, 'stderr')
    state.stallReason = 'no_progress'
    return settle('stalled')
  }
  if (dec.continue) {
    // Enforce the cap before another expensive implementation pass,
    // not after that extra pass reaches the next decider.
    if (state.iteration >= maxIterations) return settle('max-iterations')
    const target = branchTarget('continue') ?? conts[0]?.id
    if (target && routing.byId.get(target)?.type !== 'end') {
      state.passFailed = false
      // The next step acts on this verdict → let it see the history.
      state.justContinued = true
      // New iteration of an iterate-per-item loop → drop the resumed AI
      // session so the next pass starts fresh (re-reads the code on disk).
      // Provider-agnostic: clearing aiSessionId makes runAiStep use the
      // 'rail-job' (fresh) action, which every adapter maps to its own
      // native spawn — no claude/codex/gemini/kimi branching here.
      if (target === routing.firstStepId) state.aiSessionId = undefined
      return next(target)
    }
    return settle('failed')
  }
  const target = branchTarget('stop') ?? ends[0]?.id
  if (target) return next(target)
  return settle('success')
}
