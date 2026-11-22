import type { McpTier } from '../../mcp-tiers'
import type { RunHoldKind } from '../../../modules/loops/runtime/loop-run-hold'
import { shortHash } from './canonical'
import type { Params, Translate } from './lang'
import { appState, type AppRunState, type CanonicalStatus } from './status-map'

/**
 * Decision-ready state: every entity answers what it is, why it waits, what
 * it can do now and which option the server recommends. One shape for runs,
 * deliveries, chains, specs and missions (docs/internals/mcp-v2.md §State).
 *
 * The server owns legality: offers come only from domain rules (see
 * decision-sources.ts); MCP adds no policy. `buildDecisionState` localizes the
 * labels, fills tier/confirmation facts from the v2 catalog and computes the
 * `version` every confirmToken binds to.
 */

/** Why an entity waits. Run kinds come from loop-run-hold.ts; `chain` carries the chain's pause reason in `code`. */
export type HoldKind = RunHoldKind | 'chain' | 'pr_decision' | 'budget' | 'quota' | 'capacity'

/** How a confirmable action is classified (§6 of the design). Null: no confirmation. */
/**
 * - irreversible: always confirm; it cannot be undone.
 * - risky: always confirm; reversible, but it lowers a safeguard or touches a lot at once until undone.
 * - external: always confirm; it changes a system outside Specrails.
 * - costly: confirm above the spend threshold, for several runs, or when the forecast is unknown.
 */
export type ConfirmClass = 'irreversible' | 'risky' | 'external' | 'costly'

export interface Hold {
  kind: HoldKind
  /** Finer machine reason (a chain pause reason, a backend code). */
  code?: string
  /** Localized sentence. */
  reason: string
  since: string | null
  /** What a queued entity waits for (`capacity/domain.ts` WaitingFor values). */
  waitingFor?: string[]
  /** Provider limit reset (ISO), when known. */
  resumeAt?: string | null
}

export interface OfferCall {
  tool: string
  args: Record<string, unknown>
}

export interface Offer {
  /** Stable within the entity: `resume`, `limit.switch`, `decide.merge_local`, `remedy.continue`… */
  id: string
  /** Localized. */
  label: string
  /** The exact call that executes this offer (also runnable through `specrails_inbox(act, offerId)`). */
  call: OfferCall
  tier: McpTier
  irreversible: boolean
  external: boolean
  /** USD range when the domain can estimate it. */
  costHint?: [number, number]
  /** True when executing it returns `confirmation_required` first (external MCP clients). */
  needsConfirm: boolean
  /** Arguments only the person can supply, to add to `call.args` (`answer|optionId`, `options.runCapUsd`). */
  needs?: string[]
  /** Localized; why the server recommends or offers it. */
  why?: string
}

export interface DecisionState {
  status: CanonicalStatus
  /** The app's word for the status (one of its nine run states) and its localized label. */
  appState: AppRunState
  label: string
  /** e.g. `implement · step 3/7 · verify`. */
  phase?: string
  hold?: Hold
  offers: Offer[]
  /** offerId the domain recommends; absent when it has no preference. */
  recommended?: string
  cost?: { spentUsd: number; estimated: boolean; forecastUsd?: [number, number] }
  /** Hash of the decision-relevant state; confirmTokens bind to it. */
  version: string
}

// ── Builder ─────────────────────────────────────────────────────────────────

export interface HoldDraft {
  kind: HoldKind
  code?: string
  /** Message key; default `core.hold.<kind>[.<code>]` (falls back to `core.hold.<kind>`). */
  reasonKey?: string
  params?: Params
  since: string | null
  waitingFor?: string[]
  resumeAt?: string | null
}

export interface OfferDraft {
  id: string
  /** Message key of the label (`core.offer.*` or `<area>.offer.*`). */
  labelKey: string
  labelParams?: Params
  /** Text already in the person's language (an AI analysis option); wins over labelKey. */
  label?: string
  call: OfferCall
  costHint?: [number, number]
  needs?: string[]
  whyKey?: string
  why?: string
}

export interface DecisionStateInput {
  status: CanonicalStatus
  phase?: string
  hold?: HoldDraft | null
  offers: readonly OfferDraft[]
  recommended?: string | null
  cost?: DecisionState['cost']
  /** Extra decision-relevant facts (row `updated_at`, head SHA, decision row id…) that must invalidate confirmations. */
  versionFacts?: unknown
}

export interface ActionPolicy {
  tier: McpTier
  confirm: ConfirmClass | null
}

/** The v2 catalog's tier and confirmation class of a call (registry.ts `policyFor`). Null: unknown tool/action. */
export type PolicyLookup = (tool: string, action: string, args: Record<string, unknown>) => ActionPolicy | null

