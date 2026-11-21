import type { RunHold, RunPauseControl } from '../../../modules/loops/runtime/loop-run-hold'
import { PR_DECISION_ACTIONS, actionAllowed, ciFixAllowed, type CiFixState, type DeliveryDecisionState, type PrDecisionAction } from '../../../modules/delivery'
import type { ChainOffer, ChainOfferKind } from '../../../modules/builder/runtime/milestone-chain-reconcile'
import type { RemedyId, ResolutionKind, ResolutionOption } from '../../../modules/recovery'
import type { HoldDraft, OfferDraft } from './decision-state'
import type { Translate } from './lang'
import type { Ref } from './refs'

/**
 * Pure projectors from the server's own legality rules to v2 holds and offers.
 * Area projectors (`v2/projectors/<area>-state.ts`) gather the facts and call
 * these; none of them decides anything the domain did not:
 *
 * - runs:       loop-run-hold.ts (`RunHold`, `RunPauseControl`)
 * - failures:   recovery/domain.ts (ranked `RemedyId`s) + recovery/analysis.ts (`ResolutionOption`s)
 * - deliveries: delivery/domain/decision-policy.ts (`actionAllowed`, `ciFixAllowed`)
 * - chains:     builder/runtime/milestone-chain-reconcile.ts (`ChainPlan.offers`, first = recommended)
 *
 * Every offer's `call` is a v2 call (tool + action + the entity ref); fields
 * only the person can supply (an answer, a provider) are listed in `needs`.
 */

export interface Projected {
  hold?: HoldDraft
  offers: OfferDraft[]
  recommended?: string
}

const RUNS = 'specrails_runs'
const DELIVERIES = 'specrails_deliveries'
const BLUEPRINT = 'specrails_blueprint'

const runCall = (ref: Ref, action: string, extra: Record<string, unknown> = {}) => ({ tool: RUNS, args: { action, ref, ...extra } })

// ── Runs ────────────────────────────────────────────────────────────────────

export interface RunHoldExtras {
  /** Providers a limited run may switch to (the limit pause's `switchTargets`); omit the switch offer when empty. */
  switchTargets?: ReadonlyArray<{ provider: string; model?: string | null }>
}

/** The hold of a run (localized reason resolved by buildDecisionState). */
export function holdFromRun(hold: RunHold, translate: Translate): HoldDraft {
  const draft: HoldDraft = { kind: hold.kind, since: hold.since }
  if (hold.kind === 'paused' && hold.byYou) draft.reasonKey = 'core.hold.paused_by_you'
  if (hold.kind === 'provider_limit' && hold.resumeAt) {
    draft.reasonKey = 'core.hold.provider_limit_until'
    draft.params = { at: hold.resumeAt }
    draft.resumeAt = hold.resumeAt
  }
  if (hold.kind === 'queued' && hold.waitingFor) {
    draft.reasonKey = 'core.hold.queued_for'
    draft.params = { waitingFor: translate(`core.waitingFor.${hold.waitingFor}`) }
    draft.waitingFor = [hold.waitingFor]
  }
  return draft
}

/** What a held run can do, from its `RunHoldKind` (the resolutions the run window offers). */
export function offersFromRunHold(ref: Ref, hold: RunHold, extras: RunHoldExtras = {}): OfferDraft[] {
  switch (hold.kind) {
    case 'restart':
    case 'interrupted':
      return [
        { id: 'resume', labelKey: 'core.offer.run.resume', call: runCall(ref, 'resume') },
        { id: 'recover', labelKey: 'core.offer.run.recover', call: runCall(ref, 'resume', { options: { mode: 'recover' } }) },
      ]
    case 'provider_limit': {
      const offers: OfferDraft[] = [
        { id: 'limit.resume_now', labelKey: 'core.offer.run.limit_resume_now', call: runCall(ref, 'limit', { choice: 'resume_now' }) },
        { id: 'limit.auto', labelKey: 'core.offer.run.limit_auto', call: runCall(ref, 'limit', { choice: 'auto', options: { enabled: true } }) },
      ]
      const target = extras.switchTargets?.[0]
      if (target) {
        offers.push({
          id: 'limit.switch', labelKey: 'core.offer.run.limit_switch',
          call: runCall(ref, 'limit', { choice: 'switch', provider: target.provider, ...(target.model ? { model: target.model } : {}) }),
        })
      }
      return offers
    }
    case 'budget':
      return [
        { id: 'budget.once', labelKey: 'core.offer.run.budget_once', call: runCall(ref, 'resume', { options: { runCap: 'once' } }) },
        { id: 'budget.ignore', labelKey: 'core.offer.run.budget_ignore', call: runCall(ref, 'resume', { options: { runCap: 'ignore' } }) },
        { id: 'budget.raise', labelKey: 'core.offer.run.budget_raise', call: runCall(ref, 'resume', { options: { runCapUsd: null } }), needs: ['options.runCapUsd'] },
      ]
    case 'question':
      return [{ id: 'answer', labelKey: 'core.offer.run.answer', call: runCall(ref, 'answer'), needs: ['answer|optionId'] }]
    case 'approval':
      return [
        { id: 'approve', labelKey: 'core.offer.run.approve', call: runCall(ref, 'approve') },
        { id: 'reject', labelKey: 'core.offer.run.reject', call: runCall(ref, 'reject') },
      ]
    case 'paused':
      return [{ id: 'resume', labelKey: 'core.offer.run.resume', call: runCall(ref, 'resume') }]
    case 'queued':
      return []
  }
}

