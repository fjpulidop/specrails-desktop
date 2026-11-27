import type { RepositoryProject } from '../../../../project-repositories'
import type { Exec } from '../pr-publisher'
import type { PrCiAdmissionRow, PrCiAdmissionTarget } from './pr-ci-admission'
import type { PrCiAdmissionRuntime } from './pr-ci-admission-runtime'
import { matchProjectRepository, parsePrUrl, PrCiResolveError, resolveProjectPrTarget, type ParsedPrUrl } from './pr-ci-resolver'

/**
 * "Run on a PR" (Loops ▸ Fix PR CI): repair the CI of any open pull request of
 * one of the person's projects, on demand. The PR's repository picks the
 * project (never a guess: no match or several matches is a stated refusal).
 * The run is the same host-frozen mission-origin admission a mission's offer
 * starts, with the same guarantees (push access, same-repository head,
 * unchanged refs, one writer per PR), and its mission is where the progress
 * and the result are shown: the PR's earlier mission when it still exists,
 * else a new one in that project.
 */
export interface PrCiOnDemandProject {
  project: RepositoryProject & { name?: string }
}

export interface PrCiOnDemandDeps<C extends PrCiOnDemandProject> {
  exec: Exec
  contexts(): C[]
  runtimeOf(context: C): Pick<PrCiAdmissionRuntime, 'unavailable' | 'admit' | 'start'>
  /** The mission that shows this PR's repair: reused when the PR already has a live one, else created. */
  missionFor(context: C, target: PrCiAdmissionTarget, parsed: ParsedPrUrl): string
}

export type PrCiOnDemandResult =
  | { ok: true; status: 202 | 200; projectId: string; conversationId: string; admissionId: string; runId: string; alreadyRunning: boolean }
  | { ok: false; status: number; error: string; detail: string; projectId?: string; conversationId?: string; projects?: Array<{ id: string; name: string }> }

const refuse = (status: number, error: string, detail: string, extra: Partial<Extract<PrCiOnDemandResult, { ok: false }>> = {}): PrCiOnDemandResult =>
  ({ ok: false, status, error, detail, ...extra })

export async function runPrCiOnPr<C extends PrCiOnDemandProject>(deps: PrCiOnDemandDeps<C>, input: { prUrl: string; projectId?: string | null }): Promise<PrCiOnDemandResult> {
  let parsed: ParsedPrUrl
  try { parsed = parsePrUrl(input.prUrl) } catch (error) {
    if (error instanceof PrCiResolveError) return refuse(error.status, error.code, error.message)
    throw error
  }
  const all = deps.contexts()
  const candidates = input.projectId ? all.filter(c => c.project.id === input.projectId) : all
  if (input.projectId && !candidates.length) return refuse(404, 'project_not_found', 'That project is not open in Specrails.')

  const matches: C[] = []
  for (const context of candidates) {
    try { await matchProjectRepository(deps.exec, context.project, parsed); matches.push(context) } catch (error) {
      if (!(error instanceof PrCiResolveError)) throw error
      // A project with two clones of the PR's repository cannot attribute it: say so when it was named.
      if (error.code === 'pr_repository_ambiguous' && input.projectId) return refuse(error.status, error.code, error.message)
    }
  }
  if (!matches.length) {
    return refuse(404, 'pr_repository_not_in_any_project', `No project here has ${parsed.slug} as a repository. Add the repository to a project, then run it again.`)
  }
  if (matches.length > 1) {
    return refuse(409, 'pr_project_ambiguous', `${parsed.slug} is a repository of more than one project; choose the project to run in.`,
      { projects: matches.map(c => ({ id: c.project.id, name: c.project.name ?? c.project.id })) })
  }

  const context = matches[0]
  const runtime = deps.runtimeOf(context)
  const closed = await runtime.unavailable()
  if (closed) return refuse(closed.status, closed.error, closed.detail)

  // Validated (open, same-repository, pushable) before any mission is created or any agent starts.
  let target: PrCiAdmissionTarget
  try { target = await resolveProjectPrTarget({ exec: deps.exec, project: context.project, prUrl: parsed.url }) } catch (error) {
    if (error instanceof PrCiResolveError) return refuse(error.status, error.code, error.message)
    throw error
  }
  const projectId = context.project.id
  const conversationId = deps.missionFor(context, target, parsed)
  const admitted = runtime.admit({ ...target, originConversationId: conversationId })
  if (!admitted.ok) return refuse(admitted.status, admitted.error, admitted.detail, { projectId, conversationId })
  const admission: PrCiAdmissionRow = admitted.admission
  // A started admission keeps its own mission; show that one.
  const shownIn = admission.origin_conversation_id ?? conversationId
  const started = await runtime.start(admission.id)
  if (started.ok) return { ok: true, status: 202, projectId, conversationId: shownIn, admissionId: admission.id, runId: started.runId, alreadyRunning: false }
  if (started.error === 'pr_ci_already_running' && started.runId) {
    return { ok: true, status: 200, projectId, conversationId: shownIn, admissionId: admission.id, runId: started.runId, alreadyRunning: true }
  }
  return refuse(started.status, started.error, started.detail, { projectId, conversationId: shownIn })
}
