import i18n from '../../../lib/i18n'

/** Surfaces recorded in the project `ai_invocations` ledger. */
export type RecordedSurface =
  | 'job'
  | 'quick-spec'
  | 'explore-spec'
  | 'ai-edit'
  | 'smash'
  | 'file-summary'
  | 'loop'
  | 'chat-sidebar'
  | 'spec-launcher'
  | 'proposal'
  | 'agent-studio'
  | 'setup'
  /** Intent mode turns (app ledger; real provider-billed cost only). */
  | 'flow'
  | 'triage'
  /** The AI reading of why a failed job stopped. */
  | 'failure-analysis'
/**
 * Every surface the spending API reports: the recorded ones plus the read-only
 * virtual surfaces derived from the app-level agent ledger — 'mission' (Agent
 * Chat / Mission turns) and 'intent' (Intent-mode turns). Recorded 'flow' is the
 * Intent spec rewrite.
 */
export type Surface = RecordedSurface | 'mission' | 'intent'
export type SurfaceFilter = Surface | 'all'

/** The "why" behind spend. Mirrors server/modules/accounting/runtime/spend-categories.ts. */
export type SpendCategory = 'implementation' | 'missions' | 'specs' | 'code' | 'support'
/** Canonical display order. */
export const SPEND_CATEGORIES: readonly SpendCategory[] = ['implementation', 'missions', 'specs', 'code', 'support']
const CATEGORY_SURFACES: Readonly<Record<SpendCategory, readonly Surface[]>> = {
  implementation: ['job', 'loop'],
  missions: ['mission', 'intent', 'flow'],
  specs: ['quick-spec', 'explore-spec', 'ai-edit', 'smash', 'spec-launcher', 'proposal', 'triage'],
  code: ['file-summary'],
  support: ['failure-analysis', 'setup', 'agent-studio', 'chat-sidebar'],
}
/** Category of a surface; an unknown (newer) surface lands in 'support', like the server. */
export function categoryForSurface(surface: string): SpendCategory {
  for (const category of SPEND_CATEGORIES) {
    if ((CATEGORY_SURFACES[category] as readonly string[]).includes(surface)) return category
  }
  return 'support'
}
export function surfacesForCategory(category: SpendCategory): readonly Surface[] {
  return CATEGORY_SURFACES[category]
}
export function isSpendCategory(value: unknown): value is SpendCategory {
  return typeof value === 'string' && (SPEND_CATEGORIES as readonly string[]).includes(value)
}

export interface CategorySurfaceEntry {
  surface: Surface
  costUsd: number
  count: number
  tokens: number
}
export interface CategoryBreakdownEntry {
  category: SpendCategory
  costUsd: number
  /** Portion of costUsd from pricing-table estimates. */
  estimatedCostUsd: number
  count: number
  tokens: number
  unpricedCount: number
  /** Surfaces with at least one invocation, costliest first. */
  surfaces: CategorySurfaceEntry[]
}
export type Period = '7d' | '30d' | '90d' | 'all' | 'custom'

export interface SpendingFilters {
  period: Period
  from?: string
  to?: string
  surface?: Surface[]
  /** Spend categories to include (wire: `category` CSV). */
  category?: SpendCategory[]
  model?: string[]
  status?: 'success' | 'failed' | 'aborted'
  minCostUsd?: number
  ticketId?: number
  /** Provider ids to include (multi-provider segmentation). Empty/undefined = all. */
  provider?: string[]
  /**
   * Provider-aligned model filter. When set, the model predicate is scoped to
   * `(provider, model)` pairs instead of a bare `model IN (...)`. Wire format:
   * `modelProvider` CSV index-aligned with `model` CSV (lengths must match or it
   * is ignored). `provider` here is the COALESCE'd value (legacy NULL → 'claude').
   * Single-provider claude projects never populate this (byte-identical).
   */
  modelKeys?: Array<{ provider: string; model: string }>
  /**
   * Minutes to add to UTC `started_at` before day-bucketing `dailyTimeline`
   * (positive = east of UTC). Client passes its local offset so "today" lines
   * up. Default 0 = legacy UTC bucketing. Clamped to ±840 server-side.
   */
  tzOffsetMinutes?: number
  /**
   * Row ordering for the raw invocations table. 'recency' (default,
   * `started_at DESC`) or 'cost' (`total_cost_usd DESC` NULLs last) so the
   * costliest rows surface on page 1.
   */
  sortBy?: 'recency' | 'cost'
}

