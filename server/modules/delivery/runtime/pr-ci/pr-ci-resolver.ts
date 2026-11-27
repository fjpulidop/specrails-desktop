import { isValidBranchName } from '../../../../integration-branch'
import { getProjectRepositories, type ProjectRepository, type RepositoryProject } from '../../../../project-repositories'
import { observePrLifecycle } from '../pr-lifecycle'
import type { Exec } from '../pr-publisher'
import type { PrCiAdmissionTarget } from './pr-ci-admission'

/** Distinct, machine-readable reasons a PR cannot be offered or started for CI repair. */
export type PrCiResolveFailureCode =
  | 'pr_url_invalid'
  | 'pr_repository_not_in_project'
  | 'pr_repository_ambiguous'
  | 'target_pr_not_found'
  | 'pr_github_unavailable'
  | 'pr_not_open'
  | 'pr_fork_unsupported'
  | 'pr_no_push_access'
  | 'target_pr_invalid'

export class PrCiResolveError extends Error {
  constructor(readonly code: PrCiResolveFailureCode, message: string, readonly status: number = 409) {
    super(message)
    this.name = 'PrCiResolveError'
  }
}

export interface ParsedPrUrl { host: string; slug: string; prNumber: number; url: string }

const PR_URL_RE = /^https:\/\/([^/\s]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})\/?$/

export function parsePrUrl(value: string): ParsedPrUrl {
  const match = PR_URL_RE.exec(value.trim())
  const prNumber = match ? Number(match[4]) : 0
  if (!match || prNumber < 1) throw new PrCiResolveError('pr_url_invalid', 'Provide the full pull request URL, for example https://github.com/owner/repo/pull/12.', 400)
  const host = match[1].toLowerCase()
  const slug = `${match[2]}/${match[3]}`.toLowerCase()
  return { host, slug, prNumber, url: `https://${host}/${match[2]}/${match[3]}/pull/${prNumber}` }
}

/** `host/owner/repo` of an https, ssh:// or scp-style remote, lowercase, or null. */
export function remoteIdentity(remote: string): string | null {
  const text = remote.trim()
  const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)([^/:\s]+)(?::\d+)?[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text)
  return match ? `${match[1]}/${match[2]}/${match[3]}`.toLowerCase() : null
}

async function originIdentity(exec: Exec, repository: ProjectRepository): Promise<string | null> {
  try {
    const result = await exec.run('git', ['remote', 'get-url', 'origin'], repository.path)
    return result.code === 0 ? remoteIdentity(result.stdout) : null
  } catch { return null }
}

/** The one project repository whose origin is the PR's repository; never a guess. */
export async function matchProjectRepository(exec: Exec, project: RepositoryProject, parsed: ParsedPrUrl): Promise<ProjectRepository> {
  const wanted = `${parsed.host}/${parsed.slug}`
  const matches: ProjectRepository[] = []
  for (const repository of getProjectRepositories(project)) {
    if (repository.kind !== 'git') continue
    if (await originIdentity(exec, repository) === wanted) matches.push(repository)
  }
  if (!matches.length) throw new PrCiResolveError('pr_repository_not_in_project', `${parsed.slug} is not a repository of this project.`)
  if (matches.length > 1) throw new PrCiResolveError('pr_repository_ambiguous', `More than one repository of this project has ${parsed.slug} as its origin; the pull request cannot be attributed to one of them.`)
  return matches[0]
}

const NOT_FOUND_RE = /could not resolve to a pullrequest|no pull requests? found|http 404|not found/i

/** A failed `gh pr view` is "missing" only when GitHub says so; anything else is an access or connection problem. */
export function classifyGithubFailure(detail: string): PrCiResolveError {
  if (NOT_FOUND_RE.test(detail)) return new PrCiResolveError('target_pr_not_found', `The pull request was not found: ${detail}`, 404)
  return new PrCiResolveError('pr_github_unavailable', `GitHub could not be reached or refused access (authentication or connection problem), so the pull request was not checked: ${detail}`, 502)
}

export const FORK_LIMITATION = 'The pull request head lives on a fork (or same-repository origin could not be proven). Specrails pushes with the project repository\'s own rights, so fork branches are not writable; no work was started.'

export const NO_PUSH_ACCESS = 'Your GitHub account cannot push to this repository, so a fix could never reach the pull request; no work was started. Ask for write access, or let someone who has it run the repair.'

/**
 * Whether the signed-in GitHub account can push to the PR's repository (`permissions.push`,
 * true for write, maintain and admin). A repair whose fix cannot be pushed would spend a run
 * for nothing, so this is checked before anything starts. An unreadable answer is an access
 * or connection problem, never a silent yes.
 */
export async function assertPushAccess(exec: Exec, repoDir: string, parsed: ParsedPrUrl): Promise<void> {
  let result
  try {
    result = await exec.run('gh', ['api', ...(parsed.host === 'github.com' ? [] : ['--hostname', parsed.host]), `repos/${parsed.slug}`, '--jq', '.permissions.push'], repoDir)
  } catch (error) {
    throw classifyGithubFailure(error instanceof Error ? error.message : String(error))
  }
  if (result.code !== 0) throw classifyGithubFailure((result.stderr || result.stdout).trim().split('\n')[0] || `exit ${result.code}`)
  const answer = result.stdout.trim()
  if (answer === 'true') return
  if (answer === 'false' || answer === 'null' || answer === '') throw new PrCiResolveError('pr_no_push_access', NO_PUSH_ACCESS, 403)
  throw new PrCiResolveError('pr_github_unavailable', `GitHub returned an unreadable permission answer (${answer.slice(0, 80)}), so push access was not proven; no work was started.`, 502)
}

/** Validate the PR against GitHub and freeze the target. Pure of persistence. */
export async function resolveProjectPrTarget(input: { exec: Exec; project: RepositoryProject; prUrl: string; originConversationId?: string | null }): Promise<PrCiAdmissionTarget> {
  const parsed = parsePrUrl(input.prUrl)
  const repository = await matchProjectRepository(input.exec, input.project, parsed)
  const observed = await observePrLifecycle(input.exec, repository.path, parsed.url)
  if (!observed.ok) throw classifyGithubFailure(observed.detail)
  if (observed.state !== 'OPEN') throw new PrCiResolveError('pr_not_open', `The pull request is ${observed.state.toLowerCase()}, not open.`)
  if (observed.isCrossRepository !== false) throw new PrCiResolveError('pr_fork_unsupported', FORK_LIMITATION)
  await assertPushAccess(input.exec, repository.path, parsed)
  const head = observed.headRefName?.trim()
  const base = observed.baseRefName?.trim()
  if (!head || !base || head === base || !isValidBranchName(head) || !isValidBranchName(base) || !observed.headRefOid) {
    throw new PrCiResolveError('target_pr_invalid', `The pull request head/base refs are unusable (head=${head ?? '?'}, base=${base ?? '?'}).`)
  }
  return {
    projectId: input.project.id, repositoryId: repository.id, repositoryPath: repository.path,
    prNumber: parsed.prNumber, prUrl: parsed.url, headBranch: head, headSha: observed.headRefOid.toLowerCase(),
    baseBranch: base, originConversationId: input.originConversationId ?? null,
  }
}
