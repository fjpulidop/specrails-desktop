// Client model of the server-derived milestone progress (premium-milestone-
// progress). Mirrors `server/milestone-progress.ts`: every count is a fact from
// a durable row; the derived `state` is what surfaces render. Pure helpers only
// — no fetching, no React.

export type MilestoneState = 'planned' | 'committed' | 'running' | 'delivered' | 'done'

export interface MilestoneCounts {
  total: number
  done: number
  onReview: number
  inProgress: number
  todo: number
  /** Specs currently pending whose newest delivery unit failed. */
  failed: number
}

/** The delivery fields the milestone surfaces use (a subset of the server snapshot). */
export interface MilestoneDelivery {
  id: string
  railIndex: number
  ticketIds: number[]
  decision: string
  branch: string | null
  baseBranch: string
  prUrl: string | null
  prNumber: number | null
  prState: string
  createdAt: string | null
}

export interface MilestoneRail {
  railIndex: number
  name: string | null
  ticketIds: number[]
  active: boolean
  runId: string | null
  startedAt: string | null
  delivery: MilestoneDelivery | null
  chunkIndex: number | null
}

/** `awaiting_approval` = a wave checkpoint: the last rail delivered fine and
 *  the chain waits for the user's go (auto-advance off). */
export type MilestoneChainStatus = 'running' | 'waiting' | 'paused' | 'awaiting_approval' | 'completed' | 'cancelled'

export interface MilestoneChainLaunched {
  chunk: number
  railIndex: number
  ticketIds: number[]
  runIds: string[]
  deliveryId: string | null
}

export interface MilestoneChainSnapshot {
  id: string
  milestoneN: number
  mode: 'sequential' | 'parallel'
  status: MilestoneChainStatus
  pauseReason: string | null
  /** false ⇒ every successful rail parks the chain at a checkpoint. */
  autoAdvance: boolean
  nextChunk: number
  totalChunks: number
  currentRailIndex: number | null
  headBranch: string | null
  launched: MilestoneChainLaunched[]
  updatedAt: string
}

export interface MilestoneProgress {
  id: string
  n: number
  title: string
  storedStatus: 'planned' | 'committed' | 'done'
  state: MilestoneState
  counts: MilestoneCounts
  rails: MilestoneRail[]
  chain: MilestoneChainSnapshot | null
}

export function milestoneLabelFor(n: number): string {
  return `M${n}`
}

// ─── Defensive parsing (REST + WS payloads) ──────────────────────────────────

const STATES: ReadonlySet<string> = new Set(['planned', 'committed', 'running', 'delivered', 'done'])
const CHAIN_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting', 'paused', 'awaiting_approval', 'completed', 'cancelled'])

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [])
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function coerceCounts(raw: unknown): MilestoneCounts {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    total: num(o.total), done: num(o.done), onReview: num(o.onReview),
    inProgress: num(o.inProgress), todo: num(o.todo), failed: num(o.failed),
  }
}

function coerceDelivery(raw: unknown): MilestoneDelivery | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = str(o.id)
  if (!id) return null
  return {
    id,
    railIndex: num(o.railIndex, -1),
    ticketIds: nums(o.ticketIds),
    decision: str(o.decision) ?? 'building',
    branch: str(o.branch),
    baseBranch: str(o.baseBranch) ?? '',
    prUrl: str(o.prUrl),
    prNumber: typeof o.prNumber === 'number' ? o.prNumber : null,
    prState: str(o.prState) ?? 'none',
    createdAt: str(o.createdAt),
  }
}

function coerceRail(raw: unknown): MilestoneRail | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.railIndex !== 'number') return null
  return {
    railIndex: o.railIndex,
    name: str(o.name),
    ticketIds: nums(o.ticketIds),
    active: o.active === true,
    runId: str(o.runId),
    startedAt: str(o.startedAt),
    delivery: coerceDelivery(o.delivery),
    chunkIndex: typeof o.chunkIndex === 'number' ? o.chunkIndex : null,
  }
}

export function coerceChain(raw: unknown): MilestoneChainSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = str(o.id)
  const status = str(o.status)
  if (!id || !status || !CHAIN_STATUSES.has(status)) return null
  const launched = Array.isArray(o.launched)
    ? o.launched.flatMap((l): MilestoneChainLaunched[] => {
        if (!l || typeof l !== 'object') return []
        const e = l as Record<string, unknown>
        if (typeof e.chunk !== 'number' || typeof e.railIndex !== 'number') return []
        return [{ chunk: e.chunk, railIndex: e.railIndex, ticketIds: nums(e.ticketIds), runIds: strs(e.runIds), deliveryId: str(e.deliveryId) }]
      })
    : []
  return {
    id,
    milestoneN: num(o.milestoneN, 0),
    mode: o.mode === 'parallel' ? 'parallel' : 'sequential',
    status: status as MilestoneChainStatus,
    pauseReason: str(o.pauseReason),
    autoAdvance: o.autoAdvance !== false,
    nextChunk: num(o.nextChunk),
    totalChunks: num(o.totalChunks),
    currentRailIndex: typeof o.currentRailIndex === 'number' ? o.currentRailIndex : null,
    headBranch: str(o.headBranch),
    launched,
    updatedAt: str(o.updatedAt) ?? '',
  }
}

