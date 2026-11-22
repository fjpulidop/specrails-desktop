import { z } from 'zod'
import type { DbInstance } from '../../../db'
import type { ProjectRow } from '../../../desktop-db'
import { getActivePrDeliveryByRail, getPrDelivery, listActivePrDeliveries, listTerminalPrDeliveries, readSpecSnapshot, toPrDeliverySnapshot, type PrDeliverySnapshot, type RailPrDeliveryRow } from '../../../modules/delivery/runtime/rail-pr-store'
import { getRail } from '../../../modules/delivery/runtime/rails-store'
import { revisionLaunchTicketIds } from '../../../modules/delivery/runtime/rail-delivery-revision'
import { listRepositoryDeliveries } from '../../../modules/delivery/runtime/multi-repo-execution'
import { PR_CI_LOOP_ID } from '../../../modules/delivery/runtime/pr-ci/pr-ci-target'
import { resolveAcceptCapability, type AcceptTarget } from '../../../modules/execution/runtime/accept-ladder'
import { apiCall, McpApiError } from '../../tools/types'
import type { McpTier } from '../../mcp-tiers'
import { shortHash } from '../core/canonical'
import { decodeCursor, encodeCursor, pageOf } from '../core/cursor'
import type { ConfirmClass, DecisionState } from '../core/decision-state'
import { V2ToolError, oneLine, result } from '../core/envelope'
import { choicesFromState, type ChoicePoint } from '../core/choices'
import { formatRef, parseRef, type Ref } from '../core/refs'
import { defineTool, type PreviewInput, type V2CallContext } from '../core/registry'
import { statusFromDelivery } from '../core/status-map'
import { clip, clipDeep, present } from '../core/text'
import { neutralize, reveal, untrusted } from '../core/untrusted'
import { F, WRITE_FIELDS, optionsOf, resolveFields } from '../core/views'
import { projectDeliveryState, type DeliveryStateFacts, type MergePreviewSummary } from '../projectors/delivery-state'

export const DELIVERY_DECISIONS = [
  'create_pr', 'publish', 'merge_local', 'discard', 'dismiss', 'poll_merge', 'reopen', 'acknowledge_no_changes',
  'recover_and_retry', 'request_changes', 'checkout', 'ci_fix', 'refresh_on_base', 'local_restore', 'local_bring_back', 'local_discard_branch',
  'approve',
] as const
export type DeliveryDecision = (typeof DELIVERY_DECISIONS)[number]

/**
 * Tier and confirmation class of each decision (§6 of the design).
 * - `approve` is the review packet's one "Accept" verb: it resolves to
 *   `create_pr` or `merge_local` (accept-ladder.ts) and is confirmed like the stricter of the two.
 * - `refresh_on_base` runs the conflict resolver (an AI step) and a re-verification run, so it is costly.
 */
export const DECISION_POLICY: Record<DeliveryDecision, { tier: McpTier; confirm: ConfirmClass | null }> = {
  create_pr: { tier: 'destructive', confirm: 'external' },
  publish: { tier: 'destructive', confirm: 'external' },
  reopen: { tier: 'destructive', confirm: 'external' },
  merge_local: { tier: 'destructive', confirm: 'irreversible' },
  discard: { tier: 'destructive', confirm: 'irreversible' },
  local_discard_branch: { tier: 'destructive', confirm: 'irreversible' },
  approve: { tier: 'destructive', confirm: 'irreversible' },
  dismiss: { tier: 'write', confirm: null },
  poll_merge: { tier: 'write', confirm: null },
  acknowledge_no_changes: { tier: 'write', confirm: null },
  checkout: { tier: 'write', confirm: null },
  local_restore: { tier: 'write', confirm: null },
  local_bring_back: { tier: 'write', confirm: null },
  refresh_on_base: { tier: 'ai-spawn', confirm: 'costly' },
  recover_and_retry: { tier: 'ai-spawn', confirm: 'costly' },
  request_changes: { tier: 'ai-spawn', confirm: 'costly' },
  ci_fix: { tier: 'ai-spawn', confirm: 'costly' },
}

const policyOf = (args: Record<string, unknown>) => DECISION_POLICY[args.decision as DeliveryDecision] ?? { tier: 'destructive' as const, confirm: 'irreversible' as const }

const FIELDS = ['packet', 'changes', 'file_diff', 'merge_preview', 'ci', 'local_changes'] as const
type Section = (typeof FIELDS)[number]

/** Decisions served by POST /rails/pr-decision (decision-policy.ts `PR_DECISION_ACTIONS`). */
const PR_DECISION: Partial<Record<DeliveryDecision, string>> = {
  create_pr: 'create-pr', publish: 'publish', merge_local: 'merge-local', discard: 'discard', dismiss: 'dismiss',
  poll_merge: 'poll-merge', reopen: 'reopen', acknowledge_no_changes: 'acknowledge-no-changes', recover_and_retry: 'recover-and-retry',
}
const LOCAL_CHANGES: Partial<Record<DeliveryDecision, string>> = { local_restore: 'restore', local_bring_back: 'bring-back', local_discard_branch: 'discard-branch' }
/** Git/GitHub work that can take minutes (push, PR creation, merge, resolver + verification). */
const LONG: ReadonlySet<DeliveryDecision> = new Set(['create_pr', 'publish', 'reopen', 'merge_local', 'discard', 'refresh_on_base', 'recover_and_retry'])
/** Decisions the person is next for (inbox-worthy). */
const OPEN: ReadonlySet<string> = new Set(['on_review', 'pr_draft', 'pr_ready', 'pr_failed', 'no_changes', 'implementation_failed', 'pr_closed'])