export interface BySurfaceCount {
  surface: Surface
  count: number
  costUsd: number
  unpricedCount?: number
}
export interface ByModelEntry {
  model: string
  /**
   * Provider that produced this model's rows (COALESCE'd, legacy NULL →
   * 'claude'). `byModel` is keyed on (provider, model) so codex/gemini estimated
   * spend never merges into a claude bar of the same id. Client must pass
   * `provider` alongside `model` on click-to-filter (via `modelProvider`).
   */
  provider: string
  count: number
  /** Total cost (authoritative + estimated). */
  costUsd: number
  /**
   * Portion of `costUsd` from rows flagged `total_cost_usd_estimated=1`
   * (codex/gemini pricing-table fallback). Client renders a `~` when > 0.
   * 0 for a pure-claude model.
   */
  estimatedCostUsd: number
  /** Invocations for which cost telemetry was unavailable. */
  unpricedCount?: number
}
export interface DailyEntry {
  date: string
  jobsCostUsd: number
  quickCostUsd: number
  exploreCostUsd: number
  aiEditCostUsd: number
  smashCostUsd: number
  fileSummaryCostUsd: number
  loopCostUsd: number
  /** Mission + Intent turns (agent ledger); absent on older servers. */
  missionCostUsd?: number
  totalCostUsd: number
  /** The day's cost per spend category; absent on older servers. */
  byCategory?: Record<SpendCategory, number>
  unpricedCount?: number
}
export interface ScatterPoint {
  id: string
  surface: Surface
  costUsd: number
  numTurns: number | null
  durationMs: number | null
  ticketId: number | null
  startedAt: string
}
export interface TopTicketEntry {
  ticketId: number | null
  ticketTitle: string | null
  totalCostUsd: number
  totalRuns: number
  unpricedCount?: number
  bySurface: Record<Surface, { count: number; costUsd: number; unpricedCount?: number }>
  isUnattributed?: boolean
  isDeleted?: boolean
}
export interface ByModeEntry {
  mode: 'quick' | 'explore'
  totalRuns: number
  ticketsCreated: number
  totalCostUsd: number
  /**
   * Portion of `totalCostUsd` from estimated rows (codex/gemini). Lets
   * QuickVsExploreCard render a `~` on the per-spec figure when > 0.
   * 0 for a pure-claude mode.
   */
  estimatedCostUsd: number
  /** Runs excluded from cost averages because their cost is unavailable. */
  unpricedCount?: number
  avgCostPerSpec: number | null
  avgDurationMs: number | null
  dominantModel: string | null
  sparkline: number[]
}

export interface ByProviderEntry {
  provider: string
  count: number
  /** Authoritative (provider-reported) cost. */
  costUsd: number
  /** Cost computed via the server-side pricing-table fallback (codex today). */
  estimatedCostUsd: number
  pricedCount?: number
  unpricedCount?: number
  usageReportedCount?: number
  usageUnavailableCount?: number
}

