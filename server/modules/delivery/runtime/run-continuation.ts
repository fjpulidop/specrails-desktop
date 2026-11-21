/**
 * "Continue" for a failed or stopped definition run: decide HOW it goes on,
 * keeping every piece of work.
 *
 * - A paused run (a restart, a limit, a question) resumes in place.
 * - A run that left approved tasks unticked, or spent its implementation
 *   attempts, continues as a new attempt from the developer with fresh budgets.
 * - A run whose correction budget ran out continues from the budget check with
 *   a fresh budget (the fixer gets new rounds with the latest findings).
 * - A run whose fixer changed nothing (a correction stall, typically a failure
 *   it could not reproduce: a flaky or contended verification) continues from
 *   the verification it was correcting, on the same candidate, with a fresh
 *   correction budget: a pass goes on to review, a failure back to the fixer.
 * - Anything else (a stop, a crash, a host blocker) continues as a new attempt
 *   from the step that failed or stopped, in the same worktree.
 *
 * A settled run with any step in its ledger always has a step to go on from
 * (`stoppedStep` falls back to the work step the run ended after), so the
 * `continuable` the attempts endpoint reports never meets a refusal here.
 *
 * The HTTP route and the automatic continuation apply the decision; the
 * cause's guidance (recovery `continuationGuidance`) goes with it.
 */
import { createHash } from 'node:crypto'
import { readDefinitionRun } from '../../loops/runtime/loop-runs-store'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import { recipeStall, type FailureDiagnosis } from '../../recovery'
import type { DbInstance } from '../../../db'
import type { DefinitionForkRequest } from './definition-fork'
import { IncompleteTasksRemedyError, prepareIncompleteTasksFork } from './incomplete-tasks-remedy'
import { routeOverrideRequest } from '../../loops/runtime/loop-provider-switch'
import type { ProviderSwitchChoice, SettledProviderSwitch } from '../../loops/runtime/loop-provider-switch-settled'
import type { DefinitionRouteOverride } from '../../agent-runtime/runtime/agent-runtime-route-overrides'

/** Remedy ids `POST /loop-runs/:id/remedy` accepts. `retry-with-browser` is the older id of `continue`. */
export const CONTINUE_REMEDIES = ['continue', 'continue-to-review', 'retry-with-browser'] as const
export type ContinueRemedy = 'continue' | 'continue-to-review'

export function normalizeContinueRemedy(value: unknown): ContinueRemedy | null {
  if (value === 'continue' || value === 'retry-with-browser') return 'continue'
  if (value === 'continue-to-review') return 'continue-to-review'
  return null
}

export type ContinuationPlan =
  | { mode: 'resume'; fromStep: string | null }
  | { mode: 'fork'; fromStep: string; request: DefinitionForkRequest }

/** Scope statuses of the step a run was on when it failed or stopped. */
const STOPPED_AT = ['failed', 'interrupted', 'cancelled', 'blocked', 'running']

function requestId(runId: string, remedy: string): string {
  return `remedy-${remedy}-${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`
}

function rootScopes(probe: DefinitionRunProbe) {
  return (probe.scopes ?? []).filter((scope) => scope.scopeId === 'root' && typeof scope.visits === 'number' && Number.isSafeInteger(scope.visits) && scope.visits > 0)
}

/** Node kinds that only route or record (they decide nothing new when re-run) or end the run. */
const ROUTING_KINDS = new Set(['condition', 'assign', 'end'])
interface DefinitionNodeShape { kind?: unknown; params?: { blockerFrom?: unknown }; ends?: unknown }

/**
 * The work steps that lead to `endPath` through routing nodes only (conditions, assigns): the steps
 * whose result the end reports ("Fixer settled no decision" ← … ← the fixer). Definition order.
 */