const TERMINAL_HISTORY_CAP = 500
const DIFF_PAGE_LINES = 300
const DIFF_PAGE_CHARS = 12_000
const DIFF_LINE_CHARS = 400
const FILES_DEFAULT = 50

// ── Small helpers ───────────────────────────────────────────────────────────

const str = (value: unknown): string | null => typeof value === 'string' && value ? value : null

const projectBase = (project: ProjectRow) => `/projects/${encodeURIComponent(project.id)}`

function projectDb(ctx: V2CallContext, project: ProjectRow): DbInstance {
  const db = ctx.registry.getContext(project.id)?.db
  if (!db) throw new V2ToolError('provider_unavailable', ctx.v2.t('deliveries.error.not_loaded', { project: project.name }), { retryable: true })
  return db
}

/** Short-lived machine probes (not project data): what Accept does per repository path, and CI-loop availability. */
const PROBE_TTL_MS = 60_000
const acceptCache = new Map<string, { at: number; target: AcceptTarget }>()
let ciAvailability: { at: number; value: boolean } | null = null

function rememberAccept(path: string, target: AcceptTarget): void {
  acceptCache.set(path, { at: Date.now(), target })
  if (acceptCache.size > 200) acceptCache.delete(acceptCache.keys().next().value as string)
}

async function acceptTargetFor(path: string): Promise<AcceptTarget | null> {
  const cached = acceptCache.get(path)
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.target
  try {
    const capability = await resolveAcceptCapability({ repoDir: path })
    rememberAccept(path, capability.target)
    return capability.target
  } catch { return null }
}

async function ciAvailable(ctx: V2CallContext, project: ProjectRow): Promise<boolean> {
  if (ciAvailability && Date.now() - ciAvailability.at < PROBE_TTL_MS) return ciAvailability.value
  try {
    const body = await apiCall(ctx, 'GET', `${projectBase(project)}/rails/pr-ci-availability`) as { available?: unknown }
    ciAvailability = { at: Date.now(), value: body?.available === true }
  } catch { return false }
  return ciAvailability.value
}

/** Test-only: forget the machine probes. */
export function __resetDeliveryProbes(): void {
  acceptCache.clear()
  ciAvailability = null
}

interface MergePreviewRow { deliveryId: string; status: MergePreviewSummary['status']; conflictFiles?: string[]; conflictFileCount: number; baseAdvancedBy: number | null; siblings?: unknown[]; baseRef?: string; reason?: string | null }

/** Merge previews of the project's pending deliveries (read-only Git, cached by commit sha server-side). */
async function mergePreviews(ctx: V2CallContext, project: ProjectRow, deliveryId?: string): Promise<Map<string, MergePreviewRow>> {
  try {
    const query = deliveryId ? `?deliveryId=${encodeURIComponent(deliveryId)}` : ''
    const body = await apiCall(ctx, 'GET', `${projectBase(project)}/rails/merge-preview${query}`) as { previews?: MergePreviewRow[] }
    return new Map((body?.previews ?? []).map((preview) => [preview.deliveryId, preview]))
  } catch { return new Map() }
}

const summaryOf = (preview: MergePreviewRow | undefined): MergePreviewSummary | null => preview
  ? { status: preview.status, conflictFileCount: preview.conflictFileCount, siblingConflictCount: preview.siblings?.length ?? 0, baseAdvancedBy: preview.baseAdvancedBy }
  : null

// ── Loading a delivery and its decision state ───────────────────────────────

interface Loaded {
  project: ProjectRow
  db: DbInstance
  row: RailPrDeliveryRow
  snap: PrDeliverySnapshot
  ref: Ref
  /** One repository of a multi-repository delivery (a child ref or `options.repositoryId`). */
  repositoryId: string | null
}

function loadDelivery(ctx: V2CallContext, args: Record<string, unknown>): Loaded {
  const target = ctx.v2.target(args, 'delivery')
  const project = target.project!
  const db = projectDb(ctx, project)
  let row = getPrDelivery(db, target.id)
  const notFound = () => new V2ToolError('not_found', ctx.v2.t('deliveries.error.not_found', { ref: target.ref }), {
    next: [{ tool: 'specrails_deliveries', args: { action: 'list', project: project.slug }, why: 'Deliveries of this project.' }],
  })
  if (!row) throw notFound()
  let repositoryId = str(optionsOf(args).repositoryId)
  if (row.parent_delivery_id) {
    repositoryId = repositoryId ?? row.repository_id ?? null
    row = getPrDelivery(db, row.parent_delivery_id)
    if (!row) throw notFound()
  }
  return { project, db, row, snap: toPrDeliverySnapshot(row), ref: formatRef('delivery', row.id, project.slug), repositoryId }
}

interface FactsHints {
  previews?: Map<string, MergePreviewRow>
  accept?: AcceptTarget | null
}