/** The person's Pause control (loop-run-hold.ts `RunPauseControl`). `pausing` offers nothing until it lands. */
export function offersFromPauseControl(ref: Ref, control: RunPauseControl | null): OfferDraft[] {
  if (control === 'pause') return [{ id: 'pause', labelKey: 'core.offer.run.pause', call: runCall(ref, 'pause') }]
  if (control === 'resume') return [{ id: 'resume', labelKey: 'core.offer.run.resume', call: runCall(ref, 'resume') }]
  return []
}

/** A held run: hold + resolutions + pause control, deduplicated by offer id (the hold's own offers first). */
export function projectRunHold(ref: Ref, hold: RunHold | null, control: RunPauseControl | null, translate: Translate, extras: RunHoldExtras = {}): Projected {
  const offers = [...(hold ? offersFromRunHold(ref, hold, extras) : []), ...offersFromPauseControl(ref, control)]
  const unique = offers.filter((offer, index) => offers.findIndex((other) => other.id === offer.id) === index)
  return { ...(hold ? { hold: holdFromRun(hold, translate) } : {}), offers: unique }
}

// ── Failures ────────────────────────────────────────────────────────────────

/** v2 `runs(remedy, choice)` for a ranked recovery remedy; null for remedies that are not a run call. */
const REMEDY_CHOICE: Partial<Record<RemedyId, string>> = {
  continue: 'continue',
  'fix-environment': 'continue',
  'continue-to-review': 'continue_to_review',
  'edit-spec': 'edit_spec',
  retry: 'start_over',
}

const RESOLUTION_CHOICE: Record<ResolutionKind, string> = {
  'continue-with-guidance': 'continue',
  'continue-to-review': 'continue_to_review',
  'mark-human-check': 'continue',
  'edit-spec': 'edit_spec',
  'change-model': 'change_model',
  'start-over': 'start_over',
}

export interface FailureFacts {
  /** `PresentedFailureDiagnosis.remedies`, ranked by recovery/domain.ts `rankRemedies`. */
  remedies: readonly RemedyId[]
}

/**
 * Offers of a failed run. With an AI analysis (prompt v4+), its resolution
 * options come first (labels already in the analysis language) and the
 * recommendation is the option the analysis marked recommended unless it is
 * high risk, else its first low-risk option; without one, the top-ranked
 * remedy is recommended. `diagnose` is always available.
 */
export function projectFailure(ref: Ref, facts: FailureFacts, analysis?: { options?: readonly ResolutionOption[] } | null): Projected {
  const offers: OfferDraft[] = []
  const options = analysis?.options ?? []
  for (const option of options) {
    offers.push({
      id: `resolution.${option.id}`, labelKey: 'core.offer.resolution', label: option.label, why: option.consequence,
      call: runCall(ref, 'remedy', { choice: RESOLUTION_CHOICE[option.kind], optionId: option.id }),
    })
  }
  for (const remedy of facts.remedies) {
    const id = `remedy.${remedy}`
    if (offers.some((offer) => offer.id === id)) continue
    if (remedy === 'open-logs') offers.push({ id, labelKey: 'core.offer.remedy.open-logs', call: runCall(ref, 'get', { view: 'detail', fields: ['logs'] }) })
    else if (remedy === 'copy-env-files') offers.push({ id, labelKey: 'core.offer.remedy.copy-env-files', call: runCall(ref, 'remedy', { choice: 'continue', options: { copyEnvFiles: true } }) })
    else if (REMEDY_CHOICE[remedy]) offers.push({ id, labelKey: `core.offer.remedy.${remedy}`, call: runCall(ref, 'remedy', { choice: REMEDY_CHOICE[remedy] }) })
  }
  offers.push({ id: 'diagnose', labelKey: 'core.offer.run.diagnose', call: runCall(ref, 'diagnose', { options: { generate: true } }) })
  const pick = options.find((option) => option.recommended && option.risk !== 'high') ?? options.find((option) => option.risk === 'low')
  const firstRemedy = offers.find((offer) => offer.id.startsWith('remedy.') && offer.call.args.action === 'remedy')
  const recommended = pick ? `resolution.${pick.id}` : firstRemedy?.id
  return { offers, ...(recommended ? { recommended } : {}) }
}

