/**
 * Remedies for an Implement run that ended with approved tasks unticked
 * (diagnosis `incomplete_tasks`). Both continue the retained run as a Core
 * fork, so the finished work is kept and nothing restarts from planning:
 *
 * - `continue-to-review`: what is left is a person's check. The remaining
 *   tasks become human checks (tagged `[human]` on a Core whose contract
 *   understands the tag, otherwise ticked with the list kept in the run's
 *   `humanChecks`, which the reviewer and the review packet show as checks by
 *   hand), and the fork re-runs the task check, then host verification, the
 *   reviewer and normal delivery.
 * - `retry-with-browser`: the run can finish them itself. The fork restarts
 *   the developer with fresh attempt budgets; its instructions carry the
 *   browser tool and the install-what-is-missing rule.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { readDefinitionRun } from '../../loops/runtime/loop-runs-store'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import { parseStoredDiagnosis, unfinishedTasksGuidance } from '../../recovery'
import type { DefinitionForkRequest } from './definition-fork'
import type { DbInstance } from '../../../db'

export const INCOMPLETE_TASKS_REMEDIES = ['continue-to-review', 'retry-with-browser'] as const
export type IncompleteTasksRemedy = (typeof INCOMPLETE_TASKS_REMEDIES)[number]

const TASK_LINE = /^(\s*[-*]\s+\[)( )(\]\s+)((?:\d+(?:\.\d+)*\.?\s+)?)(.+)$/
const HUMAN_TAG = /^\[human\]\s*/i

/**
 * Turn every unticked task of a tasks.md into a human check. `tag` inserts the
 * `[human]` tag after the task number (Core 5.15 ignores it in the frozen
 * fingerprint); `tick` marks it done, the only edit an older Core accepts.
 * Already tagged tasks stay as they are and are listed too. Pure.
 */
export function markRemainingAsHumanChecks(tasks: string, mode: 'tag' | 'tick'): { text: string; checks: string[] } {
  const checks: string[] = []
  const text = tasks.split('\n').map((line) => {
    const match = TASK_LINE.exec(line)
    if (!match) return line
    const [, open, , close, number, rest] = match
    const tagged = HUMAN_TAG.test(rest)
    checks.push(`${number}${rest.replace(HUMAN_TAG, '')}`.trim())
    if (mode === 'tag') return tagged ? line : `${open} ${close}${number}[human] ${rest}`
    return `${open}x${close}${number}${rest}`
  }).join('\n')
  return { text, checks }
}

/** The latest root visit of a node in a probed run (Core forks at exactly one visit). */
function latestVisit(probe: DefinitionRunProbe, nodePath: string): number | null {
  const scope = probe.scopes?.find((item) => item.nodePath === nodePath && item.scopeId === 'root')
  const visits = scope?.visits
  return typeof visits === 'number' && Number.isSafeInteger(visits) && visits > 0 ? visits : null
}

/** The guidance a continued developer gets for unfinished tasks (kept under its older name). */
export const browserRetryInstruction = unfinishedTasksGuidance

export class IncompleteTasksRemedyError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/**
 * The Core fork that applies a remedy, after the one file edit `continue-to-review`
 * needs. Refuses anything but a failed definition run diagnosed `incomplete_tasks`.
 * The request id is derived from the run and remedy, so a retried click forks once.
 */
export function prepareIncompleteTasksFork(db: DbInstance, runId: string, remedy: IncompleteTasksRemedy, probe: DefinitionRunProbe): DefinitionForkRequest {
  const frozen = readDefinitionRun(db, runId)
  if (!frozen?.metadata.contextPath) throw new IncompleteTasksRemedyError('runtime_run_not_found', 'Definition run not found')
  const stored = db.prepare('SELECT failure_diagnosis FROM loop_runs WHERE id = ?').get(runId) as { failure_diagnosis: string | null } | undefined
  const diagnosis = parseStoredDiagnosis(stored?.failure_diagnosis ?? null)
  if (diagnosis?.kind !== 'incomplete_tasks') throw new IncompleteTasksRemedyError('remedy_not_applicable', 'The run did not stop on unfinished tasks')
  if (probe.status !== 'failed' || probe.lease?.active) throw new IncompleteTasksRemedyError('runtime_run_active', 'Only a failed run can continue this way')
  const nodes = (frozen.metadata.definition as { nodes?: Record<string, { params?: unknown }> } | undefined)?.nodes ?? {}
  const requestId = `remedy-${remedy}-${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`
  if (remedy === 'retry-with-browser') {
    const visit = latestVisit(probe, 'developer')
    if (!visit || !nodes.developer) throw new IncompleteTasksRemedyError('remedy_not_applicable', 'The run has no developer step to restart')
    return { requestId, fromNodePath: 'developer', scopeId: 'root', visit, state: { $vars: { implementationAttempts: 0, unblockAttempts: 0, lastImplementationHash: '' } } }
  }
  // Re-check tasks where the run last checked them, now that the remaining ones are human checks.
  const fromNodePath = latestVisit(probe, 'unblock-tasks') ? 'unblock-tasks' : 'tasks'
  const visit = latestVisit(probe, fromNodePath)
  if (!visit) throw new IncompleteTasksRemedyError('remedy_not_applicable', 'The run never checked its tasks')
  const directory = path.dirname(frozen.metadata.contextPath)
  const context = JSON.parse(readFileSync(frozen.metadata.contextPath, 'utf8')) as { artifactRoot?: unknown }
  const request = JSON.parse(readFileSync(path.join(directory, 'agent-runtime-request.json'), 'utf8')) as { change?: unknown }
  if (typeof context.artifactRoot !== 'string' || typeof request.change !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.change)) throw new IncompleteTasksRemedyError('remedy_not_applicable', 'The run has no OpenSpec change to continue')
  const file = path.join(context.artifactRoot, 'openspec', 'changes', request.change, 'tasks.md')
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) throw new IncompleteTasksRemedyError('remedy_not_applicable', 'The change has no tasks.md')
  // The recipe the run was compiled from says whether its Core understands the tag.
  const tagged = JSON.stringify(nodes.unblock?.params ?? '').includes('[human] tag')
  const { text, checks } = markRemainingAsHumanChecks(readFileSync(file, 'utf8'), tagged ? 'tag' : 'tick')
  writeFileSync(file, text)
  return { requestId, fromNodePath, scopeId: 'root', visit, state: { $vars: { humanChecks: checks.length ? checks : (diagnosis.incompleteTasks ?? []) } } }
}