async function factsOf(ctx: V2CallContext, l: Pick<Loaded, 'project' | 'db' | 'row' | 'snap'>, hints: FactsHints = {}): Promise<DeliveryStateFacts> {
  const { row, snap, db, project } = l
  const active = getActivePrDeliveryByRail(db, row.rail_index)?.id === row.id
  let railTicketIds: number[] = []
  // The launch route's own rule: a delivery that released its rail is revised on its frozen spec set.
  try { railTicketIds = revisionLaunchTicketIds(getRail(db, row.rail_index).ticketIds, active ? snap : null, row.id) } catch { /* no rail: no revision */ }
  const prOpen = (row.decision === 'pr_draft' || row.decision === 'pr_ready')
  const ci = prOpen && await ciAvailable(ctx, project)
    ? { ...row, operation: row.operation ?? null, repositories: row.execution_manifest ? listRepositoryDeliveries(db, row.id) : null }
    : null
  const previews = hints.previews ?? (OPEN.has(row.decision) ? await mergePreviews(ctx, project, row.id) : new Map())
  return {
    snap,
    active,
    railTicketIds,
    ci,
    mergePreview: summaryOf(previews.get(row.id)),
    accept: hints.accept !== undefined ? hints.accept : await acceptTargetFor(project.path),
    since: row.on_review_at ?? row.updated_at ?? null,
  }
}

async function stateOf(ctx: V2CallContext, l: Loaded, hints: FactsHints = {}, cost?: DecisionState['cost']): Promise<DecisionState> {
  const input = projectDeliveryState(l.ref, await factsOf(ctx, l, hints))
  return ctx.v2.state(cost ? { ...input, cost } : input)
}

const DECISION_LABEL_KEY = (decision: string) =>
  ['request_changes', 'checkout', 'refresh_on_base', 'local_restore', 'local_bring_back', 'local_discard_branch', 'approve'].includes(decision)
    ? `deliveries.offer.${decision}` : `core.offer.delivery.${decision}`

function titleOf(row: RailPrDeliveryRow): string {
  const specs = readSpecSnapshot(row.spec_snapshot) ?? []
  const first = specs.find((spec) => spec.title)?.title
  const ids = (() => { try { return (JSON.parse(row.ticket_ids) as number[]) } catch { return [] } })()
  const base = first ?? (ids.length ? `#${ids[0]}` : row.loop_name)
  return neutralize(ids.length > 1 ? `${base} (+${ids.length - 1})` : base)
}

function specRefs(project: ProjectRow, snap: PrDeliverySnapshot): Ref[] {
  return snap.ticketIds.map((id) => formatRef('spec', id, project.slug))
}

function refsOf(l: Pick<Loaded, 'project' | 'snap' | 'ref'>): Record<string, Ref> {
  const refs: Record<string, Ref> = { delivery: l.ref }
  for (const id of l.snap.ticketIds.slice(0, 10)) refs[`spec.${id}`] = formatRef('spec', id, l.project.slug)
  for (const id of l.snap.runIds.slice(0, 10)) refs[`run.${id}`] = formatRef('run', id, l.project.slug)
  return refs
}

// ── list ────────────────────────────────────────────────────────────────────

interface Candidate { project: ProjectRow; db: DbInstance; row: RailPrDeliveryRow }

function listFilter(args: Record<string, unknown>) {
  const filter = args.filter && typeof args.filter === 'object' && !Array.isArray(args.filter) ? args.filter as Record<string, unknown> : {}
  const decisions = Array.isArray(filter.decision) ? filter.decision.filter((d): d is string => typeof d === 'string')
    : typeof filter.decision === 'string' ? [filter.decision] : []
  const specRaw = filter.spec
  const parsedSpec = typeof specRaw === 'string' ? parseRef(specRaw) : null
  const spec = typeof specRaw === 'number' ? specRaw
    : parsedSpec?.kind === 'spec' ? Number(parsedSpec.id)
      : typeof specRaw === 'string' && /^#?\d+$/.test(specRaw) ? Number(specRaw.replace('#', '')) : null
  const since = typeof filter.since === 'string' && !Number.isNaN(Date.parse(filter.since)) ? new Date(filter.since).toISOString() : null
  const pending = filter.pending === true
  return { decisions, spec, since, pending, key: shortHash({ decisions, spec, since, pending }) }
}

function rank(row: RailPrDeliveryRow): number {
  if (OPEN.has(row.decision)) return 0
  if (row.decision === 'building') return 1
  return 2
}