export interface DecisionEnv {
  translate: Translate
  policyFor: PolicyLookup
  /** "Ask before spending" threshold (USD); costly offers above it need confirmation. */
  confirmAboveUsd: number
}

/** Whether a call of this class needs a confirmToken, given what its cost forecast says. */
export function confirmNeeded(confirm: ConfirmClass | null, forecast: { highUsd?: number | null; runs?: number | null }, thresholdUsd: number): boolean {
  if (confirm === 'irreversible' || confirm === 'risky' || confirm === 'external') return true
  if (confirm !== 'costly') return false
  if ((forecast.runs ?? 1) > 1) return true
  // An unknown forecast is treated as above the threshold (conservative).
  return forecast.highUsd === undefined || forecast.highUsd === null || forecast.highUsd > thresholdUsd
}

/** The state version: stable across languages and costs, sensitive to everything that changes legality. */
export function stateVersion(input: Pick<DecisionStateInput, 'status' | 'phase' | 'hold' | 'offers' | 'recommended' | 'versionFacts'>): string {
  return shortHash({
    s: input.status,
    p: input.phase ?? null,
    h: input.hold ? { k: input.hold.kind, c: input.hold.code ?? null, s: input.hold.since, r: input.hold.resumeAt ?? null, w: input.hold.waitingFor ?? null } : null,
    o: input.offers.map((offer) => [offer.id, offer.call.tool, offer.call.args]),
    r: input.recommended ?? null,
    f: input.versionFacts ?? null,
  })
}

function holdReason(hold: HoldDraft, translate: Translate): string {
  if (hold.reasonKey) return translate(hold.reasonKey, hold.params)
  if (hold.code) {
    const specific = `core.hold.${hold.kind}.${hold.code}`
    const text = translate(specific, hold.params)
    if (text !== specific) return text
  }
  return translate(`core.hold.${hold.kind}`, hold.params)
}

/**
 * Builds the state. Throws (a programming error, caught by tests) when an
 * offer targets a call the v2 catalog does not have, or when two offers share
 * an id. A `recommended` id that is not an offer is dropped.
 */
export function buildDecisionState(input: DecisionStateInput, env: DecisionEnv): DecisionState {
  const seen = new Set<string>()
  const offers: Offer[] = input.offers.map((draft) => {
    if (seen.has(draft.id)) throw new Error(`Duplicate offer id "${draft.id}".`)
    seen.add(draft.id)
    const action = typeof draft.call.args.action === 'string' ? draft.call.args.action : ''
    const policy = env.policyFor(draft.call.tool, action, draft.call.args)
    if (!policy) throw new Error(`Offer "${draft.id}" targets unknown call ${draft.call.tool}(${action}).`)
    const offer: Offer = {
      id: draft.id,
      label: draft.label ?? env.translate(draft.labelKey, draft.labelParams),
      call: draft.call,
      tier: policy.tier,
      irreversible: policy.confirm === 'irreversible',
      external: policy.confirm === 'external',
      needsConfirm: confirmNeeded(policy.confirm, { highUsd: draft.costHint?.[1] }, env.confirmAboveUsd),
    }
    if (draft.costHint) offer.costHint = draft.costHint
    if (draft.needs?.length) offer.needs = draft.needs
    const why = draft.why ?? (draft.whyKey ? env.translate(draft.whyKey) : undefined)
    if (why) offer.why = why
    return offer
  })
  const state: DecisionState = {
    status: input.status,
    appState: appState(input.status),
    label: env.translate(`core.status.${input.status}`),
    offers,
    version: stateVersion(input),
  }
  if (input.phase) state.phase = input.phase
  if (input.hold) {
    const hold: Hold = { kind: input.hold.kind, reason: holdReason(input.hold, env.translate), since: input.hold.since }
    if (input.hold.code) hold.code = input.hold.code
    if (input.hold.waitingFor?.length) hold.waitingFor = input.hold.waitingFor
    if (input.hold.resumeAt) hold.resumeAt = input.hold.resumeAt
    state.hold = hold
  }
  if (input.recommended && seen.has(input.recommended)) state.recommended = input.recommended
  if (input.cost) state.cost = input.cost
  return state
}

/** True when the person is the next actor (inbox-worthy): needs_you/review statuses or a person-facing hold. */
export function needsPerson(state: Pick<DecisionState, 'status' | 'hold'>): boolean {
  if (state.status === 'needs_you' || state.status === 'ready_for_review') return true
  const kind = state.hold?.kind
  return kind === 'question' || kind === 'approval' || kind === 'budget' || kind === 'provider_limit' || kind === 'pr_decision' || kind === 'restart' || kind === 'interrupted'
}
