/**
 * Legacy (engine 1) graph traversal: walks the published graph node by node,
 * enforcing the between-steps guards (cancel, deadline, step backstop, cost
 * cap, daily/run budget) and dispatching each node to its executor. Leaves the
 * run's outcome in `ctx.state.outcome`; settlement happens afterwards.
 */
import { findStartNode, nodesById, successors, type LoopNode } from './loop-graph'
import { awaitBudget } from './loop-run-pauses'
import { executeAiStepNode } from './loop-node-ai-step'
import { executeShellNode } from './loop-node-shell'
import { executeDeciderNode, type DeciderRouting } from './loop-node-decider'
import { next, settle, type LoopNodeFrame, type LoopRunContext, type NodeStep } from './loop-run-context'

/** Start / End / Condition and unknown kinds: pure routing, no execution. */
function routeControlNode(ctx: LoopRunContext, frame: LoopNodeFrame): NodeStep {
  const { node, succs } = frame
  switch (node.type) {
    case 'start':
      return next(succs[0]?.id)
    case 'end':
      return settle(node.data?.outcome === 'failure' || ctx.state.passFailed ? 'failed' : 'success')
    case 'condition':
      // Multiple branches have no implemented condition evaluator. Never
      // silently skip required branches and report a successful run.
      if (succs.length !== 1) {
        ctx.events.logLine('Condition branching is unsupported; replace it with explicit sequential steps or a Decider.', 'stderr')
        return settle('failed')
      }
      return next(succs[0]?.id)
    default:
      return next(succs[0]?.id)
  }
}

function executeNode(ctx: LoopRunContext, frame: LoopNodeFrame, routing: DeciderRouting): NodeStep | Promise<NodeStep> {
  switch (frame.node.type) {
    case 'ai-step': return executeAiStepNode(ctx, frame)
    case 'shell': return executeShellNode(ctx, frame)
    case 'decider': return executeDeciderNode(ctx, frame, routing)
    default: return routeControlNode(ctx, frame)
  }
}

function frameFor(ctx: LoopRunContext, node: LoopNode): LoopNodeFrame {
  const { req } = ctx
  return {
    node,
    succs: successors(req.graph, node.id),
    // User-given step name (shown in the run log header); falls back per-kind.
    label: String(node.data?.label ?? '').trim(),
    // The RAIL governs provider/model/effort for the whole run — nodes do
    // NOT override (decided in design: "lo que pongamos en el rail manda").
    // …except after a usage-limit pause the person continued on another provider.
    provider: ctx.state.engineOverride?.provider ?? req.provider,
    model: ctx.state.engineOverride?.model ?? req.model,
    effort: ctx.state.engineOverride ? undefined : req.effort,
  }
}

/** Traverse the graph until it settles. Returns 'disposed' when the manager
 *  shut down mid-step (startup recovery then owns the run). */
export async function runLegacyTraversal(ctx: LoopRunContext): Promise<'disposed' | undefined> {
  const { host, req, runId, state } = ctx
  const { maxIterations, maxCostUsd } = ctx.limits
  const byId = nodesById(req.graph)
  const start = findStartNode(req.graph)
  // The first step of the body (the start node's successor). When the Decider's
  // 'continue' edge routes BACK here, the whole body re-runs — that's an
  // iterate-per-item loop (strict TDD, story executors, …) whose per-pass state
  // lives in the code on disk, not the chat. We drop the resumed AI session at
  // that loop-back so each iteration starts FRESH (re-reading the current code),
  // keeping context bounded regardless of pass count. Within an iteration the
  // steps still resume, so RED→GREEN→REFACTOR share context.
  const firstStepId = start ? req.graph.edges.find((e) => e.source === start.id)?.target : undefined
  // Backstop against a cycle with no Decider (would otherwise never increment
  // `iteration`): cap total node executions well above any honest run.
  const stepCap = (maxIterations + 1) * (req.graph.nodes.length + 2) + 16
  let steps = 0
  // no start node → fall through to settle as failed
  if (!start) state.outcome = 'failed'
  let nodeId: string | undefined = start?.id
  while (nodeId) {
    if (host.isCancelled(runId)) { state.outcome = 'stopped'; return }
    if (host.now() >= state.deadline) { state.outcome = 'failed'; return }
    if (++steps > stepCap) { state.outcome = 'max-iterations'; return }
    // Cost cap: stop BEFORE the next step once prior steps crossed the budget.
    if (maxCostUsd !== undefined && state.totalCost >= maxCostUsd) {
      ctx.events.logLine(`\n■ Cost cap reached: $${state.totalCost.toFixed(4)} ≥ $${maxCostUsd.toFixed(2)} — stopping the loop.`, 'stderr')
      state.outcome = 'max-cost'
      return
    }

    const node = byId.get(nodeId)
    if (!node) { state.outcome = 'failed'; return }
    // Daily budget: checked BETWEEN AI steps (the launch gate covered the
    // first one). The current step always finishes; the next AI-bearing
    // node waits on a resumable `budget_paused` pause.
    if ((node.type === 'ai-step' || node.type === 'decider') && state.stepNum > 0) {
      const breach = host.budgetBreach(runId)
      if (breach && (await awaitBudget(ctx, breach)) === 'stop') { state.outcome = 'stopped'; return }
    }
    // Control nodes route synchronously: no await between them and the next step.
    const routed = executeNode(ctx, frameFor(ctx, node), { byId, firstStepId })
    const step = routed instanceof Promise ? await routed : routed
    if (step.kind === 'disposed') return 'disposed'
    if (step.kind === 'settle') { state.outcome = step.outcome; return }
    nodeId = step.nodeId
    // Ran off the end of the graph without an explicit End node.
    if (nodeId === undefined) state.outcome = 'failed'
  }
}
