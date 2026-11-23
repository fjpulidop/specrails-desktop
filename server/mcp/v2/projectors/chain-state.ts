import type { MilestoneChainSnapshot, MilestoneProgress, MilestoneRail } from '../../../modules/builder/runtime/milestone-progress'
import { projectChain, projectRunHold } from '../core/decision-sources'
import type { DecisionStateInput, HoldDraft, OfferDraft } from '../core/decision-state'
import type { Translate } from '../core/lang'
import type { Ref } from '../core/refs'
import { statusFromChain, statusFromHold, statusFromWord } from '../core/status-map'

/**
 * Decision state of the Blueprint popover's entities (WP6), from the builder
 * module's own rules only:
 *
 * - chains: the reconcile plan (`ChainPlan.offers`, first = recommended) via
 *   `projectChain`, plus the controls the chain row shows on every active
 *   chain (Continue automatically on/off, Cancel). A paused chain holds with
 *   its pause reason; a wave checkpoint (`awaiting_approval`) holds with
 *   `checkpoint`. A chain waiting on a held rail says so (`rail_held`).
 * - rails: the shared run hold (`loop-run-hold.ts`) of the live run, via
 *   `projectRunHold` (resume, answer, approve, limit and budget choices).
 * - milestones: the popover's CTAs (`isMilestoneLaunchable`, "Generate
 *   M<next>" for the first planned milestone after M1) and the chain's offers.
 */

const BLUEPRINT = 'specrails_blueprint'
/** Chain pause reasons without a `core.hold.chain.<code>` sentence. */
const OWN_HOLD_CODES = new Set(['chunk_stalled', 'chunk_stopped', 'launch_rejected', 'head_missing', 'head_discarded', 'run_lost', 'checkpoint', 'rail_held'])
const ACTIVE: ReadonlySet<string> = new Set(['running', 'waiting', 'paused', 'awaiting_approval'])

export const isActiveChain = (chain: Pick<MilestoneChainSnapshot, 'status'> | null | undefined): boolean => !!chain && ACTIVE.has(chain.status)

export interface ChainRefs {
  chain: Ref
  run: (runId: string) => Ref
}

function holdCode(reason: string): { code: string; detail: string | null } {
  const at = reason.indexOf(':')
  return at < 0 ? { code: reason, detail: null } : { code: reason.slice(0, at), detail: reason.slice(at + 1) || null }
}

function ownHold(code: string, since: string | null, detail: string | null = null, params: Record<string, string | number> = {}): HoldDraft {
  return { kind: 'chain', code, since, reasonKey: `blueprint.hold.${code}`, params: { detail: detail ?? '', ...params } }
}

/** The rail the chain is waiting on, when its live run is held (paused, a question…). */
export function heldRailOf(chain: MilestoneChainSnapshot, rails: readonly MilestoneRail[]): MilestoneRail | null {
  if (chain.status !== 'running') return null
  const current = rails.find((rail) => rail.active && rail.hold && (chain.currentRailIndex === null || rail.railIndex === chain.currentRailIndex))
  return current ?? null
}

/** `rail 2 of 5 · #14` (the chain row's step line). */
export function chainPhase(chain: MilestoneChainSnapshot): string | undefined {
  const total = chain.plan?.total ?? chain.totalChunks
  if (!total) return undefined
  const action = chain.plan?.action
  const ticket = action && 'ticketId' in action ? ` · #${action.ticketId}` : ''
  const step = Math.min(Math.max(chain.plan ? chain.plan.settled + (action?.kind === 'complete' ? 0 : 1) : chain.nextChunk, 1), total)
  return `rail ${step}/${total}${ticket}`
}