export interface SpendingResponse {
  summary: {
    totalCostUsd: number
    /** Portion of `totalCostUsd` contributed by rows where the server
     *  fell back to `server/modules/accounting/runtime/pricing.ts` (codex, today). Drives the
     *  "Includes estimated costs" Hero footnote. */
    totalEstimatedCostUsd: number
    /** Real total tokens across matching rows = fresh input + output +
     *  cache-read + cache-create (cache tiers dominate agentic Claude runs). */
    totalTokens: number | null
    totalRuns: number
    /** Optional for compatibility with servers predating coverage reporting. */
    pricedRuns?: number
    unpricedRuns?: number
    usageReportedRuns?: number
    usageUnavailableRuns?: number
    prevUnpricedRuns?: number
    failureRate: number
    prevTotalCostUsd: number
    deltaPct: number | null
    avgCostPerRun: number | null
  }
  bySurface: BySurfaceCount[]
  /** Spend per category, costliest first; absent on older servers. */
  byCategory?: CategoryBreakdownEntry[]
  byModel: ByModelEntry[]
  byMode: ByModeEntry[]
  byProvider: ByProviderEntry[]
  dailyTimeline: DailyEntry[]
  scatter: ScatterPoint[]
  /**
   * Total count of priced rows (`total_cost_usd IS NOT NULL`) in the window.
   * When `scatterTruncated`, this exceeds `scatter.length` so CostScatter can
   * show a "showing N of M — costliest may be hidden" notice. When truncated,
   * the single costliest priced row is always UNION-ed into `scatter[]` so the
   * budget-blowing outlier is never invisible (`scatter[]` may then be 501 long).
   */
  scatterTotal: number
  /** True when `scatterTotal` exceeds the 500-capped `scatter.length`. */
  scatterTruncated: boolean
  topTickets: TopTicketEntry[]
  trackingStartedAt: string | null
  rangeFrom: string
  rangeTo: string
  /** Agent ledger (mission + Intent turns pinned to this project): summary and
   *  top conversations. Already counted in the totals above. */
  agentMissions?: AgentMissionSpending
}

export interface AgentMissionConversationRow {
  conversationId: string | null
  title: string | null
  costUsd: number
  estimatedCostUsd: number
  turns: number
  lastAt: string | null
}

export interface AgentMissionSpending {
  summary: {
    totalCostUsd: number
    estimatedCostUsd: number
    prevTotalCostUsd: number
    turns: number
    tokensIn: number
    tokensOut: number
    /** Part of totalCostUsd spent by Intent turns (surface 'flow'); absent on older servers. */
    flowCostUsd?: number
    flowTurns?: number
  }
  topConversations: AgentMissionConversationRow[]
}

export interface InvocationRow {
  id: string
  project_id: string
  surface: Surface
  surface_ref_id: string | null
  ticket_id: number | null
  conversation_id: string | null
  model: string | null
  status: 'success' | 'failed' | 'aborted'
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  duration_api_ms: number | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_cache_read: number | null
  tokens_cache_create: number | null
  total_cost_usd: number | null
  /** 1 when cost came from the local pricing-table fallback (codex);
   *  0 when it was the provider's authoritative `total_cost_usd`. */
  total_cost_usd_estimated?: 0 | 1
  /** Provider id from the resolved adapter (`claude`, `codex`, ...).
   *  Optional only for backwards-compat with pre-migration rows. */
  provider?: string | null
  num_turns: number | null
  session_id: string | null
  created_at: string
  /** For an agent-ledger row: the conversation title (else a ticket or provisional title). */
  ticket_title: string | null
  /** 'agent' for a mission / Intent turn from the app ledger; `conversation_id` is its conversation. */
  ledger?: 'agent'
}

export interface InvocationsResponse {
  rows: InvocationRow[]
  total: number
  truncated: boolean
  totalAvailable: number
}

export interface TicketSpendingSummary {
  totalCostUsd: number
  /**
   * Portion of `totalCostUsd` from rows with `total_cost_usd_estimated=1`
   * (codex/gemini). TicketSpendingLine / modal render a `~` when > 0.
   * 0 for a ticket implemented entirely via claude.
   */
  estimatedCostUsd: number
  totalTokens?: number | null
  totalTurns: number | null
  pricedRuns?: number
  unpricedRuns?: number
  usageReportedRuns?: number
  usageUnavailableRuns?: number
  turnsReportedRuns?: number
  turnsUnavailableRuns?: number
  activeDurationMs: number
  bySurface: Record<RecordedSurface, { count: number; costUsd: number; unpricedCount?: number }>
  totalRuns: number
}