async function listDeliveries(ctx: V2CallContext, args: Record<string, unknown>) {
  const scoped = present(args.project) || !!ctx.requestProjectId || !!ctx.sessionState?.activeProjectId
  const projects: Array<{ project: ProjectRow; db: DbInstance }> = scoped
    ? (() => { const project = ctx.v2.project(args); return [{ project, db: projectDb(ctx, project) }] })()
    : ctx.registry.listContexts().filter((c) => c.db).map((c) => ({ project: ctx.v2.projects().find((row) => row.id === c.project.id) ?? c.project as unknown as ProjectRow, db: c.db }))
  const filter = listFilter(args)
  const candidates: Candidate[] = []
  for (const { project, db } of projects) {
    const rows = [...listActivePrDeliveries(db), ...(filter.pending ? [] : listTerminalPrDeliveries(db).slice(0, TERMINAL_HISTORY_CAP))]
    for (const row of rows) {
      if (filter.pending && !OPEN.has(row.decision)) continue
      if (filter.decisions.length && !filter.decisions.includes(row.decision) && !filter.decisions.includes(statusFromDelivery(row.decision))) continue
      if (filter.since && (row.updated_at ?? '') < filter.since) continue
      if (filter.spec !== null) {
        let ids: unknown[] = []
        try { ids = JSON.parse(row.ticket_ids) as unknown[] } catch { /* none */ }
        if (!ids.includes(filter.spec)) continue
      }
      candidates.push({ project, db, row })
    }
  }
  candidates.sort((a, b) => rank(a.row) - rank(b.row) || (b.row.updated_at ?? '').localeCompare(a.row.updated_at ?? ''))
  const pending = candidates.filter((c) => OPEN.has(c.row.decision)).length
  const { items, page, base } = pageOf(candidates, { cursor: args.cursor, limit: args.limit, key: filter.key, defaultLimit: 25 })

  // One merge-preview read and one accept probe per project on the page.
  const previews = new Map<string, Map<string, MergePreviewRow>>()
  for (const c of items) {
    if (!previews.has(c.project.id)) previews.set(c.project.id, items.some((i) => i.project.id === c.project.id && OPEN.has(i.row.decision)) ? await mergePreviews(ctx, c.project) : new Map())
  }
  const out = []
  for (const c of items) {
    const snap = toPrDeliverySnapshot(c.row)
    const loaded: Loaded = { project: c.project, db: c.db, row: c.row, snap, ref: formatRef('delivery', c.row.id, c.project.slug), repositoryId: null }
    const terminal = rank(c.row) === 2
    const state = await stateOf(ctx, loaded, { previews: previews.get(c.project.id), ...(terminal ? { accept: null } : {}) })
    out.push({
      ref: loaded.ref,
      title: titleOf(c.row),
      specs: specRefs(c.project, snap),
      decision: c.row.decision,
      status: state.status,
      label: state.label,
      needsYou: OPEN.has(c.row.decision) && state.offers.length > 0,
      ...(state.recommended ? { recommended: state.recommended } : {}),
      offers: state.offers.map((offer) => offer.id),
      ...(snap.prUrl ? { prUrl: snap.prUrl } : {}),
      ...(snap.riskSummary ? { risks: { high: snap.riskSummary.highCount, medium: snap.riskSummary.mediumCount } } : {}),
      updatedAt: c.row.updated_at,
      version: state.version,
    })
  }
  return result({ items: out }, {
    summary: candidates.length ? ctx.v2.t('deliveries.summary.list', { count: candidates.length, pending }) : ctx.v2.t('deliveries.summary.list_empty'),
    page, pageBase: base,
    untrusted: untrusted('/data/items/*/title'),
  })
}

// ── get ─────────────────────────────────────────────────────────────────────

interface PacketResponse { packet?: Record<string, any>; acceptCapability?: { target?: AcceptTarget } }

async function readPacket(ctx: V2CallContext, l: Loaded): Promise<PacketResponse | null> {
  const query = l.repositoryId ? `?repositoryId=${encodeURIComponent(l.repositoryId)}` : ''
  try {
    return await apiCall(ctx, 'GET', `${projectBase(l.project)}/rails/pr-deliveries/${encodeURIComponent(l.row.id)}/packet${query}`) as PacketResponse
  } catch (err) {
    if (err instanceof McpApiError && (err.status === 404 || err.status >= 500)) return null
    throw err
  }
}

/** The decision-ready review block every `get` carries (summary view). */
function reviewSummary(packet: Record<string, any> | null | undefined) {
  if (!packet) return null
  const look = packet.whatToLookAt ?? null
  const proof: Array<Record<string, any>> = Array.isArray(packet.proof) ? packet.proof : []
  const verification = proof.filter((item) => typeof item.code === 'string' && /^proof\.(verification|noVerification|testFiles|noTestFiles|filesChanged)/.test(item.code))
    .map((item) => item.values ? `${item.code.slice(6)} ${Object.values(item.values).join('/')}` : item.code.slice(6))
  return {
    headline: packet.headlineCode,
    variant: packet.variant,
    counts: { succeeded: packet.succeededCount, failed: packet.failedCount, total: packet.totalCount },
    whatChanged: (Array.isArray(packet.sections) ? packet.sections : []).slice(0, 5).map((section: Record<string, any>) => ({
      spec: section.ticketId, text: clip(section.whatChanged ?? section.solution ?? section.title ?? null, 300),
    })),
    verification,
    risks: packet.riskSummary ? { high: packet.riskSummary.highCount, medium: packet.riskSummary.mediumCount, low: packet.riskSummary.lowCount, top: clipDeep(packet.riskSummary.top, 240) } : null,
    humanChecks: (look?.humanChecks?.length ?? 0) + (Array.isArray(packet.needsHumanEyes) ? packet.needsHumanEyes.length : 0),
    reviewNotesNotActedOn: look?.reviewNotes?.length ?? 0,
    watchOut: (Array.isArray(packet.watchOut) ? packet.watchOut : []).map((item: Record<string, any>) => item.code).slice(0, 6),
    confidence: packet.confidence?.overall ?? null,
    costUsd: packet.cost?.totalUsd ?? null,
    versions: Array.isArray(packet.versions) ? packet.versions.length : 1,
  }
}