export function coerceMilestoneProgress(raw: unknown): MilestoneProgress[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): MilestoneProgress[] => {
    if (!item || typeof item !== 'object') return []
    const o = item as Record<string, unknown>
    const id = str(o.id)
    if (!id || typeof o.n !== 'number') return []
    const state = str(o.state)
    const stored = str(o.storedStatus)
    return [{
      id,
      n: o.n,
      title: str(o.title) ?? '',
      storedStatus: stored === 'done' || stored === 'committed' ? stored : 'planned',
      state: state && STATES.has(state) ? (state as MilestoneState) : 'planned',
      counts: coerceCounts(o.counts),
      rails: Array.isArray(o.rails) ? o.rails.flatMap((r) => { const rail = coerceRail(r); return rail ? [rail] : [] }) : [],
      chain: coerceChain(o.chain),
    }]
  })
}

// ─── Derivations for the surfaces ────────────────────────────────────────────

export type SegmentKey = 'done' | 'onReview' | 'inProgress' | 'failed' | 'todo'

export interface ProgressSegment {
  key: SegmentKey
  count: number
  /** Share of the bar, 0–100. */
  pct: number
}

/** Segmented-bar model: done / in review / in progress / failed / pending.
 *  `failed` specs are a subset of `todo` and are carved out of it. */
export function progressSegments(counts: MilestoneCounts): ProgressSegment[] {
  const total = Math.max(0, counts.total)
  if (total === 0) return []
  const failed = Math.min(counts.failed, counts.todo)
  const raw: Array<[SegmentKey, number]> = [
    ['done', counts.done],
    ['onReview', counts.onReview],
    ['inProgress', counts.inProgress],
    ['failed', failed],
    ['todo', Math.max(0, counts.todo - failed)],
  ]
  return raw
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, count, pct: Math.round((count / total) * 1000) / 10 }))
}

/** Specs that left the backlog through a run and are either merged or awaiting review. */
export function deliveredCount(counts: MilestoneCounts): number {
  return counts.done + counts.onReview
}

export function chainIsLive(chain: MilestoneChainSnapshot | null): boolean {
  return chain !== null && (chain.status === 'running' || chain.status === 'waiting')
}

/** The chain sits at a wave checkpoint: healthy, waiting for "Launch next rail". */
export function chainAtCheckpoint(chain: MilestoneChainSnapshot | null): boolean {
  return chain !== null && chain.status === 'awaiting_approval'
}

/** A milestone can be (re)launched when specs are pending and no chain is driving it. */
export function isMilestoneLaunchable(p: MilestoneProgress): boolean {
  return p.counts.todo > 0 && !chainIsLive(p.chain) && p.chain?.status !== 'paused' && !chainAtCheckpoint(p.chain)
}

/** Delivery ids that a LATER chunk of a sequential chain was stacked on —
 *  discarding one of these pauses its chain (the decision surfaces warn). */
export function stackedHeadDeliveryIds(progress: MilestoneProgress[]): Set<string> {
  const out = new Set<string>()
  for (const m of progress) {
    const chain = m.chain
    if (!chain || chain.mode !== 'sequential') continue
    const ordered = [...chain.launched].sort((a, b) => a.chunk - b.chunk)
    for (let i = 0; i < ordered.length - 1; i++) {
      const id = ordered[i].deliveryId
      if (id) out.add(id)
    }
  }
  return out
}

/** Split `launch_rejected:<error>` style reasons into an i18n key + detail. */
export function chainPauseReason(reason: string | null): { key: string; detail: string } {
  if (!reason) return { key: 'unknown', detail: '' }
  const idx = reason.indexOf(':')
  if (idx < 0) return { key: reason, detail: '' }
  return { key: reason.slice(0, idx), detail: reason.slice(idx + 1) }
}

/** The delivery a "Review" action should open for a milestone: the newest
 *  reviewable one (on_review first, then draft/ready), null when none. */
export const REVIEWABLE_DECISIONS: ReadonlySet<string> = new Set(['on_review', 'no_changes', 'pr_draft', 'pr_ready', 'pr_failed', 'implementation_failed', 'pr_closed'])

export function reviewableDelivery(p: MilestoneProgress): MilestoneDelivery | null {
  const candidates = p.rails.map((r) => r.delivery).filter((d): d is MilestoneDelivery => d !== null && REVIEWABLE_DECISIONS.has(d.decision))
  if (candidates.length === 0) return null
  const onReview = candidates.find((d) => d.decision === 'on_review')
  return onReview ?? candidates[0]
}
