import type { RunHold, RunPauseControl } from '../../../modules/loops/runtime/loop-run-hold'
import type { RemedyId, ResolutionOption } from '../../../modules/recovery'
import type { DecisionStateInput, OfferDraft } from '../core/decision-state'
import { projectFailure, projectRunHold } from '../core/decision-sources'
import type { Translate } from '../core/lang'
import type { Ref } from '../core/refs'
import { statusFromJob } from '../core/status-map'

/**
 * The decision state of one run (WP3): what the run window shows and lets the
 * person do, as a pure function of facts the server already computes.
 *
 * - a held or paused run: `projectRunHold` (loop-run-hold.ts holds + the
 *   person's Pause control), plus the limit pause's own switch targets;
 * - a failed or stopped run: `projectFailure` (ranked remedies + the AI
 *   analysis' resolution options), narrowed to what the run can still do
 *   (`GET /loop-runs/:id/attempts` → `continuable`, a rail to start over on),
 *   plus "continue on another provider" when it settled on a usage limit;
 * - a finished runtime continuation: settle / dismiss when the runtime says so;
 * - every active run: Stop.
 *
 * No rule here is new: each offer exists because a domain fact says so.
 */

/** A provider a run may continue on (loop-run-contract.ts `ProviderSwitchTarget`, structurally). */
export interface ProviderSwitchTarget { provider: string; model: string; effort?: string | null }

const RUNS = 'specrails_runs'
const call = (ref: Ref, action: string, extra: Record<string, unknown> = {}) => ({ tool: RUNS, args: { action, ref, ...extra } })

export interface RunFacts {
  /** `jobs.status` (queued, running, completed, failed, canceled, …). */
  jobStatus: string
  /** The derived hold of a running row (loop-run-hold.ts); null while it works. */
  hold: RunHold | null
  pauseControl: RunPauseControl | null
  /** A limit pause (live or retained): the providers the run may continue on now. */
  limit?: { switchTargets?: readonly ProviderSwitchTarget[] | null; switchable?: boolean } | null
  /** `PresentedFailureDiagnosis.remedies`, ranked by recovery/domain.ts. */
  remedies?: readonly RemedyId[] | null
  /** The stored AI failure analysis (prompt v4+ carries options). */
  analysis?: { options?: readonly ResolutionOption[]; createdAt?: string | null } | null
  /** `GET /loop-runs/:id/attempts` → continuable (Continue applies). Undefined: unknown (not a definition run). */
  continuable?: boolean
  /** A run that settled on a usage limit may continue on another provider (`providerSwitch`). */
  settledSwitch?: { targets: readonly ProviderSwitchTarget[] } | null
  /** Runtime continuation controls (`GET /agent-runtime/runs/:id`). */
  runtime?: { canSettle?: boolean; canDismiss?: boolean } | null
  /** The rail the run belongs to; Start over relaunches it. */
  railIndex?: number | null
  /** e.g. `implement · step 3/7`. */
  phase?: string
  spentUsd?: number | null
  costEstimated?: boolean
  /** Row facts that invalidate confirmations (finished_at, analysis time). */
  versionFacts?: unknown
}

const ACTIVE = new Set(['queued', 'running'])
const FAILED = new Set(['failed', 'canceled', 'zombie_terminated'])
/** Remedy choices that continue the run (they need a continuable definition run). */
const CONTINUES = new Set(['continue', 'continue_to_review', 'change_model'])

function failureOffers(ref: Ref, facts: RunFacts): { offers: OfferDraft[]; recommended?: string } {
  const projected = projectFailure(ref, { remedies: facts.remedies ?? [] }, facts.analysis ?? null)
  const offers = projected.offers.filter((offer) => {
    if (offer.call.args.action !== 'remedy') return true
    const choice = String(offer.call.args.choice ?? '')
    if (choice === 'start_over') return facts.railIndex !== null && facts.railIndex !== undefined
    // `change_model` without a provider switch runs on the client (a new launch with another model).
    if (choice === 'change_model') return facts.continuable === true && !!facts.settledSwitch?.targets.length
    return !CONTINUES.has(choice) || facts.continuable === true
  })
  if (facts.continuable === true && facts.settledSwitch?.targets.length) {
    const target = facts.settledSwitch.targets[0]
    offers.push({
      id: 'remedy.switch', labelKey: 'runs.offer.continue_on', labelParams: { provider: target.provider },
      call: call(ref, 'remedy', { choice: 'continue', provider: target.provider, model: target.model, ...(target.effort ? { effort: target.effort } : {}) }),
    })
  }
  if ((facts.railIndex ?? null) !== null && !offers.some((offer) => offer.call.args.choice === 'start_over')) {
    offers.push({ id: 'remedy.retry', labelKey: 'core.offer.remedy.retry', call: call(ref, 'remedy', { choice: 'start_over' }) })
  }
  const recommended = projected.recommended && offers.some((offer) => offer.id === projected.recommended) ? projected.recommended
    : offers.find((offer) => offer.call.args.action === 'remedy')?.id
  return { offers, ...(recommended ? { recommended } : {}) }
}

/** The run's DecisionStateInput (build it with `ctx.v2.state`). */
export function projectRunState(ref: Ref, facts: RunFacts, translate: Translate): DecisionStateInput {
  const status = statusFromJob(facts.jobStatus, facts.hold)
  const offers: OfferDraft[] = []
  let recommended: string | undefined
  let hold: DecisionStateInput['hold']

  if (ACTIVE.has(facts.jobStatus)) {
    const targets = facts.limit?.switchTargets?.map((target) => ({ provider: target.provider, model: target.model })) ?? []
    const projected = projectRunHold(ref, facts.hold, facts.pauseControl, translate, { switchTargets: targets })
    hold = projected.hold
    offers.push(...projected.offers)
    // The older engine switches with a provider only (its model is the provider's default).
    if (facts.hold?.kind === 'provider_limit' && !targets.length && facts.limit?.switchable) {
      offers.push({ id: 'limit.switch', labelKey: 'core.offer.run.limit_switch', call: call(ref, 'limit', { choice: 'switch' }), needs: ['provider'] })
    }
    offers.push({ id: 'stop', labelKey: 'runs.offer.stop', call: call(ref, 'stop') })
  } else if (FAILED.has(facts.jobStatus)) {
    const failure = failureOffers(ref, facts)
    offers.push(...failure.offers)
    recommended = failure.recommended
  }
  if (!ACTIVE.has(facts.jobStatus) && facts.runtime?.canSettle) offers.push({ id: 'settle', labelKey: 'runs.offer.settle', call: call(ref, 'settle') })
  if (!ACTIVE.has(facts.jobStatus) && facts.runtime?.canDismiss) offers.push({ id: 'dismiss', labelKey: 'runs.offer.dismiss', call: call(ref, 'dismiss') })

  const input: DecisionStateInput = { status, offers, ...(hold ? { hold } : {}), ...(recommended ? { recommended } : {}) }
  if (facts.phase) input.phase = facts.phase
  if (typeof facts.spentUsd === 'number') input.cost = { spentUsd: facts.spentUsd, estimated: facts.costEstimated === true }
  if (facts.versionFacts !== undefined) input.versionFacts = facts.versionFacts
  return input
}