const SURFACE_LABEL_KEYS: Record<Surface, string> = {
  job: 'analytics:surfaces.job',
  'quick-spec': 'analytics:surfaces.quickSpec',
  'explore-spec': 'analytics:surfaces.exploreSpec',
  'ai-edit': 'analytics:surfaces.aiEdit',
  smash: 'analytics:surfaces.smash',
  'file-summary': 'analytics:surfaces.fileSummary',
  loop: 'analytics:surfaces.loop',
  'chat-sidebar': 'analytics:surfaces.chatSidebar',
  'spec-launcher': 'analytics:surfaces.specLauncher',
  proposal: 'analytics:surfaces.proposal',
  'agent-studio': 'analytics:surfaces.agentStudio',
  setup: 'analytics:surfaces.setup',
  flow: 'analytics:surfaces.flow',
  triage: 'analytics:surfaces.triage',
  'failure-analysis': 'analytics:surfaces.failureAnalysis',
  mission: 'analytics:surfaces.mission',
  intent: 'analytics:surfaces.intent',
}

export interface SurfaceAccent {
  bg: string
  text: string
  ring: string
  dot: string
}

/** Neutral fallback accent for any surface id the client does not know about
 *  (a server surface added after this build shipped). Muted, no brand tokens —
 *  the dashboard renders the row instead of crashing on an undefined lookup. */
export const NEUTRAL_SURFACE_ACCENT: SurfaceAccent = {
  bg: 'bg-muted/40',
  text: 'text-muted-foreground',
  ring: 'ring-border/40',
  dot: 'bg-muted-foreground',
}

/**
 * A surface chip is neutral: colour belongs to its spend category (the chart
 * palette, see `lib/category-colors`), never to a lamp token, so a surface can
 * never read as running, failed or caution. One accent object per category.
 */
const CATEGORY_ACCENT: Record<SpendCategory, SurfaceAccent> = Object.fromEntries(
  SPEND_CATEGORIES.map((category) => [category, { bg: 'bg-muted', text: 'text-foreground', ring: 'ring-border', dot: 'bg-foreground' }]),
) as Record<SpendCategory, SurfaceAccent>

const SURFACE_ACCENT_MAP: Record<Surface, SurfaceAccent> = Object.fromEntries(
  (Object.keys(SURFACE_LABEL_KEYS) as Surface[]).map((surface) => [surface, CATEGORY_ACCENT[categoryForSurface(surface)]]),
) as Record<Surface, SurfaceAccent>

/**
 * Wrap an exhaustive surface map so an UNKNOWN surface id (a future server
 * surface not in this build's `Surface` union) resolves to a neutral fallback
 * instead of `undefined` — a bare `SURFACE_ACCENT[unknown].dot` would otherwise
 * throw and take down the whole analytics dashboard. Object.keys / iteration
 * still report only the known surfaces (default `ownKeys` trap).
 */
function tolerantSurfaceMap<T>(target: Record<Surface, T>, fallback: (id: string) => T): Record<Surface, T> {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'string' && !(prop in obj)) return fallback(prop)
      return Reflect.get(obj, prop, receiver)
    },
  })
}

/** Live-translated surface labels. Property getters resolve through i18next at
 *  access time, so consumers that re-render on language change (anything
 *  calling `useTranslation`) always read the active language — no signature
 *  change required for existing `SURFACE_LABEL[s]` call sites. Unknown surface
 *  ids fall back to their raw id (see `tolerantSurfaceMap`). */
export const SURFACE_LABEL: Record<Surface, string> = tolerantSurfaceMap(
  Object.defineProperties(
    {} as Record<Surface, string>,
    Object.fromEntries(
      (Object.keys(SURFACE_LABEL_KEYS) as Surface[]).map((s) => [
        s,
        { get: () => i18n.t(SURFACE_LABEL_KEYS[s]), enumerable: true },
      ])
    ) as PropertyDescriptorMap
  ),
  (id) => id,
)

/** Surface → semantic accent token (Tailwind class name) used across the
 *  dashboard. Unknown surface ids fall back to `NEUTRAL_SURFACE_ACCENT`. */
export const SURFACE_ACCENT: Record<Surface, SurfaceAccent> = tolerantSurfaceMap(
  SURFACE_ACCENT_MAP,
  () => NEUTRAL_SURFACE_ACCENT,
)

/** Explicit tolerant accessors (equivalent to indexing the maps above, but
 *  convenient for callers that hold a raw `string` surface). */
export function surfaceLabel(surface: string): string {
  return SURFACE_LABEL[surface as Surface]
}
export function surfaceAccent(surface: string): SurfaceAccent {
  return SURFACE_ACCENT[surface as Surface]
}
