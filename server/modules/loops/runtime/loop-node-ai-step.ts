/**
 * Legacy `ai-step` node executor: renders the step prompt, runs it through the
 * interactive session or the one-shot executor, retries an idle stall once by
 * resume and a resume miss once fresh, judges the result (zero work, provider
 * limit, Core completion, blocked, verification) and routes the traversal.
 * Accounting is staged before each attempt and recorded after it settles.
 */
import { parseSpecAddendaReport } from '../../specs/runtime/spec-addenda-core'
import { executionManifestPrompt } from '../../delivery/runtime/multi-repo-execution-store'
import { parseVerificationSentinel } from '../../execution/runtime/verification-sentinel'
import { classifyProviderLimit, describeProviderLimit } from '../../../provider-limit'
import type { CoreRunInput } from '../../../core-execution'
import { interpolateSpec } from './loop-graph'
import { expandCommands } from './loop-command-catalog'
import { resolveConstants } from './loop-constants'
import { composeHistory, extractChangeId, resolveRunVars, truncate } from './loop-run-vars'
import {
  AI_FAILFAST_THRESHOLD,
  STEP_COMMAND_CAP,
  STEP_TEMPLATE_CAP,
  aiStepBlockedReason,
  aiStepZeroWork,
  capText,
  isResumeMiss,
  withReviewContinuationContext,
} from './loop-ai-step-signals'
import { recordStepResult, stageAiAccounting } from './loop-run-ledger'
import { awaitHumanDecision } from './loop-run-pauses'
import { afterPhase, recoverPhase } from './loop-phase-recovery'
import { DISPOSED, next, settle, type LoopNodeFrame, type LoopRunContext, type LoopRunState, type NodeStep } from './loop-run-context'
import type { AiStepResult, LoopStepEventPayload } from './loop-run-contract'

const ARTIFACT_REPAIR_TEMPLATE = 'Repair ONLY the OpenSpec artifacts at openspec/changes/{{run.changeId}}/ using the validation diagnostics below. Preserve requirements and acceptance criteria. Do not edit implementation code, run repository tests, archive, create a new change, or expand scope. {{const:GUARDRAILS}}'

interface RenderedAiStep {
  rawTemplate: string
  repair: LoopRunState['phaseRecovery']
  requiresCoreCompletion: boolean
  /** The rendered prompt without the cross-iteration history (the step's `command`). */
  base: string
  /** What is actually sent: `base` plus, when due, the history. */
  prompt: string
  stepTitle: string
  stepDetail: Pick<LoopStepEventPayload, 'template' | 'command'>
}

/** Expand magic commands FIRST — `{{cmd:implement}}` becomes the NATIVE
 *  per-provider invocation (claude `/specrails:implement #<id> --yes`, codex
 *  `$implement #<id> --yes`) — then resolve `{{spec.*}}` data tokens and
 *  finally `{{const:*}}` library constants. Reads (never writes) run state. */
