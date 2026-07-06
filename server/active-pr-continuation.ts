import { getLinkByLocalId } from './jira/jira-db'
import { listActivePrDeliveries, toPrDeliverySnapshot } from './rail-pr-store'
import { isValidBranchName } from './integration-branch'
import type { DbInstance } from './db'
import type { Exec } from './pr-publisher'
import type { GitRunner } from './worktree-manager'

export interface ContinuationTicketSpec {
  title?: string | null
  description?: string | null
  status?: string | null
  labels?: string[] | null
  jira_key?: string | null
}

export interface ActivePrContinuationTarget {
  ticketId: number
  branch: string
  baseBranch: string
  /** Present when the local branch does not exist but origin/<branch> does. */
  baseRef?: string
  prUrl: string | null
  prNumber: number | null
  isDraft: boolean | null
  source: 'rail-pr-delivery' | 'github-open-pr'
}

export interface ResolveActivePrContinuationInput {
  db: DbInstance
  git: GitRunner
  exec: Exec
  repoDir: string
  ticketIds: number[]
  integrationBranch: string
  fetchOk: boolean
  getTicketSpec: (ticketId: number) => ContinuationTicketSpec | undefined
}

interface OpenPr {
  number?: number
  title?: string
  body?: string | null
  headRefName?: string
  baseRefName?: string
  url?: string
  isDraft?: boolean
}

function parsePrNumber(prUrl: string | null | undefined): number | null {
  if (!prUrl) return null
  const m = /\/pull\/(\d+)/.exec(prUrl)
  return m ? parseInt(m[1], 10) : null
}

function normalizedText(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase() : ''
}

function words(v: string | null | undefined): string[] {
  return normalizedText(v)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4)
}

function ticketRefs(db: DbInstance, ticketId: number, spec: ContinuationTicketSpec | undefined): string[] {
  const refs = new Set<string>([`#${ticketId}`, `[${ticketId}]`, `ticket ${ticketId}`, `spec ${ticketId}`])
  let jiraKey = spec?.jira_key ?? null
  try {
    const link = getLinkByLocalId(db, ticketId)
    if (link && !link.tombstoned && link.jiraKey) jiraKey = link.jiraKey
  } catch {
    /* tolerated */
  }
  if (jiraKey?.trim()) refs.add(jiraKey.trim())
  return [...refs]
}

function hasJiraRef(db: DbInstance, ticketId: number, spec: ContinuationTicketSpec | undefined): boolean {
  if (spec?.jira_key?.trim()) return true
  try {
    const link = getLinkByLocalId(db, ticketId)
    return Boolean(link && !link.tombstoned && link.jiraKey)
  } catch {
    return false
  }
}

function prMatchKind(
  db: DbInstance,
  ticketId: number,
  spec: ContinuationTicketSpec | undefined,
  pr: OpenPr,
): 'explicit-ref' | 'title-similarity' | null {
  const haystack = `${pr.title ?? ''}\n${pr.body ?? ''}\n${pr.headRefName ?? ''}`.toLowerCase()
  for (const ref of ticketRefs(db, ticketId, spec)) {
    const needle = ref.toLowerCase()
    if (needle.startsWith('#') || needle.startsWith('[')) {
      if (haystack.includes(needle)) return 'explicit-ref'
    } else if (new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(haystack)) {
      return 'explicit-ref'
    }
  }

  const titleWords = words(spec?.title)
  if (titleWords.length < 3) return null
  const prWords = new Set(words(`${pr.title ?? ''} ${pr.body ?? ''}`))
  const hits = titleWords.filter((w) => prWords.has(w)).length
  return hits >= Math.max(3, Math.ceil(titleWords.length * 0.7)) ? 'title-similarity' : null
}

function canProbeGithubForContinuation(
  db: DbInstance,
  ticketId: number,
  spec: ContinuationTicketSpec | undefined,
): boolean {
  if (spec?.status === 'on_review') return true
  // Jira review can materialize as in_progress when the project has not mapped
  // its exact Review status to Specrails on_review. In that fallback, require a
  // Jira-linked ticket and later only accept explicit PR references.
  return spec?.status === 'in_progress' && hasJiraRef(db, ticketId, spec)
}

function matchAllowedForTicket(
  spec: ContinuationTicketSpec | undefined,
  kind: 'explicit-ref' | 'title-similarity',
): boolean {
  if (spec?.status === 'on_review') return true
  return kind === 'explicit-ref'
}

async function localBranchExists(git: GitRunner, repoDir: string, branch: string): Promise<boolean> {
  const r = await git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoDir)
  return r.code === 0
}

