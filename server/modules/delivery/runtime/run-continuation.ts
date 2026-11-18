/**
 * "Continue" for a failed or stopped definition run: decide HOW it goes on,
 * keeping every piece of work.
 *
 * - A paused run (a restart, a limit, a question) resumes in place.
 * - A run that left approved tasks unticked, or stalled on its own attempt
 *   budget, continues as a new attempt from the developer with fresh budgets.
 * - Anything else (a stop, a crash, a host blocker) continues as a new attempt
 *   from the step that failed or stopped, in the same worktree.
 *
 * The HTTP route and the automatic continuation apply the decision; the
 * cause's guidance (recovery `continuationGuidance`) goes with it.
 */
import { createHash } from 'node:crypto'
import { readDefinitionRun } from '../../loops/runtime/loop-runs-store'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import type { FailureDiagnosis } from '../../recovery'
import type { DbInstance } from '../../../db'
import type { DefinitionForkRequest } from './definition-fork'
import { IncompleteTasksRemedyError, prepareIncompleteTasksFork } from './incomplete-tasks-remedy'

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

const STALLED = /Implementation attempt limit reached|Automatic correction made no candidate changes|Automatic correction limit reached/i
/** Scope statuses of the step a run was on when it failed or stopped. */
const STOPPED_AT = ['failed', 'interrupted', 'cancelled', 'blocked', 'running']

function requestId(runId: string, remedy: string): string {
  return `remedy-${remedy}-${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`
}

function rootScopes(probe: DefinitionRunProbe) {
  return (probe.scopes ?? []).filter((scope) => scope.scopeId === 'root' && typeof scope.visits === 'number' && Number.isSafeInteger(scope.visits) && scope.visits > 0)
}

/**
 * The step a run failed or stopped on, with its latest visit: the one the
 * diagnosis names, else the one the runtime marks interrupted, else the first
 * step that did not finish. Null when the ledger names none.
 */
export function stoppedStep(probe: DefinitionRunProbe, diagnosis: Pick<FailureDiagnosis, 'phase' | 'resumablePhase'> | null): { nodePath: string; visit: number } | null {
  const scopes = rootScopes(probe)
  const unfinished = scopes.filter((scope) => STOPPED_AT.includes(scope.status))
  const named = [diagnosis?.resumablePhase, diagnosis?.phase].filter((value): value is string => !!value)
  const recoverable = new Set(probe.recoverableSteps.filter((step) => step.scopeId === 'root').map((step) => step.nodePath))
  const pick = named.map((name) => scopes.find((scope) => scope.nodePath === name)).find(Boolean)
    ?? unfinished.find((scope) => recoverable.has(scope.nodePath))
    ?? unfinished.find((scope) => scope.status !== 'running')
    ?? unfinished[0]
  return pick ? { nodePath: pick.nodePath, visit: pick.visits! } : null
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
  // An attempt that spent its own budget restarts the developer with fresh budgets, like unfinished tasks.
  if (diagnosis?.kind === 'blocked' && diagnosis.detail && STALLED.test(diagnosis.detail) && nodes.developer) {
    const developer = rootScopes(probe).find((scope) => scope.nodePath === 'developer')
    if (developer) return { mode: 'fork', fromStep: 'developer', request: { requestId: requestId(runId, 'continue'), fromNodePath: 'developer', scopeId: 'root', visit: developer.visits!, state: { $vars: { implementationAttempts: 0, unblockAttempts: 0, lastImplementationHash: '' } } } }
  }
  const step = stoppedStep(probe, diagnosis)
  if (!step) throw new IncompleteTasksRemedyError('remedy_not_applicable', 'The run has no step to continue from')
  return { mode: 'fork', fromStep: step.nodePath, request: { requestId: requestId(runId, 'continue'), fromNodePath: step.nodePath, scopeId: 'root', visit: step.visit } }
}