function renderAiStep(ctx: LoopRunContext, frame: LoopNodeFrame): RenderedAiStep {
  const { req, state, seededChangeId } = ctx
  const { node } = frame
  const repair = state.phaseRecovery?.target === node.id ? state.phaseRecovery : undefined
  const rawTemplate = repair?.artifactOnly
    ? ARTIFACT_REPAIR_TEMPLATE
    : String(node.data?.prompt ?? '')
  const requiresCoreCompletion = node.data?.operation === 'core-implementation' || /\{\{\s*cmd:(?:implement|batch)\s*\}\}/.test(rawTemplate)
    || /^\s*(?:\/specrails:|\/skill:specrails-|\$)(?:implement|batch-implement)(?:\s|$)/.test(rawTemplate)
  const expanded = resolveConstants(
    resolveRunVars(
      interpolateSpec(
        expandCommands(rawTemplate, { provider: frame.provider, ticketIds: req.spec?.ticketIds, specId: req.spec?.id }),
        seededChangeId && ['addenda', 'revision'].includes(seededChangeId.source)
          ? { ...req.spec, openspecChangeName: seededChangeId.id } : req.spec
      ),
      ctx.runVars
    ),
    ctx.constMap
  )
  // The follow-up briefing is APPENDED (after any slash command, which
  // must lead the message) so it becomes part of the command's
  // arguments for CLI providers and plain prompt text for the runner.
  // The spec-addenda briefing rides the same slot: appended to every
  // step so no phase can miss the iteration delta.
  const deltaTarget = seededChangeId && ['addenda', 'revision'].includes(seededChangeId.source)
    ? `DELTA OPENSPEC TARGET: ${seededChangeId.id}. Use ONLY openspec/changes/${seededChangeId.id}/. Create it if missing; the seeded name does not imply artifacts exist. Ignore the original spec/follow-up change name and unrelated active or archived changes. Inspect the current branch first. For delivered work, prepare artifacts and tasks ONLY for the attached addenda or delivery change request and preserve existing behavior outside this delta. For a spec with no delivered work, the scope is the full spec together with its addenda. Map each requested change to acceptance checks. Do not redo or archive the original proposal. Perform only the current phase on this exact change: preparation/repair edits artifacts only; implementation applies and verifies. The implementation phase must report every attached addendum with concrete files and test evidence before VERIFICATION: PASS.`
    : undefined
  const base = [executionManifestPrompt(req.executionManifest), withReviewContinuationContext(expanded, rawTemplate, req.spec), repair ? `PHASE RECOVERY: keep the same change and completed work. Correct only the remaining failure; do not repeat preparation or unaffected passing checks. Prior failure (diagnostic data):\n${repair.detail}` : undefined, req.followUp?.briefing, req.constants?.REVISION_REQUEST, deltaTarget, req.addenda?.briefing].filter(Boolean).join('\n\n')
  // Inject the cross-iteration history only when there's no live session
  // to carry it (a fresh pass) OR right after a Decider 'continue' (so the
  // step sees the verdict). A mid-body resumed step already has it.
  const includeHistory = ctx.history.length > 0 && (!state.aiSessionId || state.justContinued)
  const prompt = includeHistory ? `${base}\n\n---\nContext from previous iterations:\n${composeHistory(ctx.history)}` : base
  // The authored template + the actual COMMAND sent ride the loop_step
  // payload (NOT the flat log — the old `Template:`/`Command:` log lines
  // were noise once the step explorer landed; the log now opens on real
  // output). `template` is omitted when rendering changed nothing (a
  // plain free-text prompt would just duplicate `command`).
  const stepTitle = requiresCoreCompletion ? '🤖 Implementation (agent runtime)' : `🤖 ${frame.label || 'AI Step'} (${frame.provider}/${frame.model}${frame.effort ? `, effort: ${frame.effort}` : ''})`
  const stepDetail: Pick<LoopStepEventPayload, 'template' | 'command'> = {
    ...(rawTemplate && rawTemplate !== base ? { template: capText(rawTemplate, STEP_TEMPLATE_CAP) } : {}),
    ...(base ? { command: capText(base, STEP_COMMAND_CAP) } : {}),
  }
  return { rawTemplate, repair, requiresCoreCompletion, base, prompt, stepTitle, stepDetail }
}