function packetDetail(project: ProjectRow, packet: Record<string, any>) {
  const look = packet.whatToLookAt ?? {}
  const proofItem = (item: Record<string, any>) => ({ tier: item.tier, code: item.code, ...(item.values ? { values: item.values } : {}), ...(item.rawExcerpt ? { excerpt: clip(item.rawExcerpt, 600) } : {}) })
  return {
    sections: (packet.sections ?? []).slice(0, 10).map((s: Record<string, any>) => ({
      spec: formatRef('spec', s.ticketId, project.slug), title: s.title, problem: clip(s.problem, 800), solution: clip(s.solution, 800),
      whatChanged: clip(s.whatChanged, 1500), whyChanged: clip(s.whyChanged, 800), outcome: s.implementationOutcome, delivery: s.deliveryOutcome,
      ...(s.churn ? { churn: { files: s.churn.filesTouched, added: s.churn.addedLines, removed: s.churn.removedLines } } : {}),
    })),
    verification: (packet.proof ?? []).slice(0, 20).map(proofItem),
    watchOut: (packet.watchOut ?? []).slice(0, 10).map(proofItem),
    risks: clipDeep(look.risks ?? [], 400, 15),
    humanChecks: [...(look.humanChecks ?? []), ...(packet.needsHumanEyes ?? [])].slice(0, 15).map((item: Record<string, any>) => clipDeep(item, 400)),
    reviewNotesNotActedOn: clipDeep(look.reviewNotes ?? [], 400, 15),
    untested: clipDeep(look.untested ?? [], 300, 10),
    behaviourChanges: clipDeep(look.behaviourChanges ?? [], 300, 10),
    invariantsTouched: clipDeep(look.invariantsTouched ?? [], 300, 10),
    divergences: clipDeep(look.divergences ?? [], 300, 10),
    confidence: packet.confidence ? { overall: packet.confidence.overall, aspects: packet.confidence.aspects, flags: clipDeep(packet.confidence.flags, 200, 8) } : null,
    requirements: packet.requirementsDemonstrated ?? null,
    followUpReport: clipDeep(packet.followUpReport, 300, 15),
    addendaReport: clipDeep(packet.specAddendaReport, 300, 15),
    drift: packet.driftNudges ?? [],
    cost: packet.cost,
    versions: (packet.versions ?? []).map((v: Record<string, any>) => ({
      ref: formatRef('delivery', v.prDeliveryId, project.slug), version: v.version, note: clip(v.revisionNote, 300), decision: v.decision, current: v.current,
    })),
  }
}

/** `options.source`: `delivery` (the assembled branch, default) or `ticket:<id>` (one spec's branch). */
const changesPath = (l: Loaded, args: Record<string, unknown>, file?: { path: string; full: boolean }) => {
  const query = new URLSearchParams()
  if (l.repositoryId) query.set('repositoryId', l.repositoryId)
  const source = str(optionsOf(args).source)
  if (source) query.set('source', source)
  if (file) { query.set('path', file.path); if (file.full) query.set('full', '1') }
  const qs = query.toString()
  return `${projectBase(l.project)}/rails/pr-deliveries/${encodeURIComponent(l.row.id)}/changes${file ? '/file' : ''}${qs ? `?${qs}` : ''}`
}

async function readChanges(ctx: V2CallContext, l: Loaded, args: Record<string, unknown>, paged: boolean) {
  const body = await apiCall(ctx, 'GET', changesPath(l, args)) as { changes?: Record<string, any> }
  const changes = body?.changes ?? {}
  if (!changes.available) return { data: { available: false, reason: changes.reason ?? null, annotations: clipDeep(changes.annotations ?? [], 400, 20) }, page: undefined }
  const files: Array<Record<string, any>> = changes.files ?? []
  const key = `changes:${l.row.id}`
  const { items, page } = pageOf(files, { cursor: paged ? args.cursor : undefined, limit: args.limit, key, defaultLimit: FILES_DEFAULT })
  return {
    data: {
      available: true, base: changes.base, head: changes.head, headSha: changes.headSha, totals: changes.totals, truncated: changes.truncated,
      files: items.map((f) => ({ path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, add: f.additions, del: f.deletions, ...(f.binary ? { binary: true } : {}) })),
      annotations: clipDeep((changes.annotations ?? []).map((a: Record<string, any>) => ({ source: a.source, severity: a.severity, text: a.text, at: a.location ? `${a.location.path}${a.location.line ? `:${a.location.line}` : ''}` : null })), 400, 20),
    },
    page: { ...page, cursor: page.cursor ? encodeCursor({ offset: decodeCursor(page.cursor)!.offset, path: '/data/changes/files', key }) : null },
  }
}

interface DiffLine { type: 'context' | 'add' | 'delete'; text: string; oldNo: number | null; newNo: number | null; noNewline?: boolean }
interface DiffHunk { header: string; lines: DiffLine[] }

/**
 * One page of a file diff, by line: hunks are rendered as unified text (`+`,
 * `-`, ` ` prefixes), at most DIFF_PAGE_LINES lines / DIFF_PAGE_CHARS chars.
 * The server caps a diff at 4,000 lines unless asked for `full`; a page past
 * that cap asks for the full diff.
 */
