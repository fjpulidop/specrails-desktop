/**
 * Legacy `shell` node executor: refuses to run against uncaptured run
 * variables, short-circuits OpenSpec validate/archive of an already archived
 * change, runs the command in its selected repository and routes the
 * traversal (phase recovery on `stopOnFailure`).
 */
import { interpolateSpec } from './loop-graph'
import { resolveConstants } from './loop-constants'
import { updateLoopRunCounters } from './loop-runs-store'
import { openspecChangeState, resolveRunVars, truncate } from './loop-run-vars'
import { afterPhase, recoverPhase } from './loop-phase-recovery'
import { DISPOSED, next, runCounters, settle, type LoopNodeFrame, type LoopRunContext, type NodeStep } from './loop-run-context'

export async function executeShellNode(ctx: LoopRunContext, frame: LoopNodeFrame): Promise<NodeStep> {
  const { host, req, runId, state, runVars } = ctx
  const { emitStep, emitStepEnd, logLine } = ctx.events
  const { node, succs, label } = frame
  const priorPhaseFailure = state.passFailed
  // Guard: refuse to run when a declared run-variable was never captured
  // (e.g. an archive node whose `{{run.changeId}}` is empty) — running
  // `openspec archive  -y` against an unknown change would archive the
  // wrong thing. Settle the run failed with a clear reason instead.
  const reqVarsRaw = node.data?.requireRunVars
  const requireRunVars = Array.isArray(reqVarsRaw)
    ? reqVarsRaw.filter((v): v is string => typeof v === 'string')
    : []
  const missingRunVars = requireRunVars.filter((name) => !runVars[name])
  if (missingRunVars.length > 0) {
    emitStep('shell', `⚡ ${label || 'Shell'}`, node.id, state.iteration + 1)
    logLine(`Skipped: required run variable(s) not captured: ${missingRunVars.map((n) => `{{run.${n}}}`).join(', ')} — refusing to run the command against an unknown target.`, 'stderr')
    // Never spawned → no exit code; the refusal is a failed step.
    emitStepEnd({ status: 'failed' })
    return settle('failed')
  }
  const rawCommand = String(node.data?.command ?? '')
  const command = resolveConstants(resolveRunVars(interpolateSpec(rawCommand, req.spec), runVars), ctx.constMap)
  emitStep('shell', `⚡ ${label || 'Shell'}`, node.id, state.iteration + 1)
  const shellRepo = req.executionManifest?.repositories.find((repo) => repo.repositoryId === node.data?.repositoryId)?.worktreePath ?? req.repoDir
  const shellCwd = req.executionManifest ? shellRepo ?? req.cwd : req.cwd
  // An OpenSpec change the AI step already archived (despite the
  // prompt) is finished work, not a failure: validating or archiving
  // it again would fail against the missing active dir and throw a
  // green implementation away. Short-circuit as a successful no-op.
  if (runVars.changeId && /\{\{\s*run\.changeId\s*\}\}/.test(rawCommand) && /\bopenspec\s+(validate|archive)\b/.test(rawCommand)
    && openspecChangeState(shellCwd, runVars.changeId) === 'archived') {
    logLine(`Skipped: OpenSpec change ${runVars.changeId} is already archived (openspec/changes/archive) — nothing left to ${/\barchive\b/.test(rawCommand) ? 'archive' : 'validate'}.`)
    emitStepEnd({ status: 'ok', exitCode: 0, durationMs: 0 })
    return next(afterPhase(ctx, node.id, succs[0]?.id))
  }
  logLine(`$ ${command}`)
  const sh = await host.executors.runShell({ command, cwd: shellCwd, repoDir: shellRepo, timeoutMs: Math.min(10 * 60_000, Math.max(1, state.deadline - host.now())), onLine: logLine, onSpawn: (c) => host.setActiveChild(runId, c) })
  if (host.isDisposed()) return DISPOSED
  host.clearActiveChild(runId)
  logLine(`(exit ${sh.exitCode})`)
  emitStepEnd({ status: sh.exitCode === 0 ? 'ok' : 'failed', exitCode: sh.exitCode, durationMs: sh.durationMs })
  state.passFailed ||= sh.exitCode !== 0
  state.totalDuration += sh.durationMs ?? 0
  updateLoopRunCounters(host.db, runId, runCounters(state))
  ctx.history.push(`Shell \`${command}\` exit=${sh.exitCode}: ${truncate(sh.stdout || sh.stderr)}`)
  if (node.data?.stopOnFailure === true && sh.exitCode !== 0) {
    const retryTarget = sh.exitCode === 1
      ? recoverPhase(ctx, node, `${command}\n${sh.stdout}\n${sh.stderr}`, priorPhaseFailure) : undefined
    if (retryTarget) return next(retryTarget)
    return settle('failed')
  }
  return next(afterPhase(ctx, node.id, succs[0]?.id))
}