// Interactive upgrade (default for persistent-stdin providers): the
// executors return a resident-session plan when the kill-switch is on
// and the provider is capable (claude); null falls through to the
// byte-identical one-shot spawn. The plan mirrors the one-shot's
// cwd/env/argv derivation; the engine owns the session lifecycle.
// One attempt of this step. `sessionId` is the ONLY thing that
// differs between the resumed attempt and its fresh retry below.
function runAiAttempt(ctx: LoopRunContext, frame: LoopNodeFrame, step: RenderedAiStep, sessionId: string | undefined, recoveryStepKey: string): Promise<AiStepResult> {
  const { host, req, runId, state } = ctx
  const { aiStepTimeoutMs, idleTimeoutMs } = ctx.limits
  const { node } = frame
  const remainingMs = state.deadline - host.now()
  const effectiveTimeoutMs = Number.isFinite(remainingMs)
    ? Math.max(1, Math.min(aiStepTimeoutMs === 0 ? Infinity : (aiStepTimeoutMs ?? 15 * 60_000), remainingMs))
    : aiStepTimeoutMs
  const coreRun: CoreRunInput = { runId, implementation: step.requiresCoreCompletion, spec: req.spec, goal: req.spec ? undefined : JSON.stringify({ loop: req.loopName, graph: req.graph }), repositoryId: req.repositoryId, workspacePaths: req.workspacePaths, verificationStep: node.data?.requireVerificationPass === true || /\{\{\s*cmd:(?:verify|revision-verify|opsx:verify)\s*\}\}/.test(step.rawTemplate) }
  const interactivePlan = host.executors.planInteractiveAiStep?.({
    coreRun,
    provider: frame.provider,
    model: frame.model,
    effort: frame.effort,
    profileName: req.profileName,
    cwd: req.cwd,
    repoDir: req.repoDir, executionManifest: req.executionManifest,
    sessionId,
    aiStepTimeoutMs: effectiveTimeoutMs,
    idleTimeoutMs,
  }) ?? null
  return interactivePlan
    ? host.runInteractiveAiStep({
        runId,
        projectId: req.projectId,
        plan: interactivePlan,
        prompt: [interactivePlan.promptPrefix, step.prompt].filter(Boolean).join('\n\n'),
        fallbackModel: frame.model,
        nextEventSeq: ctx.events.takeSeq,
        recoveryStepKey,
      })
    : host.executors.runAiStep({ runtimeProviderOverride: req.runtimeProviderOverride, coreRun, prompt: step.prompt, sessionId, provider: frame.provider, model: frame.model, effort: frame.effort, profileName: req.profileName, cwd: req.cwd, repoDir: req.repoDir, executionManifest: req.executionManifest, onLine: ctx.events.logLine, onRawLine: ctx.events.onRawLine, onSpawn: (c) => host.setActiveChild(runId, c), aiStepTimeoutMs: effectiveTimeoutMs, idleTimeoutMs })
}

interface AiStepVerdict {
  zeroWork: boolean
  oneShotZeroWork: boolean
  blockedReason: string | null
  verificationFailed: boolean
  stepFailed: boolean
  stepErrorText: string | undefined
}

/** Judge a settled (non-limit) result; marks the pass failed when it is. */
function judgeAiStep(ctx: LoopRunContext, frame: LoopNodeFrame, step: RenderedAiStep, res: AiStepResult, zeroWork: boolean): AiStepVerdict {
  const { req, state } = ctx
  const oneShotZeroWork = res.zeroWork === undefined && zeroWork
  const blockedReason = aiStepBlockedReason(res.text)
  const requiresVerification = frame.node.data?.requireVerificationPass === true
    || /\{\{cmd:(?:verify|revision-verify|opsx:verify)\}\}/.test(step.rawTemplate)
  const addendaReport = requiresVerification && req.addenda?.ids.length
    ? parseSpecAddendaReport(res.text, req.addenda.ids.map((id) => ({ id }))) : null
  const addendaFailed = Boolean(requiresVerification && req.addenda?.ids.length
    && req.addenda.ids.some((id) => !addendaReport?.some((line) =>
      line.addendumId === id && line.verdict === 'applied' && line.files && line.tests)))
  const verificationFailed = addendaFailed || requiresVerification
    && parseVerificationSentinel(res.text).verdict !== 'pass'
  const stepFailed = res.failed === true || zeroWork || blockedReason !== null || verificationFailed
  state.passFailed ||= res.failed === true || zeroWork || (verificationFailed && !blockedReason)
  const stepErrorText = res.errorText ?? (zeroWork
    ? `zero work performed — the command never ran${res.text.trim() ? `: ${res.text.trim()}` : ''}`
    : blockedReason
      ? `blocked — ${blockedReason}`
    : verificationFailed
      ? addendaFailed ? 'addenda verification incomplete: every addendum requires an applied report with files and tests' : 'verification did not finish with VERIFICATION: PASS'
    : res.failed ? 'provider invocation failed without a reported reason' : undefined)
  return { zeroWork, oneShotZeroWork, blockedReason, verificationFailed, stepFailed, stepErrorText }
}

/** One provider process of the step: its start instant, its staged recovery
 *  checkpoint and (once settled) its result. */