async function readFileDiff(ctx: V2CallContext, l: Loaded, args: Record<string, unknown>) {
  const filePath = str(args.path)
  if (!filePath) throw new V2ToolError('invalid_input', ctx.v2.t('deliveries.error.path_required'))
  const key = `diff:${shortHash({ id: l.row.id, path: filePath, repo: l.repositoryId })}`
  const offset = decodeCursor(args.cursor, key)?.offset ?? 0
  const fetchDiff = async (full: boolean) => (await apiCall(ctx, 'GET', changesPath(l, args, { path: filePath, full })) as { diff?: Record<string, any> }).diff ?? {}
  let diff = await fetchDiff(false)
  const count = (d: Record<string, any>) => (d.hunks ?? []).reduce((sum: number, h: DiffHunk) => sum + h.lines.length, 0)
  if (diff.truncated && offset + DIFF_PAGE_LINES > count(diff)) diff = await fetchDiff(true)
  const hunks: DiffHunk[] = diff.hunks ?? []
  const total = count(diff)
  const out: Array<{ header: string; text: string }> = []
  let index = 0, taken = 0, chars = 0
  for (const hunk of hunks) {
    const lines: string[] = []
    for (const line of hunk.lines) {
      if (index++ < offset) continue
      if (taken >= DIFF_PAGE_LINES || chars >= DIFF_PAGE_CHARS) break
      const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '
      const text = `${prefix}${reveal(clip(line.text, DIFF_LINE_CHARS) ?? '')}${line.noNewline ? ' ⏎̸' : ''}`
      lines.push(text)
      taken++
      chars += text.length + 1
    }
    if (lines.length) out.push({ header: hunk.header, text: lines.join('\n') })
    if (taken >= DIFF_PAGE_LINES || chars >= DIFF_PAGE_CHARS) break
  }
  const end = offset + taken
  const more = end < total || (diff.truncated === true && end >= total && taken > 0)
  return {
    data: {
      path: diff.path ?? filePath, ...(diff.oldPath ? { oldPath: diff.oldPath } : {}), status: diff.status, binary: diff.binary === true,
      lines: { from: total ? offset + 1 : 0, to: end, total: diff.totalLines ?? total }, hunks: out,
    },
    page: { cursor: more ? encodeCursor({ offset: end, path: '/data/file_diff/hunks', key }) : null, total: diff.totalLines ?? total, truncated: more },
  }
}

async function readCi(ctx: V2CallContext, l: Loaded) {
  const available = await ciAvailable(ctx, l.project)
  try {
    const body = await apiCall(ctx, 'GET', `${projectBase(l.project)}/rails/pr-ci-status?deliveryId=${encodeURIComponent(l.row.id)}`) as { prs?: unknown[] }
    return { fixAvailable: available, prs: clipDeep(body?.prs ?? [], 300, 30) }
  } catch (err) {
    return { fixAvailable: available, prs: [], error: err instanceof Error ? clip(err.message, 200) : 'unavailable' }
  }
}

async function getDelivery(ctx: V2CallContext, args: Record<string, unknown>) {
  const l = loadDelivery(ctx, args)
  const fields = new Set<Section>(resolveFields(args, FIELDS))
  if (str(args.path)) fields.add('file_diff')
  const warnings: string[] = []
  const packetResponse = await readPacket(ctx, l)
  const packet = packetResponse?.packet ?? null
  if (!packet) warnings.push(ctx.v2.t('deliveries.warning.packet_unavailable'))
  const accept = packetResponse?.acceptCapability?.target
  if (accept) rememberAccept(l.project.path, accept)
  const previews = OPEN.has(l.row.decision) ? await mergePreviews(ctx, l.project, l.row.id) : new Map<string, MergePreviewRow>()
  const cost = typeof packet?.cost?.totalUsd === 'number' ? { spentUsd: packet.cost.totalUsd, estimated: packet.cost.estimated === true } : undefined
  const state = await stateOf(ctx, l, { previews, ...(accept ? { accept } : {}) }, cost)
  const { snap } = l
  const specs = readSpecSnapshot(l.row.spec_snapshot) ?? []
  const preview = previews.get(l.row.id)
  const data: Record<string, unknown> = {
    ref: l.ref,
    title: titleOf(l.row),
    specs: snap.ticketIds.map((id) => ({ ref: formatRef('spec', id, l.project.slug), title: specs.find((s) => s.ticketId === id)?.title ?? null })),
    decision: snap.decision,
    ...(snap.statusCode ? { statusCode: snap.statusCode } : {}),
    ...(snap.statusDetail ? { statusDetail: clip(snap.statusDetail, 400) } : {}),
    rail: snap.railIndex,
    loop: snap.loopName,
    base: snap.baseBranch,
    ...(snap.branch ? { branch: snap.branch } : {}),
    ...(snap.prUrl ? { prUrl: snap.prUrl, prState: snap.prState } : {}),
    ...(accept ? { accept } : {}),
    ...(l.row.revision_note ? { revisionNote: clip(l.row.revision_note, 400) } : {}),
    ...(l.repositoryId ? { repositoryId: l.repositoryId } : {}),
    ...(snap.executionManifest ? { repositories: (snap.repositoryDeliveries ?? []).map((r) => clipDeep({ id: r.repositoryId, decision: r.decision, prUrl: r.prUrl, branch: r.branch }, 200)) } : {}),
    review: reviewSummary(packet),
    mergePreview: summaryOf(preview),
    updatedAt: snap.updatedAt,
  }
  let page
  if (fields.has('packet') && packet) data.packet = packetDetail(l.project, packet)
  if (fields.has('changes')) {
    const changes = await readChanges(ctx, l, args, !fields.has('file_diff'))
    data.changes = changes.data
    if (changes.page && !fields.has('file_diff')) page = changes.page
  }
  if (fields.has('file_diff')) {
    const diff = await readFileDiff(ctx, l, args)
    data.file_diff = diff.data
    page = diff.page
  }
  if (fields.has('merge_preview')) data.merge_preview = preview ? clipDeep(preview, 200, 30) : null
  if (fields.has('ci')) data.ci = await readCi(ctx, l)
  if (fields.has('local_changes')) data.local_changes = snap.localStash ? clipDeep(snap.localStash, 200, 50) : null
  const recommended = state.offers.find((offer) => offer.id === state.recommended)
  return result(data, {
    summary: [
      ctx.v2.t('deliveries.summary.get', { title: data.title as string, status: state.label }),
      ...(recommended ? [ctx.v2.t('deliveries.summary.recommended', { offer: recommended.label })] : []),
    ].join(' '),
    refs: refsOf(l),
    state,
    ...(page ? { page } : {}),
    ...(warnings.length ? { warnings } : {}),
    untrusted: untrusted('/data/title', '/data/specs', '/data/statusDetail', '/data/revisionNote', '/data/review', '/data/packet',
      '/data/changes/files', '/data/changes/annotations', '/data/file_diff/path', '/data/file_diff/oldPath', '/data/file_diff/hunks', '/data/ci', '/data/local_changes', '/data/merge_preview'),
  })
}