function reportersOf(endPath: string, nodes: Readonly<Record<string, unknown>>): string[] {
  const node = (path: string) => nodes[path] as DefinitionNodeShape | undefined
  const targets = (path: string): string[] => {
    const ends = node(path)?.ends
    return ends && typeof ends === 'object' ? Object.values(ends as Record<string, unknown>).filter((value): value is string => typeof value === 'string') : []
  }
  const found = new Set<string>(), seen = new Set<string>([endPath]), queue = [endPath]
  while (queue.length) {
    const target = queue.shift()!
    for (const path of Object.keys(nodes)) {
      if (seen.has(path) || !targets(path).includes(target)) continue
      seen.add(path)
      if (ROUTING_KINDS.has(String(node(path)?.kind ?? ''))) queue.push(path)
      else found.add(path)
    }
  }
  return Object.keys(nodes).filter((path) => found.has(path))
}

/**
 * The step a run failed or stopped on, with its latest visit: the one the diagnosis names, else the
 * one the runtime marks interrupted, else the first step that did not finish. A run that ended
 * cleanly at a failure `end` (every step succeeded) goes on from the work step that end reports,
 * else the developer, else the last work step it ran. Null only when the ledger has no step at all.
 */
export function stoppedStep(
  probe: DefinitionRunProbe,
  diagnosis: Pick<FailureDiagnosis, 'phase' | 'resumablePhase'> | null,
  nodes: Readonly<Record<string, unknown>> = {},
): { nodePath: string; visit: number } | null {
  const node = (path: string) => nodes[path] as DefinitionNodeShape | undefined
  // An `end` node only reports how the run ended ("Fixer reported a host blocker"):
  // forking from it replays the same end. Go on from the step whose output it
  // reports (`blockerFrom`), else from where the run otherwise stopped.
  const isEnd = (path: string) => node(path)?.kind === 'end'
  const all = rootScopes(probe)
  const scopes = all.filter((scope) => !isEnd(scope.nodePath))
  const unfinished = scopes.filter((scope) => STOPPED_AT.includes(scope.status))
  const reporter = (path: string | null | undefined): string | null => {
    if (!path || !isEnd(path)) return path ?? null
    const from = node(path)?.params?.blockerFrom
    return typeof from === 'string' && from ? from : null
  }
  const named = [diagnosis?.resumablePhase, diagnosis?.phase].map(reporter).filter((value): value is string => !!value)
  const recoverable = new Set(probe.recoverableSteps.filter((step) => step.scopeId === 'root').map((step) => step.nodePath))
  const ran = (path: string) => scopes.find((scope) => scope.nodePath === path)
  const pick = named.map(ran).find(Boolean)
    ?? unfinished.find((scope) => recoverable.has(scope.nodePath))
    ?? unfinished.find((scope) => scope.status !== 'running')
    ?? unfinished[0]
    ?? endedAfter()
  return pick ? { nodePath: pick.nodePath, visit: pick.visits! } : null

  // Every step finished and the run took a failure `end`: re-run the one work step that end reports,
  // else the developer (the Implement recipe's own restart point), else the last work step it ran.
  function endedAfter() {
    const work = scopes.filter((scope) => !ROUTING_KINDS.has(String(node(scope.nodePath)?.kind ?? '')))
    const end = [diagnosis?.phase, diagnosis?.resumablePhase].find((path): path is string => !!path && isEnd(path))
      ?? all.find((scope) => isEnd(scope.nodePath))?.nodePath
    const reporters = end ? reportersOf(end, nodes).map(ran).filter((scope): scope is NonNullable<typeof scope> => !!scope) : []
    return (reporters.length === 1 ? reporters[0] : undefined) ?? ran('developer') ?? work[work.length - 1] ?? scopes[scopes.length - 1]
  }
}

/**
 * How `Continue` goes on for this run. Pure over the stored run and its probe,
 * except the one tasks.md edit `continue-to-review` makes (see incomplete-tasks-remedy).
 */