interface AiAttempt {
  startedAt: string
  recoveryKey: string
  res: AiStepResult
}

/** BUG-32: capture the REAL start instant BEFORE the await — the row is
 *  bucketed/ordered by started_at, which must be the turn-start, not the
 *  finish time (now() evaluated after the await would be the finish). */
function stageAttempt(ctx: LoopRunContext, frame: LoopNodeFrame): Omit<AiAttempt, 'res'> {
  const startedAt = new Date(ctx.host.now()).toISOString()
  return { startedAt, recoveryKey: stageAiAccounting(ctx, 'ai', frame.node.id, `loop:${ctx.runId}`, startedAt) }
}

/** Run one attempt against its staged checkpoint; null when the manager was
 *  disposed meanwhile (the child registry is then left to shutdown). */
async function runStagedAttempt(ctx: LoopRunContext, frame: LoopNodeFrame, step: RenderedAiStep, sessionId: string | undefined, recoveryKey: string): Promise<AiStepResult | null> {
  const res = await runAiAttempt(ctx, frame, step, sessionId, recoveryKey)
  if (ctx.host.isDisposed()) return null
  ctx.host.clearActiveChild(ctx.runId)
  return res
}

// Idle stall (loop-step-idle): the provider produced no stream
// activity for the idle budget and the watchdog tore the step down.
// Close this attempt as `stalled`, then retry the SAME step ONCE by
// resuming its session (the worktree + transcript carry the partial
// work). A second stall fails the step and settles the run `stalled`
// instead of leaving it `running` forever. A user cancel is not a
// stall — the loop head settles it 'stopped' below.
async function retryIdleStall(ctx: LoopRunContext, frame: LoopNodeFrame, step: RenderedAiStep, attempt: AiAttempt): Promise<NodeStep | undefined> {
  const { host, runId, state } = ctx
  const { emitStep, emitStepEnd, logLine } = ctx.events
  const { idleTimeoutMs, maxCostUsd } = ctx.limits
  if (!attempt.res.stalled || host.isCancelled(runId)) return undefined
  const stalledSession = attempt.res.sessionId ?? state.aiSessionId
  const idleMin = Math.max(1, Math.round(idleTimeoutMs / 60_000))
  emitStepEnd({ status: 'stalled', reason: 'idle_timeout', idleMs: idleTimeoutMs, durationMs: attempt.res.durationMs })
  // Each provider process owns independent accounting and recovery
  // frontiers. Settle the first attempt before staging its retry.
  recordStepResult(ctx, `loop:${runId}`, { ...attempt.res, failed: true }, attempt.startedAt, attempt.recoveryKey)
  host.clearActiveStepRecovery(runId)
  if (host.now() >= state.deadline || (maxCostUsd !== undefined && state.totalCost >= maxCostUsd)) {
    const outcome = host.now() >= state.deadline ? 'failed' : 'max-cost'
    logLine('■ Step stalled; the run deadline or cost cap prevents another attempt.', 'stderr')
    return settle(outcome)
  }
  logLine(`↻ Step stalled — no provider output for ${idleMin} min. Retrying this step once${stalledSession ? ` by resuming session ${stalledSession}` : ''}.`, 'stderr')
  emitStep('ai-step', step.stepTitle, frame.node.id, state.iteration + 1, { ...step.stepDetail, attempt: 2 })
  const retry = stageAttempt(ctx, frame)
  const res = await runStagedAttempt(ctx, frame, step, stalledSession, retry.recoveryKey)
  if (!res) return DISPOSED
  Object.assign(attempt, retry, { res })
  if (attempt.res.stalled && !host.isCancelled(runId)) {
    emitStepEnd({ status: 'stalled', reason: 'idle_timeout', idleMs: idleTimeoutMs, durationMs: attempt.res.durationMs })
    logLine(`■ Step stalled twice — no provider output for ${idleMin} min on the resumed attempt either; stopping the run.`, 'stderr')
    ctx.history.push(`AI Step: ${truncate(attempt.res.text)}`)
    recordStepResult(ctx, `loop:${runId}`, { ...attempt.res, failed: true }, attempt.startedAt, attempt.recoveryKey)
    host.clearActiveStepRecovery(runId)
    state.stallReason = 'idle_timeout'
    return settle('stalled')
  }
  return undefined
}