// ── decide ──────────────────────────────────────────────────────────────────

interface DecisionContext { l: Loaded; state: DecisionState; decision: Exclude<DeliveryDecision, 'approve'>; accept: AcceptTarget | null }

/** The current state and the legal decision this call names (`approve` resolved); `held` when it is not legal now. */
async function decisionContext(ctx: V2CallContext, args: Record<string, unknown>): Promise<DecisionContext> {
  const l = loadDelivery(ctx, args)
  const requested = args.decision as DeliveryDecision
  if (!(DELIVERY_DECISIONS as readonly string[]).includes(requested)) {
    throw new V2ToolError('invalid_input', ctx.v2.t('deliveries.error.unknown_decision', { decision: String(requested), decisions: DELIVERY_DECISIONS.join(', ') }))
  }
  if (requested === 'request_changes' && !str(args.note)?.trim()) throw new V2ToolError('invalid_input', ctx.v2.t('deliveries.error.note_required'))
  const accept = await acceptTargetFor(l.project.path)
  const state = await stateOf(ctx, l, { accept })
  const has = (id: string) => state.offers.some((offer) => offer.id === `decide.${id}`)
  let decision: DecisionContext['decision']
  if (requested === 'approve') {
    const preferred = accept === 'create-pr' ? ['create_pr', 'merge_local'] as const : ['merge_local', 'create_pr'] as const
    const recommended = state.recommended?.replace(/^decide\./, '')
    decision = recommended === 'create_pr' || recommended === 'merge_local' ? recommended : preferred.find(has) ?? preferred[0]
  } else decision = requested
  if (!has(decision)) {
    throw new V2ToolError('held', ctx.v2.t('deliveries.error.not_allowed', {
      decision, status: state.label, offers: state.offers.map((offer) => offer.id.replace(/^decide\./, '')).join(', ') || '—',
    }), { state })
  }
  const expected = str(optionsOf(args).version)
  if (expected && expected !== state.version) {
    throw new V2ToolError('stale', ctx.v2.t('deliveries.error.stale_version'), { state, reason: 'stale' })
  }
  return { l, state, decision, accept }
}

async function forecast(ctx: V2CallContext, l: Loaded, decision: DeliveryDecision): Promise<[number, number] | null> {
  const loopId = decision === 'ci_fix' ? PR_CI_LOOP_ID : decision === 'refresh_on_base' ? null : l.row.loop_id
  if (!loopId) return null
  try {
    const body = await apiCall(ctx, 'GET', `${projectBase(l.project)}/launch-forecast?loopId=${encodeURIComponent(loopId)}`) as { cost?: { lowUsd?: number; highUsd?: number } | null }
    return typeof body?.cost?.lowUsd === 'number' && typeof body.cost.highUsd === 'number' ? [body.cost.lowUsd, body.cost.highUsd] : null
  } catch { return null }
}

/** A delivery as a menu: its legal decisions (recommended first); the person's own words ask for changes. */
async function decidePoint(ctx: V2CallContext, args: Record<string, unknown>): Promise<ChoicePoint | null> {
  const l = loadDelivery(ctx, args)
  const state = await stateOf(ctx, l)
  const changes = state.offers.find((offer) => offer.call.args.decision === 'request_changes')
  const choices = choicesFromState(state, (offer) => offer.call.tool === 'specrails_deliveries' && offer.call.args.action === 'decide' && offer !== changes)
  return {
    question: oneLine(`${titleOf(l.row)} — ${state.hold?.reason ?? state.label}`, 300), choices,
    ...(changes ? { other: { call: changes.call, field: 'note', title: ctx.v2.t('core.choose.other_changes') } } : {}),
  }
}

async function decidePreview(ctx: V2CallContext, args: Record<string, unknown>): Promise<PreviewInput> {
  const { l, state, decision } = await decisionContext(ctx, args)
  const params = { title: titleOf(l.row), base: l.snap.baseBranch, branch: l.snap.branch ?? l.snap.units[0]?.branch ?? '—', pr: l.snap.prUrl ?? '—' }
  const effect = [
    ...(args.decision === 'approve' ? [ctx.v2.t('deliveries.effect.approve', { resolved: ctx.v2.t(DECISION_LABEL_KEY(decision)) })] : []),
    ctx.v2.t(`deliveries.effect.${decision}`, params),
  ].join(' ')
  const confirm = DECISION_POLICY[decision].confirm
  return {
    effect, refs: [l.ref], version: state.version,
    ...(confirm === 'costly' || policyOf(args).confirm === 'costly' ? { cost: { forecastUsd: await forecast(ctx, l, decision), runs: 1 } } : {}),
  }
}

const OUTCOME_KEYS = ['ok', 'decision', 'prUrl', 'prState', 'merged', 'detail', 'branch', 'prDeliveryId', 'loopRunIds', 'loopRunId', 'runId', 'mergeSha', 'conflicts', 'localChanges', 'warnings', 'cleanupWarnings', 'reason']

function outcomeOf(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {}
  const record = body as Record<string, unknown>
  return clipDeep(Object.fromEntries(OUTCOME_KEYS.filter((key) => record[key] !== undefined && record[key] !== null).map((key) => [key, record[key]])), 400, 20) as Record<string, unknown>
}