async function remoteBranchExists(git: GitRunner, repoDir: string, branch: string): Promise<boolean> {
  const r = await git.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], repoDir)
  return r.code === 0
}

async function materializeTarget(
  git: GitRunner,
  repoDir: string,
  fetchOk: boolean,
  ticketId: number,
  branch: string | null | undefined,
  baseBranch: string | null | undefined,
  prUrl: string | null,
  prNumber: number | null,
  isDraft: boolean | null,
  source: ActivePrContinuationTarget['source'],
): Promise<ActivePrContinuationTarget | null> {
  const head = branch?.trim()
  const base = baseBranch?.trim()
  if (!head || !base || head === base) return null
  if (!isValidBranchName(head) || !isValidBranchName(base)) return null

  if (await localBranchExists(git, repoDir, head)) {
    return { ticketId, branch: head, baseBranch: base, prUrl, prNumber, isDraft, source }
  }
  if (fetchOk && await remoteBranchExists(git, repoDir, head)) {
    return { ticketId, branch: head, baseBranch: base, baseRef: `origin/${head}`, prUrl, prNumber, isDraft, source }
  }
  return null
}

function internalDeliveryTargets(db: DbInstance, ticketIds: number[]): Map<number, ActivePrContinuationTarget> {
  const wanted = new Set(ticketIds)
  const out = new Map<number, ActivePrContinuationTarget>()
  for (const row of listActivePrDeliveries(db)) {
    const snap = toPrDeliverySnapshot(row)
    if (!snap.prUrl || !snap.branch) continue
    for (const ticketId of snap.ticketIds) {
      if (!wanted.has(ticketId) || out.has(ticketId)) continue
      out.set(ticketId, {
        ticketId,
        branch: snap.branch,
        baseBranch: snap.baseBranch,
        prUrl: snap.prUrl,
        prNumber: snap.prNumber,
        isDraft: snap.decision === 'pr_draft',
        source: 'rail-pr-delivery',
      })
    }
  }
  return out
}

async function listOpenPrs(exec: Exec, repoDir: string): Promise<OpenPr[]> {
  const r = await exec.run('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,body,headRefName,baseRefName,url,isDraft'], repoDir)
  if (r.code !== 0) return []
  try {
    const parsed = JSON.parse(r.stdout) as unknown
    return Array.isArray(parsed) ? parsed as OpenPr[] : []
  } catch {
    return []
  }
}

/**
 * Detects tickets whose next implementation pass should continue an already
 * open PR branch instead of creating fresh work from the integration branch.
 * It is intentionally fail-open: no gh, no auth, ambiguous branch state, or no
 * confident PR match all return no target, preserving the normal new-work flow.
 */
export async function resolveActivePrContinuationTargets(
  input: ResolveActivePrContinuationInput,
): Promise<Map<number, ActivePrContinuationTarget>> {
  const out = new Map<number, ActivePrContinuationTarget>()
  const internal = internalDeliveryTargets(input.db, input.ticketIds)
  for (const [ticketId, target] of internal) {
    const materialized = await materializeTarget(
      input.git,
      input.repoDir,
      input.fetchOk,
      ticketId,
      target.branch,
      target.baseBranch,
      target.prUrl,
      target.prNumber,
      target.isDraft,
      'rail-pr-delivery',
    )
    if (materialized) out.set(ticketId, materialized)
  }

  const remaining = input.ticketIds.filter((id) => !out.has(id))
  const candidateIds = remaining.filter((id) => canProbeGithubForContinuation(input.db, id, input.getTicketSpec(id)))
  if (candidateIds.length === 0) return out

  const openPrs = await listOpenPrs(input.exec, input.repoDir)
  for (const ticketId of candidateIds) {
    const spec = input.getTicketSpec(ticketId)
    const matches = openPrs.filter((pr) => {
      const kind = prMatchKind(input.db, ticketId, spec, pr)
      return kind ? matchAllowedForTicket(spec, kind) : false
    })
    if (matches.length !== 1) continue
    const pr = matches[0]
    const materialized = await materializeTarget(
      input.git,
      input.repoDir,
      input.fetchOk,
      ticketId,
      pr.headRefName,
      pr.baseRefName || input.integrationBranch,
      pr.url ?? null,
      typeof pr.number === 'number' ? pr.number : parsePrNumber(pr.url),
      typeof pr.isDraft === 'boolean' ? pr.isDraft : null,
      'github-open-pr',
    )
    if (materialized) out.set(ticketId, materialized)
  }
  return out
}