// Resume miss (loop run 5c958db2): a step that `--resume`d the
// previous step's session and settled with ZERO work — no model
// call, no `Unknown command:` text — was answered by the CLI's
// session bookkeeping (a transcript the resume could not load, a
// session torn down mid-flight), never by the model. The prompt did
// not run, so retry it ONCE in a fresh session instead of failing
// the step and spinning the loop through verify/fix on nothing.
// Unknown commands, timeouts and cancels are NOT resume misses.
async function retryResumeMiss(ctx: LoopRunContext, frame: LoopNodeFrame, step: RenderedAiStep, attempt: AiAttempt): Promise<NodeStep | undefined> {
  const { host, runId, state } = ctx
  if (!state.aiSessionId || host.isCancelled(runId) || !isResumeMiss(attempt.res)) return undefined
  ctx.events.logLine(`↻ Resuming session ${state.aiSessionId} produced no work — retrying this step in a fresh session.`, 'stderr')
  state.aiSessionId = undefined
  const res = await runStagedAttempt(ctx, frame, step, undefined, attempt.recoveryKey)
  if (!res) return DISPOSED
  attempt.res = res
  return undefined
}

// Provider usage/rate limit (run 52124009): the CLI answers with the
// limit notice as the reply. Iterating on it burns cycles and hides
// the real cause — stop the run at once with the provider's own
// words and the reset hint, and tell every surface.
function stopOnProviderLimit(ctx: LoopRunContext, attempt: AiAttempt): NodeStep | undefined {
  const { host, req, runId, state } = ctx
  const { res } = attempt
  const providerLimit = !host.isCancelled(runId)
    ? (classifyProviderLimit(res.errorText) ?? classifyProviderLimit(res.text))
    : null
  if (!providerLimit) return undefined
  const described = describeProviderLimit(providerLimit)
  ctx.events.emitStepEnd({ status: 'failed', reason: 'provider_limit', durationMs: res.durationMs })
  ctx.events.logLine(`■ Provider limit reached (${req.provider}): ${described}. Stopping the loop now — relaunch or Recover & retry after the reset.`, 'stderr')
  ctx.history.push(`AI Step: ${truncate(res.text)}`)
  recordStepResult(ctx, `loop:${runId}`, { ...res, failed: true }, attempt.startedAt, attempt.recoveryKey)
  host.clearActiveStepRecovery(runId)
  host.emit({
    type: 'loop.provider_limit',
    projectId: req.projectId,
    runId,
    provider: req.provider,
    kind: providerLimit.kind,
    message: providerLimit.message,
    resetsAt: providerLimit.resetsAt,
    timestamp: new Date().toISOString(),
  })
  state.stallReason = 'provider_limit'
  state.providerLimitHit = providerLimit
  return settle('stalled')
}

/** An implementation step must also pass the installed Core's deterministic
 *  completion gate; an incomplete one turns the result into a failure. */
function enforceCoreCompletion(ctx: LoopRunContext, frame: LoopNodeFrame, step: RenderedAiStep, attempt: AiAttempt, zeroWork: boolean): void {
  const { host, req, runId } = ctx
  const { res } = attempt
  if (res.failed || zeroWork || host.isCancelled(runId)
    || !step.requiresCoreCompletion
    || !host.executors.validateCoreCompletion) return
  const completion = host.executors.validateCoreCompletion({
    coreRun: { runId, spec: req.spec, goal: req.spec ? undefined : JSON.stringify({ loop: req.loopName, graph: req.graph }), repositoryId: req.repositoryId, workspacePaths: req.workspacePaths },
    provider: frame.provider, model: frame.model, effort: frame.effort, profileName: req.profileName,
    cwd: req.cwd, repoDir: req.repoDir, executionManifest: req.executionManifest,
  })
  if (!completion.valid) {
    attempt.res = { ...res, failed: true, errorText: completion.reason ?? 'Core implementation is incomplete' }
    ctx.events.logLine(`✖ ${attempt.res.errorText}`, 'stderr')
  }
}