/** A milestone chain: reconcile offers first, then the chain row's controls. */
export function projectChainState(refs: ChainRefs, chain: MilestoneChainSnapshot, rails: readonly MilestoneRail[] = []): DecisionStateInput {
  const active = isActiveChain(chain)
  const paused = chain.status === 'paused'
  const projected = chain.plan && active
    ? projectChain(refs.chain, chain.plan, refs.run, paused ? { reason: chain.pauseReason, since: chain.updatedAt } : null)
    : { offers: [] as OfferDraft[] }
  let hold: HoldDraft | undefined = projected.hold
  if (paused && chain.pauseReason) {
    const { code, detail } = holdCode(chain.pauseReason)
    hold = OWN_HOLD_CODES.has(code) ? ownHold(code, chain.updatedAt, detail) : { ...(hold ?? { kind: 'chain', since: chain.updatedAt }), code }
  } else if (paused) {
    hold = { kind: 'chain', since: chain.updatedAt }
  } else if (chain.status === 'awaiting_approval') {
    const settled = chain.plan?.settled ?? Math.max(chain.nextChunk - 1, 0)
    hold = ownHold('checkpoint', chain.updatedAt, null, { done: settled, total: chain.plan?.total ?? chain.totalChunks })
  }
  const held = heldRailOf(chain, rails)
  if (held?.hold && !hold) hold = ownHold('rail_held', held.hold.since, held.hold.kind, { rail: held.railIndex + 1 })

  const offers: OfferDraft[] = [...projected.offers]
  if (active) {
    offers.push(chain.autoAdvance
      ? { id: 'chain.auto_advance_off', labelKey: 'blueprint.offer.auto_advance_off', call: { tool: BLUEPRINT, args: { action: 'chain_auto_advance', ref: refs.chain, enabled: false } } }
      : { id: 'chain.auto_advance_on', labelKey: 'blueprint.offer.auto_advance_on', call: { tool: BLUEPRINT, args: { action: 'chain_auto_advance', ref: refs.chain, enabled: true } } })
    offers.push({ id: 'chain.cancel', labelKey: 'blueprint.offer.cancel', call: { tool: BLUEPRINT, args: { action: 'chain_cancel', ref: refs.chain } } })
  }
  const phase = chainPhase(chain)
  return {
    status: statusFromChain(chain.status),
    ...(phase ? { phase } : {}),
    ...(hold ? { hold } : {}),
    offers,
    ...(projected.recommended ? { recommended: projected.recommended } : {}),
    versionFacts: {
      u: chain.updatedAt, n: chain.nextChunk, a: chain.autoAdvance, r: chain.retryChunk, p: chain.pauseReason,
      plan: chain.plan ? [chain.plan.action, chain.plan.settled, chain.plan.specs.map((spec) => [spec.ticketId, spec.state, spec.runId, spec.deliveryId])] : null,
      e: chain.nextEngine ? [chain.nextEngine.provider, chain.nextEngine.model, chain.nextEngine.reasoningEffort] : null,
      h: held ? [held.railIndex, held.hold?.kind] : null,
    },
  }
}

/** A live rail row: the shared run hold and its resolutions; null while it works or when idle. */
export function projectRailState(runRef: Ref, rail: MilestoneRail, translate: Translate): DecisionStateInput | null {
  if (!rail.active || !rail.hold) return null
  const projected = projectRunHold(runRef, rail.hold, null, translate)
  return { status: statusFromHold(rail.hold), ...(projected.hold ? { hold: projected.hold } : {}), offers: projected.offers, versionFacts: { r: rail.runId, k: rail.hold.kind, s: rail.hold.since } }
}

export interface MilestoneFacts {
  milestoneRef: Ref
  /** `{ project, milestone }` of v2 calls on this milestone. */
  scope: { project: string; milestone: number }
  /** The first planned milestone after M1 (the popover's Generate CTA). */
  generatable: boolean
  /** A generated, not yet committed batch is waiting (milestone_generate ran). */
  draftReady?: boolean
  chainRefs?: ChainRefs | null
}

/** A milestone row: its derived state, launch/generate CTAs and its chain's offers. */
export function projectMilestoneState(m: MilestoneProgress, facts: MilestoneFacts): DecisionStateInput {
  const chain = m.chain && isActiveChain(m.chain) ? m.chain : null
  const offers: OfferDraft[] = []
  let hold: HoldDraft | undefined
  let recommended: string | undefined
  if (chain && facts.chainRefs) {
    const state = projectChainState(facts.chainRefs, chain, m.rails)
    offers.push(...state.offers)
    hold = state.hold ?? undefined
    recommended = state.recommended ?? undefined
  }
  const launchable = m.counts.todo > 0 && !chain
  if (launchable) {
    offers.push({ id: 'milestone.launch', labelKey: 'blueprint.offer.launch', labelParams: { n: m.n }, call: { tool: BLUEPRINT, args: { action: 'chain_launch', ...facts.scope } } })
    recommended ??= 'milestone.launch'
  }
  if (m.storedStatus === 'planned' && m.counts.total === 0) {
    if (facts.draftReady) {
      offers.push({ id: 'milestone.commit', labelKey: 'blueprint.offer.commit', labelParams: { n: m.n }, call: { tool: BLUEPRINT, args: { action: 'milestone_commit', ...facts.scope } } })
      recommended ??= 'milestone.commit'
    }
    if (facts.generatable || facts.draftReady) {
      offers.push({ id: 'milestone.generate', labelKey: facts.draftReady ? 'blueprint.offer.regenerate' : 'blueprint.offer.generate', labelParams: { n: m.n }, call: { tool: BLUEPRINT, args: { action: 'milestone_generate', ...facts.scope, ...(facts.draftReady ? { options: { fresh: true } } : {}) } } })
      recommended ??= 'milestone.generate'
    }
  }
  return {
    status: chain ? statusFromChain(chain.status) : statusFromWord(m.state),
    ...(hold ? { hold } : {}),
    offers,
    ...(recommended ? { recommended } : {}),
    versionFacts: { s: m.state, c: m.counts, ch: chain ? [chain.id, chain.updatedAt, chain.status] : null, d: facts.draftReady === true },
  }
}