async function execute(ctx: V2CallContext, dc: DecisionContext, args: Record<string, unknown>): Promise<unknown> {
  const { l, decision } = dc
  const rails = `${projectBase(l.project)}/rails`
  const timeoutMs = LONG.has(decision) ? 600_000 : 120_000
  const origin = ctx.originConversationId ? { originConversationId: ctx.originConversationId } : {}
  const repository = l.repositoryId ? { repositoryId: l.repositoryId } : {}
  const prAction = PR_DECISION[decision]
  if (prAction) {
    return apiCall(ctx, 'POST', `${rails}/pr-decision`, { prDeliveryId: l.row.id, action: prAction, expectedDecision: l.row.decision, ...repository }, { timeoutMs })
  }
  const local = LOCAL_CHANGES[decision]
  if (local) return apiCall(ctx, 'POST', `${rails}/pr-local-changes/${local}`, { prDeliveryId: l.row.id }, { timeoutMs })
  switch (decision) {
    case 'checkout':
      return apiCall(ctx, 'POST', `${rails}/pr-checkout`, { prDeliveryId: l.row.id, ...repository }, { timeoutMs })
    case 'request_changes':
      return apiCall(ctx, 'POST', `${rails}/${l.row.rail_index}/launch`, {
        revisionOfDeliveryId: l.row.id, revisionNote: str(args.note)!.trim(),
        ...(l.snap.executionManifest ? { repositoryIds: l.snap.executionManifest.selectedRepositoryIds } : {}), ...origin,
      }, { timeoutMs })
    case 'ci_fix':
      return apiCall(ctx, 'POST', `${rails}/${l.row.rail_index}/pr-ci`, { prDeliveryId: l.row.id, ...origin }, { timeoutMs })
    case 'refresh_on_base':
      return apiCall(ctx, 'POST', `${projectBase(l.project)}/pr-deliveries/${encodeURIComponent(l.row.id)}/refresh-on-base`, {}, { timeoutMs })
    default:
      throw new V2ToolError('invalid_input', ctx.v2.t('deliveries.error.unknown_decision', { decision, decisions: DELIVERY_DECISIONS.join(', ') }))
  }
}

async function decide(ctx: V2CallContext, args: Record<string, unknown>) {
  const dc = await decisionContext(ctx, args)
  let body: unknown
  try {
    body = await execute(ctx, dc, args)
  } catch (err) {
    if (err instanceof McpApiError && err.code === 'stale_decision') {
      const fresh = loadDelivery(ctx, args)
      throw new V2ToolError('stale', ctx.v2.t('deliveries.error.stale_decision'), { state: await stateOf(ctx, fresh), reason: 'stale' })
    }
    throw err
  }
  const outcome = outcomeOf(body)
  const fresh = loadDelivery(ctx, { ...args, ref: dc.l.ref })
  const state = await stateOf(ctx, fresh)
  const refs = refsOf(fresh)
  const next = typeof outcome.prDeliveryId === 'string' && outcome.prDeliveryId !== fresh.row.id ? formatRef('delivery', outcome.prDeliveryId, fresh.project.slug) : null
  if (next) refs.next = next
  for (const runId of [...(Array.isArray(outcome.loopRunIds) ? outcome.loopRunIds : []), outcome.loopRunId, outcome.runId]) {
    if (typeof runId === 'string') refs[`run.${runId}`] = formatRef('run', runId, fresh.project.slug)
  }
  return result({ ref: fresh.ref, decision: dc.decision, outcome, ...(next ? { next } : {}) }, {
    summary: ctx.v2.t('deliveries.summary.decided', { decision: ctx.v2.t(DECISION_LABEL_KEY(dc.decision)), title: titleOf(fresh.row), status: state.label }),
    refs, state,
    untrusted: untrusted('/data/outcome'),
  })
}

/** WP4. Deliveries (PR decisions, local integration, CI). */
export const deliveriesTool = defineTool({
  name: 'specrails_deliveries',
  title: 'Deliveries',
  description: 'Deliveries waiting for a decision first: review packet, changes, diffs, merge preview, CI; decide create_pr, merge_local, request_changes and more.',
  owner: 'WP4',
  alwaysLoad: true,
  fields: {
    ...WRITE_FIELDS,
    fields: F.fields(FIELDS),
    decision: z.enum(DELIVERY_DECISIONS),
    note: z.string().describe('request_changes: what to change'),
    path: z.string().describe('file_diff: file'),
    filter: F.filter.describe('list: decision[], spec, since, pending'),
  },
  actions: {
    list: { tier: 'read', doc: 'Deliveries, waiting for you first. filter: decision[] (decision or status), spec, since (ISO), pending.', handler: listDeliveries },
    get: {
      tier: 'read', required: ['ref'], handler: getDelivery,
      doc: 'Review packet summary + state. detail fields: packet, changes (paged files), file_diff (path; paged lines), merge_preview, ci, local_changes. options.repositoryId for one repository.',
    },
    decide: {
      tier: (args) => policyOf(args).tier, confirm: (args) => policyOf(args).confirm, required: ['ref', 'decision'],
      doc: 'Run a legal decision (state.offers). approve = the repository\'s Accept (create_pr or merge_local). request_changes needs note. No decision: the person picks. options.version guards against a changed delivery.',
      choose: { fields: ['decision'], point: decidePoint },
      preview: decidePreview, handler: decide,
    },
  },
})