/** Surface the failure reason, record the final attempt and close the step. */
function closeAiStep(ctx: LoopRunContext, frame: LoopNodeFrame, step: RenderedAiStep, attempt: AiAttempt, verdict: AiStepVerdict): void {
  const { host, req, runId, state } = ctx
  const { emitStepEnd, logLine, emitRunEvent } = ctx.events
  const { res } = attempt
  const { stepFailed, stepErrorText } = verdict
  // Make the failure reason land visibly INSIDE the step's log
  // segment (the interactive session already surfaced its own note at
  // settle; the Template/Command flat-log lines are gone, so without
  // this the one-shot `Unknown command:` text would never be seen).
  if (verdict.oneShotZeroWork) {
    logLine(`✖ Zero work performed — the command never ran${res.text.trim() ? `: ${res.text.trim()}` : ''}`, 'stderr')
  } else if (stepFailed && stepErrorText) {
    state.failureText = stepErrorText
    // Executors can return a structured failure without streaming any
    // text (configuration rejection, missing CLI, provider startup).
    // Persist its reason before the step closes, including early stops.
    logLine(`✖ ${stepErrorText}`, 'stderr')
  }
  recordStepResult(ctx, `loop:${runId}`, { ...res, failed: stepFailed }, attempt.startedAt, attempt.recoveryKey)
  host.clearActiveStepRecovery(runId)
  // Step tail marker — after the step's last streamed output (both the
  // one-shot and interactive paths have fully persisted their frames by
  // here: the session resolves inside onSettle, past its final writes).
  // Failure mirrors what the engine already treats as step failure
  // (res.failed: non-zero exit / spawn error / timeout / crashed
  // session — plus zero-work); no exit code is exposed by the AI
  // executors → null.
  emitStepEnd({ status: stepFailed ? 'failed' : 'ok', durationMs: res.durationMs })
  if (req.graph.nodes.some((candidate) => candidate.data?.failureRecovery)) {
    emitRunEvent('loop_phase_metrics', {
      nodeId: frame.node.id, stepIndex: state.stepNum, usageScope: 'final-attempt', recovery: !!step.repair, promptChars: step.prompt.length, outputChars: res.text.length,
      durationMs: res.durationMs ?? null, costUsd: res.cost ?? null, estimated: res.estimated ?? null,
      tokensIn: res.tokensIn ?? null, tokensOut: res.tokensOut ?? null,
      tokensCacheRead: res.tokensCacheRead ?? null, tokensCacheCreate: res.tokensCacheCreate ?? null,
    })
  }
}

/** Where the traversal goes after a closed step: phase recovery, a human
 *  decision, the fail-fast abort, or the next node. */
