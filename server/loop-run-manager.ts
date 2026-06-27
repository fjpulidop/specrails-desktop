/**
 * LoopRunManager — the app-driven engine that executes a published loop graph.
 *
 * The APP owns the iteration loop: it traverses the graph node-by-node,
 * increments the iteration counter at each Loop Decider, and enforces
 * maxIterations + timeout. The stop/continue verdict is produced by the Decider
 * NODE (an AI invocation), never by app heuristics. AI Step / Shell / Decider
 * execution is delegated to injected `executors` so the traversal, counting,
 * persistence, and event logic are unit-testable WITHOUT spawning real
 * processes; the production executors wire `runAiCliInvocation` + a shell spawn.
 *
 * Spec: openspec/changes/loop-builder/specs/loop-execution/spec.md
 */
import type { ChildProcess } from 'node:child_process'
import treeKill from 'tree-kill'
import { createJob, finishJob, appendEvent, type DbInstance } from './db'
import type { WsMessage, JobStatus } from './types'
import type { ReasoningEffort } from './providers/types'
import {
  type LoopGraph,
  type LoopSpec,
  nodesById,
  findStartNode,
  successors,
  interpolateSpec,
} from './loop-graph'
import { expandCommands } from './loop-command-catalog'
import { BUILTIN_CONSTANTS, resolveConstants } from './loop-constants'
import { buildDeciderSystemPrompt, buildDeciderUserPrompt, type DeciderDecision } from './loop-decider'
import {
  createLoopRun,
  updateLoopRunCounters,
  finishLoopRun,
  type LoopRunOutcome,
} from './loop-runs-store'
import { recordInvocation } from './ai-invocations'
import { newId } from './ids'

export interface AiStepResult {
  text: string
  sessionId?: string
  cost?: number
  tokens?: number
  durationMs?: number
  provider?: string
  model?: string
  estimated?: boolean
  /** True when the AI CLI hard-failed (spawn error or non-zero exit). */
  failed?: boolean
  /** The real failure reason (adapter error event, else stderr tail). */
  errorText?: string
}

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs?: number
}

export interface DeciderRunResult extends DeciderDecision {
  cost?: number
  tokens?: number
  durationMs?: number
  provider?: string
  model?: string
  estimated?: boolean
}

/** Streams a live activity line to the run's job log (AI text, tool use, shell
 *  output) so the session is inspectable in real time in JobDetail. */
export type LoopLogSink = (line: string, source?: 'stdout' | 'stderr') => void

/** Registers the spawned child so the engine can kill it on cancel/stop (a
 *  cooperative `_cancelled` flag alone can't interrupt a blocked `await`). */
export type LoopSpawnSink = (child: ChildProcess) => void

export interface LoopExecutors {
  runAiStep(input: {
    prompt: string
    sessionId?: string
    provider: string
    model: string
    effort?: ReasoningEffort
    cwd: string
    repoDir?: string
    onLine?: LoopLogSink
    onRawLine?: (line: string) => void
    onSpawn?: LoopSpawnSink
  }): Promise<AiStepResult>
  runShell(input: { command: string; cwd: string; onLine?: LoopLogSink; onSpawn?: LoopSpawnSink }): Promise<ShellResult>
  runDecider(input: {
    systemPrompt: string
    userPrompt: string
    provider: string
    model: string
    effort?: ReasoningEffort
    cwd: string
    repoDir?: string
    onLine?: LoopLogSink
    onRawLine?: (line: string) => void
    onSpawn?: LoopSpawnSink
  }): Promise<DeciderRunResult>
}

export interface LoopRunRequest {
  /** Pre-allocated run id (so the caller can track/cancel before completion).
   *  Defaults to a fresh id. */
  runId?: string
  loopId: string
  loopName?: string
  graph: LoopGraph
  projectId: string
  /** Spawn cwd (workspace when the project is relocated, else the repo). */
  cwd: string
  /** The repo dir when relocated (→ SPECRAILS_REPO_DIR + claude `--add-dir`), so
   *  native core slash commands run against the real repo. Undefined = legacy. */
  repoDir?: string
  railIndex?: number | null
  ticketId?: number | null
  spec?: LoopSpec
  /** name→value for `{{const:NAME}}` tokens (built-ins + custom global constants).
   *  Built-ins are always merged in by the engine, so a caller may omit this. */
  constants?: Record<string, string>
  provider: string
  model: string
  effort?: ReasoningEffort
}