// ── Deliveries ──────────────────────────────────────────────────────────────

const decisionName = (action: PrDecisionAction) => action.replace(/-/g, '_')

export interface DeliveryFacts {
  /** For the CI offer (decision-policy.ts `ciFixAllowed`); omit when the project has no PR CI loop. */
  ci?: CiFixState | null
  /** The merge preview into the integration branch is clean (`MergePreviewStatus`). */
  mergePreviewClean?: boolean
  /** The person's default is integrating locally. */
  prefersLocal?: boolean
  /** The project delivers through pull requests. */
  deliversByPr?: boolean
}

/** Legal decisions of a delivery row, recommended per §3 of the design. Its hold is `pr_decision` while one is open. */
export function projectDelivery(ref: Ref, row: DeliveryDecisionState, facts: DeliveryFacts = {}, since: string | null = null): Projected {
  const offers: OfferDraft[] = PR_DECISION_ACTIONS.filter((action) => actionAllowed(action, row)).map((action) => ({
    id: `decide.${decisionName(action)}`,
    labelKey: `core.offer.delivery.${decisionName(action)}`,
    call: { tool: DELIVERIES, args: { action: 'decide', ref, decision: decisionName(action) } },
  }))
  if (facts.ci && ciFixAllowed(facts.ci)) {
    offers.push({ id: 'decide.ci_fix', labelKey: 'core.offer.delivery.ci_fix', call: { tool: DELIVERIES, args: { action: 'decide', ref, decision: 'ci_fix' } } })
  }
  const has = (id: string) => offers.some((offer) => offer.id === id)
  const recommended = has('decide.merge_local') && facts.mergePreviewClean && facts.prefersLocal ? 'decide.merge_local'
    : has('decide.create_pr') && facts.deliversByPr ? 'decide.create_pr'
      : undefined
  const open = ['on_review', 'pr_draft', 'pr_ready', 'pr_failed', 'no_changes', 'implementation_failed', 'pr_closed'].includes(row.decision)
  return { ...(open && offers.length ? { hold: { kind: 'pr_decision', since } as HoldDraft } : {}), offers, ...(recommended ? { recommended } : {}) }
}

// ── Milestone chains ────────────────────────────────────────────────────────

/** A chain offer → the v2 call that performs it (the reconcile plan's own Resume semantics via `from`). */
function chainCall(chainRef: Ref, offer: ChainOffer, runRef: (runId: string) => Ref): OfferDraft['call'] {
  if (offer.kind === 'follow_run' && offer.runId) return runCall(runRef(offer.runId), 'get')
  if (offer.kind === 'answer_run' && offer.runId) return runCall(runRef(offer.runId), 'answer')
  return { tool: BLUEPRINT, args: { action: 'chain_resume', ref: chainRef, from: offer.from } }
}

/**
 * Offers of a milestone chain from its reconcile plan (`ChainPlan.offers`:
 * ordered, the first is the recommended next step). `runRef` turns a run id
 * into its global ref.
 */
export function projectChain(chainRef: Ref, plan: { offers: readonly ChainOffer[] }, runRef: (runId: string) => Ref, pause?: { reason: string | null; since: string | null } | null): Projected {
  const offers: OfferDraft[] = plan.offers.map((offer) => ({
    id: `chain.${offer.kind satisfies ChainOfferKind}`,
    labelKey: `core.offer.chain.${offer.kind}`,
    call: chainCall(chainRef, offer, runRef),
    ...(offer.kind === 'answer_run' ? { needs: ['answer|optionId'] } : {}),
  }))
  const reason = pause?.reason ?? null
  const code = reason ? (reason.startsWith('integration_failed') ? 'integration_failed' : reason) : undefined
  return {
    ...(pause ? { hold: { kind: 'chain', ...(code ? { code } : {}), since: pause.since } as HoldDraft } : {}),
    offers,
    ...(offers[0] ? { recommended: offers[0].id } : {}),
  }
}