async function routeAfterAiStep(ctx: LoopRunContext, frame: LoopNodeFrame, res: AiStepResult, verdict: AiStepVerdict, priorPhaseFailure: boolean): Promise<NodeStep> {
  const { host, runId, state } = ctx
  const { logLine } = ctx.events
  const { node, succs } = frame
  const { zeroWork, blockedReason, verificationFailed, stepFailed, stepErrorText } = verdict
  // Linear workflows may forbid later actions (such as archive) after
  // a failed step. Verify/fix loops keep their existing recovery path.
  if (node.data?.stopOnFailure === true && stepFailed) {
    const retryTarget = !res.failed && !res.resultIsError && !zeroWork && !blockedReason && verificationFailed
      ? recoverPhase(ctx, node, `${stepErrorText}\n${res.text}`, priorPhaseFailure) : undefined
    if (retryTarget) {
      state.aiSessionId = res.sessionId
      return next(retryTarget)
    }
    return settle('failed')
  }
  // Only carry forward the session of a step that actually ran — a
  // hard-failed turn (codex still emits thread.started before its error)
  // would otherwise make the next step `--resume` a dead session.
  if (res.sessionId && (!stepFailed || (blockedReason !== null && !res.failed && !zeroWork))) state.aiSessionId = res.sessionId
  else if (stepFailed) state.aiSessionId = undefined
  ctx.history.push(`AI Step${stepFailed ? ` FAILED (${stepErrorText ?? 'provider invocation failed'})` : ''}: ${truncate(res.text)}`)
  if (blockedReason) {
    const decision = await awaitHumanDecision(ctx, blockedReason)
    if (decision.action === 'stop') return settle('stopped')
    state.justContinued = true
    return next(node.id)
  }
  // Capture the OpenSpec change id from a step's output the FIRST time it
  // appears (first-match-wins, kept stable across loop-back iterations so
  // the re-pass amends the same change). Used by `{{run.changeId}}` in the
  // loop-back ff prompt and the unattended archive shell node.
  if (!ctx.runVars.changeId) {
    const cid = extractChangeId(res.text)
    if (cid) { ctx.runVars.changeId = cid; logLine(`↪ Captured OpenSpec change id: ${cid}`) }
  }
  // Fail-fast: a hard-failed step (non-zero exit / spawn error) that
  // produced NO output means the provider never really ran — quota,
  // auth, crash. One can be transient; AI_FAILFAST_THRESHOLD in a row
  // is systemic, so abort with the real reason instead of spinning to
  // the iteration cap (wasting wall-clock and, on paid providers, money).
  // A ZERO-WORK step routes the SAME way a crashed no-output step does
  // (its `Unknown command:` text is a CLI synthetic, not model output),
  // so a persistently-unresolvable command aborts the run identically
  // instead of grinding to the cap.
  if (host.isCancelled(runId)) {
    // A user cancel tears the step down with no output — that is not
    // a provider failure; the loop head settles the run 'stopped'.
  } else if (stepFailed && (zeroWork || res.resultIsError || !res.text.trim())) {
    state.consecutiveAiFailures += 1
    if (state.consecutiveAiFailures >= AI_FAILFAST_THRESHOLD) {
      logLine(`Loop aborted: provider appears down — ${state.consecutiveAiFailures} AI steps failed with no output and no successful AI call in between${stepErrorText ? ` — ${stepErrorText}` : ''}`, 'stderr')
      return settle('failed')
    }
  } else {
    state.consecutiveAiFailures = 0
  }
  return next(afterPhase(ctx, node.id, succs[0]?.id))
}

export async function executeAiStepNode(ctx: LoopRunContext, frame: LoopNodeFrame): Promise<NodeStep> {
  const { state } = ctx
  // Some roles must inspect the previous step without inheriting its
  // provider conversation (notably Revision's mutator → reviewer
  // boundary). The node still receives durable disk state, its fully
  // rendered prompt, and bounded prior-step history.
  if (frame.node.data?.freshSession === true) state.aiSessionId = undefined
  const priorPhaseFailure = state.passFailed
  const step = renderAiStep(ctx, frame)
  state.justContinued = false
  ctx.events.emitStep('ai-step', step.stepTitle, frame.node.id, state.iteration + 1, step.stepDetail)
  const staged = stageAttempt(ctx, frame)
  const first = await runStagedAttempt(ctx, frame, step, state.aiSessionId, staged.recoveryKey)
  if (!first) return DISPOSED
  const attempt: AiAttempt = { ...staged, res: first }
  const halted = await retryIdleStall(ctx, frame, step, attempt) ?? await retryResumeMiss(ctx, frame, step, attempt)
  if (halted) return halted
  // Zero-work strictness (run 01f41203): a settle that consumed NO
  // model work — the claude CLI's synthetic `Unknown command:` result
  // frame (num_turns 0, no assistant events, zero usage tokens) —
  // means the step's command never actually ran. A step that didn't
  // run is FAILED, never 'ok'. The interactive path evaluates the
  // predicate at session settle (res.zeroWork set); for the one-shot
  // path the engine derives it from the result's accumulated signals
  // (aiStepZeroWork).
  const zeroWork = aiStepZeroWork(attempt.res)
  const limited = stopOnProviderLimit(ctx, attempt)
  if (limited) return limited
  enforceCoreCompletion(ctx, frame, step, attempt, zeroWork)
  const verdict = judgeAiStep(ctx, frame, step, attempt.res, zeroWork)
  closeAiStep(ctx, frame, step, attempt, verdict)
  return routeAfterAiStep(ctx, frame, attempt.res, verdict, priorPhaseFailure)
}