export interface LoopRunResult {
  runId: string
  outcome: LoopRunOutcome
  iterations: number
  totalCostUsd: number
}

const HISTORY_MAX_CHARS = 1500
/** Abort the run after this many CONSECUTIVE AI steps hard-fail with no output.
 *  One failure can be transient; N in a row means the provider isn't running at
 *  all (quota, auth, crash) — bail instead of grinding to the iteration cap. */
const AI_FAILFAST_THRESHOLD = 2

/** Shrink a step's output for the Decider history. Keeps BOTH ends — the opening
 *  context AND the trailing lines — because the Decider keys off a final verdict
 *  line (e.g. `VERIFICATION: PASS`) that a head-only cut would silently drop. */
export function truncate(s: string, max = 600): string {
  if (s.length <= max) return s
  const head = Math.ceil(max * 0.6)
  const tail = max - head
  return s.slice(0, head) + '\n…\n' + s.slice(s.length - tail)
}

export class LoopRunManager {
  private readonly _cancelled = new Set<string>()
  /** The currently-spawned child per run, so cancel/stop can actually KILL a
   *  blocked spawn (the cooperative `_cancelled` flag can't interrupt an await). */
  private readonly _activeChild = new Map<string, ChildProcess>()

  constructor(
    private readonly db: DbInstance,
    private readonly broadcast: (msg: WsMessage) => void,
    private readonly executors: LoopExecutors,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Cancel an in-flight run: flag it AND kill the active spawned child so a
   *  blocked AI Step / Shell returns immediately (the engine then settles
   *  'stopped' at the next boundary). */
  cancel(runId: string): void {
    this._cancelled.add(runId)
    const child = this._activeChild.get(runId)
    if (child?.pid) {
      try { treeKill(child.pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* already gone */ }
    }
  }

  async run(req: LoopRunRequest): Promise<LoopRunResult> {
    const runId = req.runId ?? newId()
    const maxIterations = req.graph.config.maxIterations
    const timeoutMs = req.graph.config.timeoutMinutes * 60_000
    const deadline = this.now() + timeoutMs
    // Optional cost cap (USD). Like maxIterations/timeout, it's a BETWEEN-STEPS
    // guard: per-step cost is only known when that step's process exits, so the
    // loop is stopped before the NEXT step once the accumulated total crosses the
    // cap (may overshoot by at most one step). Honest accuracy caveat: for
    // non-Claude providers the per-step cost is ESTIMATED (rate card) — see the
    // fail-open warning below when a step yields no priced cost.
    const maxCostUsd = typeof req.graph.config.maxCostUsd === 'number' && req.graph.config.maxCostUsd > 0
      ? req.graph.config.maxCostUsd
      : undefined

    createLoopRun(this.db, {
      id: runId,
      projectId: req.projectId,
      loopId: req.loopId,
      loopName: req.loopName ?? null,
      railIndex: req.railIndex ?? null,
      ticketId: req.ticketId ?? null,
      provider: req.provider,
      model: req.model,
      reasoningEffort: req.effort ?? null,
      iterationLimit: maxIterations,
      startedAt: new Date(this.now()).toISOString(),
    })
    this.broadcast({
      type: 'loop.run_started',
      projectId: req.projectId,
      loopRunId: runId,
      loopId: req.loopId,
      railIndex: req.railIndex ?? null,
    })

    // Surface the run as a JOB so the full session streams live in the Jobs list
    // + JobDetail, exactly like implement/ultracode. The job id IS the run id;
    // createJob is idempotent. Synchronous (before the first await) so the row
    // exists by the time the launch responds → "View Log" never 404s.
    const jobCommand = `loop: ${req.loopName ?? req.loopId}${req.ticketId != null ? ` #${req.ticketId}` : ''}`
    try {
      createJob(this.db, { id: runId, command: jobCommand, started_at: new Date(this.now()).toISOString() })
    } catch { /* best-effort; the run still proceeds */ }
    let seq = 0
    let stepNum = 0
    // Emit a structured step-boundary event (for a segmented/collapsible client
    // view) AND a visual divider line in the flat log, so each loop step is a
    // clearly-delimited section.
    const emitStep = (kind: string, title: string): void => {
      stepNum += 1
      try {
        appendEvent(this.db, runId, seq, { event_type: 'loop_step', source: 'stdout', payload: JSON.stringify({ index: stepNum, kind, title }) })
      } catch { /* best-effort */ }
      this.broadcast({ type: 'event', jobId: runId, event_type: 'loop_step', source: 'stdout', payload: JSON.stringify({ index: stepNum, kind, title }), seq, timestamp: new Date(this.now()).toISOString() })
      seq += 1
      logLine(`\n━━━━━━ Step ${stepNum} · ${title} ━━━━━━`)
    }
    const logLine = (line: string, source: 'stdout' | 'stderr' = 'stdout'): void => {
      try {
        appendEvent(this.db, runId, seq, { event_type: 'log', source, payload: JSON.stringify({ line }) })
      } catch { /* events table best-effort */ }
      this.broadcast({ type: 'log', source, line, timestamp: new Date(this.now()).toISOString(), processId: runId })
      seq += 1
    }
    // Forward a RAW provider stdout line (claude/codex JSONL) as an `event` —
    // identical to QueueManager — so JobStatusPanel parses real activity
    // (thinking/reading/editing/tool steps) instead of staying on "Connecting…".
    // Non-JSON lines fall back to a plain log line.
    const onRawLine = (line: string): void => {
      if (!line) return
      let eventType: string | undefined
      try {
        const parsed = JSON.parse(line) as { type?: unknown }
        if (typeof parsed.type === 'string') eventType = parsed.type
      } catch { /* not JSON */ }
      if (!eventType) { logLine(line); return }
      try {
        appendEvent(this.db, runId, seq, { event_type: eventType, source: 'stdout', payload: line })
      } catch { /* best-effort */ }
      this.broadcast({ type: 'event', jobId: runId, event_type: eventType, source: 'stdout', payload: line, seq, timestamp: new Date(this.now()).toISOString() })
      seq += 1
    }
    logLine(`▶ Loop "${req.loopName ?? req.loopId}" started${req.spec?.title ? ` — spec: ${req.spec.title}` : ''}`)
    console.log(`[loop] start run=${runId} loop=${req.loopId} provider=${req.provider} model=${req.model} nodes=${req.graph.nodes.length} cwd=${req.cwd}`)

    const byId = nodesById(req.graph)
    const start = findStartNode(req.graph)

    let outcome: LoopRunOutcome = 'failed'
    let iteration = 0
    let totalCost = 0
    let totalTokens = 0
    let totalDuration = 0
    let aiSessionId: string | undefined
    // Consecutive AI steps that hard-failed with no output (provider down /
    // out of quota / crashing). Reset on any step that runs or produces output.
    let consecutiveAiFailures = 0
    // True for the step that runs immediately after a Decider 'continue' — that
    // step must see the cross-iteration history (the verdict it acts on). Mid-body
    // RESUMED steps already carry prior context in their session, so re-appending
    // the history there is redundant tokens; this flag keeps it off for them.
    let justContinued = false
    // Fail-open honesty: flips true the first time a cost-bearing step yields no
    // priced cost while a cap is set (non-Claude estimate / unknown model / a
    // failed step) → the cap can under-count, so we warn once in the run log.
    let costUnknownWarned = false
    // Built-ins always resolve even if the caller omitted `constants`; custom
    // values layer on top. Used to expand `{{const:*}}` in every node's text.
    const constMap = { ...BUILTIN_CONSTANTS, ...(req.constants ?? {}) }
    const history: string[] = []
    // Backstop against a cycle with no Decider (would otherwise never increment
    // `iteration`): cap total node executions well above any honest run.
    const stepCap = (maxIterations + 1) * (req.graph.nodes.length + 2) + 16
    let steps = 0

    const record = (refSuffix: string, r: { cost?: number; tokens?: number; durationMs?: number; provider?: string; model?: string; estimated?: boolean }) => {
      totalCost += r.cost ?? 0
      // Honest cost-cap caveat: a cost-bearing step that reports no figure means
      // the cap can't be enforced precisely from here on. Warn once (live).
      if (maxCostUsd !== undefined && r.cost == null && !costUnknownWarned) {
        costUnknownWarned = true
        logLine('⚠️ A step reported no priced cost (non-Claude estimate / unknown model / failed step) — the cost cap may under-count.', 'stderr')
      }
      totalTokens += r.tokens ?? 0
      totalDuration += r.durationMs ?? 0
      recordInvocation(this.db, {
        id: newId(),
        project_id: req.projectId,
        provider: r.provider ?? req.provider,
        surface: 'loop',
        surface_ref_id: refSuffix,
        ticket_id: req.ticketId ?? null,
        status: 'success',
        started_at: new Date(this.now()).toISOString(),
        total_cost_usd: r.cost,
        total_cost_usd_estimated: r.estimated ?? false,
        tokens_out: r.tokens,
        model: r.model ?? req.model,
        loop_run_id: runId,
      })
    }

    const composeHistory = (): string => {
      const joined = history.join('\n')
      return joined.length > HISTORY_MAX_CHARS ? '…' + joined.slice(-HISTORY_MAX_CHARS) : joined
    }

    // The first step of the body (the start node's successor). When the Decider's
    // 'continue' edge routes BACK here, the whole body re-runs — that's an
    // iterate-per-item loop (strict TDD, story executors, …) whose per-pass state
    // lives in the code on disk, not the chat. We drop the resumed AI session at
    // that loop-back so each iteration starts FRESH (re-reading the current code),
    // keeping context bounded regardless of pass count. Within an iteration the
    // steps still resume, so RED→GREEN→REFACTOR share context.
    const firstStepId = start ? req.graph.edges.find((e) => e.source === start.id)?.target : undefined

    try {
      let nodeId: string | undefined = start?.id
      let settled = !start // no start node → fall through to settle as failed
      if (!start) outcome = 'failed'

      while (nodeId && !settled) {
        if (this._cancelled.has(runId)) { outcome = 'stopped'; break }
        if (this.now() > deadline) { outcome = 'failed'; break }
        if (++steps > stepCap) { outcome = 'max-iterations'; break }
        // Cost cap: stop BEFORE the next step once prior steps crossed the budget.
        if (maxCostUsd !== undefined && totalCost >= maxCostUsd) {
          logLine(`\n■ Cost cap reached: $${totalCost.toFixed(4)} ≥ $${maxCostUsd.toFixed(2)} — stopping the loop.`, 'stderr')
          outcome = 'max-cost'
          break
        }

        const node = byId.get(nodeId)
        if (!node) { outcome = 'failed'; break }
        const succs = successors(req.graph, node.id)
        // The RAIL governs provider/model/effort for the whole run — nodes do
        // NOT override (decided in design: "lo que pongamos en el rail manda").
        const nodeProvider = req.provider
        const nodeModel = req.model
        const nodeEffort = req.effort
        // User-given step name (shown in the run log header); falls back per-kind.
        const nodeLabel = String(node.data?.label ?? '').trim()

        switch (node.type) {
          case 'start':
            nodeId = succs[0]?.id
            break
          case 'end':
            outcome = node.data?.outcome === 'failure' ? 'failed' : 'success'
            settled = true
            break
          case 'ai-step': {
            // Expand magic commands FIRST — `{{cmd:implement}}` becomes the
            // NATIVE per-provider invocation (claude `/specrails:implement #<id>
            // --yes`, codex `$implement #<id> --yes`) — then resolve `{{spec.*}}`
            // data tokens and finally `{{const:*}}` library constants.
            const rawTemplate = String(node.data?.prompt ?? '')
            const base = resolveConstants(
              interpolateSpec(
                expandCommands(rawTemplate, { provider: nodeProvider, ticketIds: req.spec?.ticketIds, specId: req.spec?.id }),
                req.spec
              ),
              constMap
            )
            // Inject the cross-iteration history only when there's no live session
            // to carry it (a fresh pass) OR right after a Decider 'continue' (so the
            // step sees the verdict). A mid-body resumed step already has it.
            const includeHistory = history.length > 0 && (!aiSessionId || justContinued)
            const prompt = includeHistory ? `${base}\n\n---\nContext from previous iterations:\n${composeHistory()}` : base
            justContinued = false
            emitStep('ai-step', `🤖 ${nodeLabel || 'AI Step'} (${nodeProvider}/${nodeModel}${nodeEffort ? `, effort: ${nodeEffort}` : ''})`)
            // Show the authored template AND the actual COMMAND sent. For magic
            // commands this is the short native invocation (so it's plainly visible
            // that `/specrails:implement` ran); a long free-text prompt is capped.
            logLine(`Template: ${rawTemplate.length > 1000 ? rawTemplate.slice(0, 1000) + '…' : rawTemplate}`)
            logLine(`Command: ${base.length > 2000 ? base.slice(0, 2000) + '…(truncated)' : base}`)
            const res = await this.executors.runAiStep({ prompt, sessionId: aiSessionId, provider: nodeProvider, model: nodeModel, effort: nodeEffort, cwd: req.cwd, repoDir: req.repoDir, onLine: logLine, onRawLine, onSpawn: (c) => this._activeChild.set(runId, c) })
            this._activeChild.delete(runId)
            // Only carry forward the session of a step that actually ran — a
            // hard-failed turn (codex still emits thread.started before its error)
            // would otherwise make the next step `--resume` a dead session.
            if (res.sessionId && !res.failed) aiSessionId = res.sessionId
            history.push(`AI Step: ${truncate(res.text)}`)
            record(`loop:${runId}`, res)
            // Fail-fast: a hard-failed step (non-zero exit / spawn error) that
            // produced NO output means the provider never really ran — quota,
            // auth, crash. One can be transient; AI_FAILFAST_THRESHOLD in a row
            // is systemic, so abort with the real reason instead of spinning to
            // the iteration cap (wasting wall-clock and, on paid providers, money).
            if (res.failed && !res.text.trim()) {
              consecutiveAiFailures += 1
              if (consecutiveAiFailures >= AI_FAILFAST_THRESHOLD) {
                logLine(`Loop aborted: provider appears down — ${consecutiveAiFailures} AI steps failed with no output and no successful AI call in between${res.errorText ? ` — ${res.errorText}` : ''}`, 'stderr')
                outcome = 'failed'
                settled = true
                break
              }
            } else {
              consecutiveAiFailures = 0
            }
            nodeId = succs[0]?.id
            break
          }
          case 'shell': {
            const command = resolveConstants(interpolateSpec(String(node.data?.command ?? ''), req.spec), constMap)
            emitStep('shell', `⚡ ${nodeLabel || 'Shell'}`)
            logLine(`$ ${command}`)
            const sh = await this.executors.runShell({ command, cwd: req.cwd, onLine: logLine, onSpawn: (c) => this._activeChild.set(runId, c) })
            this._activeChild.delete(runId)
            logLine(`(exit ${sh.exitCode})`)
            totalDuration += sh.durationMs ?? 0
            history.push(`Shell \`${command}\` exit=${sh.exitCode}: ${truncate(sh.stdout || sh.stderr)}`)
            nodeId = succs[0]?.id
            break
          }
          case 'decider': {
            if (iteration >= maxIterations) { outcome = 'max-iterations'; settled = true; break }
            iteration += 1
            const goal = resolveConstants(interpolateSpec(String(node.data?.goal ?? 'The loop goal is met.'), req.spec), constMap)
            emitStep('decider', `🔍 ${nodeLabel || 'Loop Decider'} (iteration ${iteration})`)
            logLine(`Goal: ${goal}`)
            const dec = await this.executors.runDecider({
              systemPrompt: buildDeciderSystemPrompt(),
              // Give the Decider the spec so it can verify completeness against the
              // FULL scope instead of trusting a step's self-reported success.
              userPrompt: buildDeciderUserPrompt({ goal, history, spec: req.spec ? { title: req.spec.title, description: req.spec.description } : undefined }),
              provider: nodeProvider,
              model: nodeModel,
              effort: nodeEffort,
              cwd: req.cwd,
              repoDir: req.repoDir,
              onLine: logLine,
              onRawLine,
              onSpawn: (c) => this._activeChild.set(runId, c),
            })
            this._activeChild.delete(runId)
            // A parseable Decider verdict means this AI invocation (SAME
            // provider/model) succeeded → the provider is alive, so clear any
            // ai-step failure streak. This stops a false fail-fast abort when an
            // ai-step blips but the provider is demonstrably up. (When the provider
            // is truly down the Decider also fails → parsed=false → no reset.)
            if (dec.parsed) consecutiveAiFailures = 0
            record(`loop:${runId}:decider`, dec)
            logLine(`Decision: ${dec.continue ? 'continue' : 'stop'} — ${dec.reasoning}`)
            history.push(`Decider: ${dec.continue ? 'continue' : 'stop'} — ${dec.reasoning}`)
            updateLoopRunCounters(this.db, runId, {
              iterationCount: iteration,
              totalCostUsd: totalCost,
              totalTokens,
              totalDurationMs: totalDuration,
            })
            this.broadcast({
              type: 'loop.run_progress',
              projectId: req.projectId,
              loopRunId: runId,
              iteration,
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
            if (dec.continue) {
              const target = branchTarget('continue') ?? conts[0]?.id
              if (target) {
                nodeId = target
                // The next step acts on this verdict → let it see the history.
                justContinued = true
                // New iteration of an iterate-per-item loop → drop the resumed AI
                // session so the next pass starts fresh (re-reads the code on disk).
                // Provider-agnostic: clearing aiSessionId makes runAiStep use the
                // 'rail-job' (fresh) action, which every adapter maps to its own
                // native spawn — no claude/codex/gemini branching here.
                if (target === firstStepId) aiSessionId = undefined
              }
              else { outcome = 'success'; settled = true }
            } else {
              const target = branchTarget('stop') ?? ends[0]?.id
              if (target) nodeId = target
              else { outcome = 'success'; settled = true }
            }
            break
          }
          case 'condition':
            // v1: AND/OR branching is not yet evaluated — follow the first edge.
            nodeId = succs[0]?.id
            break
          default:
            nodeId = succs[0]?.id
        }

        // Ran off the end of the graph without an explicit End node.
        if (nodeId === undefined && !settled) {
          outcome = 'success'
          settled = true
        }
      }
    } catch (err) {
      outcome = 'failed'
      console.error(`[loop] run=${runId} traversal threw:`, err)
      logLine(`error: ${(err as Error)?.message ?? String(err)}`, 'stderr')
    }

    console.log(`[loop] settle run=${runId} outcome=${outcome} iterations=${iteration} cost=$${totalCost.toFixed(4)}`)

    finishLoopRun(this.db, runId, {
      outcome,
      finishedAt: new Date(this.now()).toISOString(),
      counters: { iterationCount: iteration, totalCostUsd: totalCost, totalTokens, totalDurationMs: totalDuration },
    })

    // Settle the backing job so the Jobs list + JobDetail reflect the final
    // status, and emit job.finalized so an open JobDetail re-fetches + stops the
    // live stream (mirrors QueueManager).
    const jobStatus: JobStatus = outcome === 'success' ? 'completed' : outcome === 'stopped' ? 'canceled' : 'failed'
    logLine(`\n■ Loop finished: ${outcome} — ${iteration} iteration${iteration === 1 ? '' : 's'}, $${totalCost.toFixed(4)}`)
    try {
      finishJob(this.db, runId, {
        exit_code: outcome === 'success' ? 0 : 1,
        status: jobStatus,
        total_cost_usd: totalCost,
        tokens_out: totalTokens,
        duration_ms: totalDuration,
        num_turns: iteration,
      })
    } catch { /* best-effort */ }
    this.broadcast({
      type: 'job.finalized',
      projectId: req.projectId,
      jobId: runId,
      status: jobStatus,
      totals: {
        tokens_in: 0,
        tokens_out: totalTokens,
        tokens_cache_read: 0,
        tokens_cache_create: 0,
        total_cost_usd: totalCost,
        num_turns: iteration,
      },
      timestamp: new Date(this.now()).toISOString(),
    })
    this.broadcast({
      type: 'loop.run_completed',
      projectId: req.projectId,
      loopRunId: runId,
      railIndex: req.railIndex ?? null,
      status: outcome,
      ticketIds: req.ticketId != null ? [req.ticketId] : [],
    })

    return { runId, outcome, iterations: iteration, totalCostUsd: totalCost }
  }
}