export function planContinuation(db: DbInstance, runId: string, remedy: ContinueRemedy, probe: DefinitionRunProbe, diagnosis: FailureDiagnosis | null): ContinuationPlan {
  if (probe.lease?.active || probe.status === 'running') throw new IncompleteTasksRemedyError('runtime_run_active', 'The run is still running')
  if (remedy === 'continue-to-review') {
    const request = prepareIncompleteTasksFork(db, runId, 'continue-to-review', probe)
    return { mode: 'fork', fromStep: request.fromNodePath, request }
  }
  if (diagnosis?.kind === 'incomplete_tasks') {
    // Same request identity as the older "Retry with the browser", so a retried click forks once.
    const request = prepareIncompleteTasksFork(db, runId, 'retry-with-browser', probe)
    return { mode: 'fork', fromStep: request.fromNodePath, request }
  }
  const frozen = readDefinitionRun(db, runId)
  if (!frozen) throw new IncompleteTasksRemedyError('runtime_run_not_found', 'Definition run not found')
  // A paused run goes on in place. A settled one (failed, stopped) is never re-opened: its
  // record stays as it ended, and the next attempt forks from its last checkpoint.
  if (frozen.row.status === 'paused') return { mode: 'resume', fromStep: diagnosis?.resumablePhase ?? null }
  const nodes = (frozen.metadata.definition as { nodes?: Record<string, unknown> } | undefined)?.nodes ?? {}
  const stall = recipeStall(diagnosis, Array.isArray(probe.completion?.reasons) ? probe.completion.reasons : null)
  const visitOf = (path: string) => nodes[path] ? rootScopes(probe).find((scope) => scope.nodePath === path) : undefined
  const fork = (path: string, visit: number, vars?: Record<string, unknown>): ContinuationPlan =>
    ({ mode: 'fork', fromStep: path, request: { requestId: requestId(runId, 'continue'), fromNodePath: path, scopeId: 'root', visit, ...(vars ? { state: { $vars: vars } } : {}) } })
  // The correction budget ran out while the reviewer still asked for something: go on from the budget
  // check with a fresh budget, so the fixer gets three new rounds with the latest review findings
  // ($vars.latestReview is kept). Restarting the developer instead kept the spent budget, and the
  // next rejection ended the run again without a single correction.
  if (stall === 'corrections-spent') {
    const budget = visitOf('correction-budget')
    if (budget) return fork('correction-budget', budget.visits!, { correctionAttempts: 0 })
  }
  // The fixer changed nothing on the failure it was given (it could not reproduce it: a flaky test, a
  // port or load contention): run the same verification again on the same candidate, with a fresh
  // correction budget. A pass goes on to review; a failure reaches the fixer with its new output and
  // the flaky-test guidance. Restarting the developer re-implemented a finished change for nothing.
  if (stall === 'correction-stalled') {
    const verify = visitOf('verify')
    if (verify) return fork('verify', verify.visits!, { correctionAttempts: 0 })
  }
  // An attempt that spent its own budget restarts the developer with fresh budgets, like unfinished tasks.
  if (stall) {
    const developer = visitOf('developer')
    if (developer) return fork('developer', developer.visits!, { implementationAttempts: 0, unblockAttempts: 0, lastImplementationHash: '' })
  }
  const step = stoppedStep(probe, diagnosis, nodes)
  if (!step) throw new IncompleteTasksRemedyError('remedy_not_applicable', 'The run has no step to continue from')
  return fork(step.nodePath, step.visit)
}

/**
 * Continue on another provider (a run that settled on a usage limit): the roles on the limited
 * provider move for the rest of the run. With `forkRouteOverrides` (`via: 'fork'`) the fork itself
 * carries the move, so every later resume of the next attempt replays it; its first resume carries
 * the same request too (Core applies it once), which is how a retained Core with only
 * `routeOverrides` (`via: 'resume'`) moves them. A switch is its own fork request (not the plain
 * Continue's), so the two never conflict.
 */
export function withProviderSwitch(plan: ContinuationPlan, input: { runId: string; sequence: number; offer: SettledProviderSwitch; choice: ProviderSwitchChoice }): { plan: ContinuationPlan; routeOverrides: DefinitionRouteOverride } {
  const routeOverrides = routeOverrideRequest({ runId: input.runId, sequence: input.sequence, fromProvider: input.offer.providerId, roles: input.offer.roles, choice: input.choice })
  if (plan.mode !== 'fork') return { plan, routeOverrides }
  return { routeOverrides, plan: { ...plan, request: { ...plan.request, requestId: `remedy-switch-${createHash('sha256').update(input.runId).digest('hex').slice(0, 16)}`,
    ...(input.offer.via === 'fork' ? { routeOverrides } : {}) } } }
}
