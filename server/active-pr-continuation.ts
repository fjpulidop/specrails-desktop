import { getLinkByLocalId } from './jira/jira-db'
import { listActivePrDeliveries, toPrDeliverySnapshot } from './rail-pr-store'
import { isValidBranchName } from './integration-branch'
import type { DbInstance } from './db'
import type { Exec } from './pr-publisher'
import type { GitRunner } from './worktree-manager'
import { isExactOpenPr, observePrLifecycle } from './pr-lifecycle'

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
  /** Present when origin/<branch> exists; used to create or safely refresh the PR branch. */
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
  state?: string
}

type PrMatchKind = 'pr-number' | 'ticket-ref' | 'title-similarity'
const PR_MATCH_RANK: Record<PrMatchKind, number> = {
  'title-similarity': 1,
  'ticket-ref': 2,
  'pr-number': 3,
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

function mentionedPrNumbers(spec: ContinuationTicketSpec | undefined): Set<number> {
  const text = `${spec?.title ?? ''}\n${spec?.description ?? ''}`
  const out = new Set<number>()
  for (const match of text.matchAll(/\b(?:pr|pull request)\s*#?\s*(\d{1,10})\b/gi)) {
    out.add(parseInt(match[1], 10))
  }
  for (const match of text.matchAll(/\/pull\/(\d{1,10})(?:\b|[/?#])/gi)) {
    out.add(parseInt(match[1], 10))
  }
  return out
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
): PrMatchKind | null {
  const mentionedPrs = mentionedPrNumbers(spec)
  const prNumber = typeof pr.number === 'number' ? pr.number : parsePrNumber(pr.url)
  if (prNumber !== null && mentionedPrs.has(prNumber)) return 'pr-number'

  const haystack = `${pr.title ?? ''}\n${pr.body ?? ''}\n${pr.headRefName ?? ''}`.toLowerCase()
  for (const ref of ticketRefs(db, ticketId, spec)) {
    const needle = ref.toLowerCase()
    if (needle.startsWith('#') || needle.startsWith('[')) {
      if (haystack.includes(needle)) return 'ticket-ref'
    } else if (new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(haystack)) {
      return 'ticket-ref'
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
  kind: PrMatchKind,
): boolean {
  if (spec?.status === 'on_review') return true
  return kind !== 'title-similarity'
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

  const remoteRef = fetchOk && await remoteBranchExists(git, repoDir, head) ? `origin/${head}` : undefined
  if (await localBranchExists(git, repoDir, head)) {
    return { ticketId, branch: head, baseBranch: base, baseRef: remoteRef, prUrl, prNumber, isDraft, source }
  }
  if (remoteRef) return { ticketId, branch: head, baseBranch: base, baseRef: remoteRef, prUrl, prNumber, isDraft, source }
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

const PR_JSON_FIELDS = 'number,title,body,headRefName,baseRefName,url,isDraft,state'

async function listOpenPrs(exec: Exec, repoDir: string): Promise<OpenPr[]> {
  const r = await exec.run('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', PR_JSON_FIELDS], repoDir)
  if (r.code !== 0) return []
  try {
    const parsed = JSON.parse(r.stdout) as unknown
    return Array.isArray(parsed) ? parsed as OpenPr[] : []
  } catch {
    return []
  }
}

async function viewOpenPr(exec: Exec, repoDir: string, prNumber: number): Promise<OpenPr | null> {
  const r = await exec.run('gh', ['pr', 'view', String(prNumber), '--json', PR_JSON_FIELDS], repoDir)
  if (r.code !== 0) return null
  try {
    const parsed = JSON.parse(r.stdout) as OpenPr
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (typeof parsed.state === 'string' && parsed.state.toUpperCase() !== 'OPEN') return null
    return parsed
  } catch {
    return null
  }
}

async function mentionedOpenPrs(exec: Exec, repoDir: string, prNumbers: Set<number>): Promise<OpenPr[]> {
  const out: OpenPr[] = []
  for (const prNumber of prNumbers) {
    const pr = await viewOpenPr(exec, repoDir, prNumber)
    if (pr) out.push(pr)
  }
  return out
}

function mergeOpenPrs(prs: OpenPr[]): OpenPr[] {
  const out: OpenPr[] = []
  const seen = new Set<string>()
  for (const pr of prs) {
    const key = typeof pr.number === 'number' ? `n:${pr.number}` : pr.url ? `u:${pr.url}` : null
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    out.push(pr)
  }
  return out
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
  const lifecycleByUrl = new Map<string, ReturnType<typeof observePrLifecycle>>()
  for (const [ticketId, target] of internal) {
    if (!target.prUrl) continue
    let lifecycle = lifecycleByUrl.get(target.prUrl)
    if (!lifecycle) {
      lifecycle = observePrLifecycle(input.exec, input.repoDir, target.prUrl)
      lifecycleByUrl.set(target.prUrl, lifecycle)
    }
    const observed = await lifecycle
    // A ledger row is only a hint. GitHub remains lifecycle authority: a stale
    // draft/ready row for a CLOSED/MERGED or different head/base PR must not be
    // superseded and must not lend its branch to another implementation run.
    if (!observed.ok || !isExactOpenPr(observed, target.branch, target.baseBranch)) continue
    const materialized = await materializeTarget(
      input.git,
      input.repoDir,
      input.fetchOk,
      ticketId,
      target.branch,
      target.baseBranch,
      target.prUrl,
      target.prNumber,
      observed.isDraft,
      'rail-pr-delivery',
    )
    if (materialized) out.set(ticketId, materialized)
  }

  const remaining = input.ticketIds.filter((id) => !out.has(id))
  const candidateIds = remaining.filter((id) => canProbeGithubForContinuation(input.db, id, input.getTicketSpec(id)))
  if (candidateIds.length === 0) return out

  const mentionedPrs = new Set<number>()
  for (const ticketId of candidateIds) {
    for (const prNumber of mentionedPrNumbers(input.getTicketSpec(ticketId))) mentionedPrs.add(prNumber)
  }
  const openPrs = mergeOpenPrs([
    ...await listOpenPrs(input.exec, input.repoDir),
    ...await mentionedOpenPrs(input.exec, input.repoDir, mentionedPrs),
  ])
  for (const ticketId of candidateIds) {
    const spec = input.getTicketSpec(ticketId)
    const matches = openPrs.flatMap((pr) => {
      const kind = prMatchKind(input.db, ticketId, spec, pr)
      return kind && matchAllowedForTicket(spec, kind) ? [{ pr, kind }] : []
    })
    if (matches.length === 0) continue
    const bestRank = Math.max(...matches.map((m) => PR_MATCH_RANK[m.kind]))
    const best = matches.filter((m) => PR_MATCH_RANK[m.kind] === bestRank)
    if (best.length !== 1) continue
    const pr = best[0].pr
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
