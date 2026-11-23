/**
 * The PR decision card's state machine: the envelope (with its local HTTP
 * override), live runtime polling, the run/flow/CI status it derives, the
 * card's actions and the shared pieces (chips, phase line, log modal,
 * diagnosis) every render branch uses. Returned as one model the branch
 * bodies read from.
 */
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useInRouterContext } from 'react-router-dom'
import { Activity } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import { localizeStatusDetail } from '../../../../lib/pr-status-detail'
import { FEATURE_MISSION_RAIL_CARDS } from '../../../../lib/feature-flags'
import { usePrCiStatus } from '../../../delivery/lib/pr-ci'
import { useStackedHeadDeliveryIds } from '../../../builder/hooks/useMilestoneProgress'
import { derivePrDeliveryPresentation, isInterruptedPrDeliveryOperation, isKnownPrDeliveryStatusCode } from '../../../delivery/lib/pr-delivery'
import { useDesktop } from '../../../../hooks/useDesktop'
import { useWebViewModal } from '../../../browser/context/WebViewModalContext'
import { useDialogLayer } from '../../../../components/ui/dialog'
import { nestedDialogLayer } from '../../../../lib/layers'
import { useRuntimeRuns } from '../../../jobs/components/job-run/useRuntimeRuns'
import type { RuntimeRun } from '../../../settings/lib/agent-runtime'
import { useMissionExtensions } from '../../context/MissionExtensionsContext'
import { useAgentRefActions } from '../../hooks/useAgentRefActions'
import type { AgentPrDecisionEnvelope } from '../../lib/agent-api'
import type { MissionRunCardSummary, MissionRunVitalsSnapshot } from '../mission-run-strip'
import { AgentRefChip } from '../AgentRefChip'
import { RunLogChip } from './RunLogChip'
import { deriveMissionRunStatus, flowCardOutcome, prNumberFromUrl, runtimeRunFromSnapshot } from './run-status'
import { useLocalEnvelope, usePrDecisionActions } from './usePrDecisionActions'
import { useCardConfirms } from './useCardConfirms'
import { useCardFocusBus } from './useCardFocusBus'
import { usePausedRuns } from './usePausedRuns'
import { useRunControls } from './useRunControls'
import { usePrCiFix } from './usePrCiFix'
import { useRunActionButtons } from './useRunActionButtons'
import { useRunDiagnosisSection } from './useRunDiagnosisSection'

// Only loads when a run-log chip is actually clicked — keeps the card chunk
// free of the log-explorer stack (same pattern as AgentConversationView's
// job-ref chips; the modal itself portals to document.body on the entity layer, 65).
const JobDetailModal = lazy(() =>
  import('../../../jobs/components/JobDetailModal').then((m) => ({ default: m.JobDetailModal })),
)

export interface PrDecisionCardModelInput {
  envelope: AgentPrDecisionEnvelope
  conversationId?: string | null
  embedded: boolean
  onSummary?: (summary: MissionRunCardSummary) => void
  onRunVitals?: (runId: string, snapshot: MissionRunVitalsSnapshot) => void
}

export function usePrDecisionCardModel({ envelope: envelopeProp, conversationId, embedded, onSummary, onRunVitals }: PrDecisionCardModelInput) {
  const { t } = useTranslation('agent')
  // The card is deliberately Router-OPTIONAL (it is unit-rendered bare in dozens
  // of tests and mounted inside the app Router in production). useNavigate would
  // throw outside a Router, so the route entry is gated on this non-throwing
  // probe and the hook itself lives in the child that only mounts inside one.
  const inRouterContext = useInRouterContext()
  const { projects } = useDesktop()
  const { openWebView, canOpenWebView } = useWebViewModal()
  // Ticket chips resolve against the CARD's project (never the active one) —
  // same scoping rule as the card's decision POSTs.
  const { openRef } = useAgentRefActions()
  // Confirm layer: inside a dialog (e.g. Job detail, entity 65) climb one
  // layer as usual; outside any dialog the card lives in the floating agent
  // chat (60), so a base (50) confirm would paint BEHIND it — use `stacked`.
  const parentDialogLayer = useDialogLayer()
  const confirmLayer = parentDialogLayer ? nestedDialogLayer(parentDialogLayer) : 'stacked'
  const { envelope, setLocalEnvelope } = useLocalEnvelope(envelopeProp)
  // Stacked head (milestone chain): a later chunk builds on this delivery.
  const stackedHeads = useStackedHeadDeliveryIds(envelope.projectId)
  const isStackedHead = stackedHeads.has(envelope.prDeliveryId)
  // A clicked run-log chip → the run's JobDetailModal (portals to body).
  const [logRunId, setLogRunId] = useState<string | null>(null)
  const { pausedRuns, onChipVitals } = usePausedRuns()

  const { decision, prUrl, prState } = envelope
  // ── mission-rail-cards ──────────────────────────────────────────────────────
  // `hasDelivery === false` = a shared-cwd launch (no git repo / no commits):
  // the card follows the run but has NO delivery phase. Legacy envelopes leave
  // the field undefined ⇒ delivery card, byte-identical to before.
  const runOnly = FEATURE_MISSION_RAIL_CARDS && envelope.hasDelivery === false
  const runFailure = FEATURE_MISSION_RAIL_CARDS ? envelope.runtime?.failure ?? null : null
  const primaryRunId = (envelope.runIds ?? [])[0] ?? null
  // Live runtime state (canResume / pendingApproval / recoverableSteps) is
  // polled only while the card can act on it — never for a settled delivery
  // that no longer needs recovery.
  const runtimeInterest = FEATURE_MISSION_RAIL_CARDS && !!primaryRunId && (
    decision === 'building' || !!runFailure || decision === 'implementation_failed' || envelope.runtime?.status === 'running'
  )
  const runtime = useRuntimeRuns(envelope.projectId, { jobId: primaryRunId ?? undefined, enabled: runtimeInterest })
  const liveRun: RuntimeRun | null = runtime.runs.find((r) => r.runId === primaryRunId) ?? runtime.runs[0] ?? null
  const actionableRun: RuntimeRun | null = liveRun ?? (primaryRunId ? runtimeRunFromSnapshot(envelope, primaryRunId) : null)
  const confirms = useCardConfirms(decision, prUrl, envelope.prDeliveryId)
  const hasRepositoryDeliveries = Boolean(envelope.repositoryDeliveries?.length)
  const presentation = derivePrDeliveryPresentation(envelope)
  const actions = usePrDecisionActions({ envelope, setLocalEnvelope, conversationId, runOnly, hasRepositoryDeliveries, presentation })
  const { busy, checkingOut } = actions
  // Read by the relaunch helper (declared before `anyBusy` exists in the
  // settled branch) without reordering the component.
  const anyBusyRef = useRef(false)
  anyBusyRef.current = busy !== null || checkingOut || envelope.operation != null || runtime.busy !== null
  const controls = useRunControls({ envelope, conversationId, anyBusyRef })
  const ci = usePrCiFix({ envelope, conversationId, anyBusyRef })
  const { cardRef, flash } = useCardFocusBus(envelope, conversationId)
  // Brief highlight pulse in theme tokens; the pulse only runs when motion is allowed.
  // Embedded in the run strip the card has no frame of its own: the panel that
  // holds it draws the highlight (data-flash), following the card's silhouette.
  const flashClass = embedded
    ? 'outline-none'
    : cn('outline-none focus-visible:ring-2 focus-visible:ring-ring', flash && 'ring-2 ring-accent-primary/50 ring-offset-1 ring-offset-background motion-safe:animate-pulse')
  const focusRegion = {
    tabIndex: -1,
    role: 'region' as const,
    'aria-label': t('prCard.focusRegion', {
      rail: envelope.railName || t('prCard.rail', { index: envelope.railIndex + 1 }),
      tickets: envelope.ticketIds.map((id) => `#${id}`).join(' '),
    }),
  }
  const { RunCardActions, RunFailureOutcome } = useMissionExtensions()
  const rawFlowOutcome = flowCardOutcome(envelope)
  // A failed Intent → Spec run is explained by Intent itself; without the
  // extension the card keeps its generic failure presentation.
  const flowOutcome = rawFlowOutcome === 'crashed' && !RunFailureOutcome ? null : rawFlowOutcome
  const flowFailure = envelope.runtime?.failure ?? null
  // Returned after a failure (not a review): the card keeps explaining why.
  const returnedAfterFailure = flowOutcome === 'returned' && !envelope.flowReview && !!flowFailure && !!RunFailureOutcome
  const flowFailureView = (flowOutcome === 'crashed' || returnedAfterFailure) && RunFailureOutcome ? (
    <RunFailureOutcome
      projectId={envelope.projectId}
      prDeliveryId={envelope.prDeliveryId}
      conversationId={conversationId ?? null}
      stepId={flowFailure?.stepId ?? null}
      // The runtime's own error, never the delivery's generic detail (that one is technical).
      cause={flowFailure?.stepId && flowFailure.detail && flowFailure.detail !== envelope.statusDetail ? flowFailure.detail : null}
      statusCode={flowOutcome === 'crashed' ? envelope.statusCode ?? null : flowFailure?.code ?? null}
      failureCode={(envelope.units ?? []).find((unit) => unit.failureCode)?.failureCode ?? null}
      statusDetail={flowOutcome === 'crashed' ? envelope.statusDetail ?? null : null}
      repositoryName={envelope.repositoryDeliveries?.length ? envelope.repositoryDeliveries.map((repository) => repository.name).join(', ') : null}
      returned={flowOutcome === 'returned'}
      surface="card"
      busy={busy !== null || envelope.operation != null}
    />
  ) : null
  const interruptedOperationDetail = isInterruptedPrDeliveryOperation(envelope.statusCode, envelope.statusDetail)
  const recoveredInterruptedOperation = envelope.operation == null && interruptedOperationDetail
  const projectName = projects.find((p) => p.id === envelope.projectId)?.name ?? envelope.projectId
  const degradedDraft = decision === 'pr_draft' && !prUrl
  const existingPrContinuation = decision === 'building' && prState === 'pr-created' && Boolean(envelope.branch)
  const displayedPrNumber = envelope.prNumber ? `#${envelope.prNumber}` : prUrl ? prNumberFromUrl(prUrl) : null
  const terminal = presentation.terminal
  // Peak: the delivery arrived at review (a PR exists and awaits the person).
  const showArrival = Boolean(prUrl) && (decision === 'pr_draft' || decision === 'pr_ready')
  // The server's detail is English git/gh text: localized line first, the raw text behind a disclosure.
  const statusDetail = localizeStatusDetail(envelope.statusDetail, t('prCard.failed.generic'))
  const statusLabel = isKnownPrDeliveryStatusCode(envelope.statusCode)
    ? t(`common:prDeliveryStatus.${envelope.statusCode}`)
    : null
  const partialCreatePending = presentation.partial && presentation.deliverableCount > 0 && (
    decision === 'on_review' || (decision === 'pr_draft' && !prUrl)
  )


  const openPr = (e: React.MouseEvent, url: string) => {
    if (canOpenWebView) {
      e.preventDefault()
      e.stopPropagation()
      openWebView(url)
    }
  }

  // Ticket refs rendered as the same clickable chips agent messages use —
  // the user asked for the spec NUMBERS to be visible on the card itself.
  const ticketChips = envelope.ticketIds.length > 0 && (
    <>
      {envelope.ticketIds.map((id) => (
        <AgentRefChip
          key={id}
          refTarget={{ kind: 'ticket', ticketId: id }}
          onOpen={(ref) => void openRef(envelope.projectId, ref)}
        >
          #{id}
        </AgentRefChip>
      ))}
    </>
  )

  // Per-run "View log" chips (runIds land right after allocation, in ticket
  // order; a single all-scope run covers every ticket). Visible in EVERY state:
  // live vitals while building, frozen totals on settled/terminal cards.
  // Defensive ?? []: coercePrDecisionEnvelope always fills runIds, but a card
  // handed an untyped legacy object must degrade to "no chips", never crash.
  const runIds = envelope.runIds ?? []
  const runTicketLabel = (i: number): string | null => {
    if (runIds.length === 1 && envelope.ticketIds.length > 1) {
      return envelope.ticketIds.map((id) => `#${id}`).join(' ')
    }
    return envelope.ticketIds[i] != null ? `#${envelope.ticketIds[i]}` : null
  }
  const pausedRunId = runIds.find((rid) => pausedRuns[rid]?.paused) ?? null
  const pausedReason = pausedRunId ? pausedRuns[pausedRunId]?.pausedReason ?? null : null
  const pausedOnBudget = pausedRunId ? pausedRuns[pausedRunId]?.budgetPaused === true : false
  // The question (or approval) the paused run waits on: answered right on this card.
  const pausedQuestion = pausedRunId ? pausedRuns[pausedRunId]?.question ?? null : null
  const runChips = runIds.length > 0 && (
    // Inline in the card's chip row (display: contents), not a row of its own.
    <div className="contents" data-testid="pr-run-log-chips">
      {runIds.map((rid, i) => (
        <RunLogChip
          key={rid}
          projectId={envelope.projectId}
          runId={rid}
          ticketLabel={runTicketLabel(i)}
          live={decision === 'building'}
          onOpen={setLogRunId}
          onVitals={onChipVitals}
          onSnapshot={onRunVitals}
        />
      ))}
    </div>
  )
  const buildingPaused = decision === 'building' && pausedRunId !== null
  const pausedRunLabel = pausedRunId ? runTicketLabel(runIds.indexOf(pausedRunId)) ?? pausedRunId.slice(0, 8) : null
  // A pause that awaits the person (a question or an approval) is answered in
  // the run's log. Any other pause (an interruption, an app restart) resumes
  // here: from the interrupted step when one must be re-run, else as is.
  const pausedLive = pausedRunId && liveRun?.runId === pausedRunId && !liveRun.pendingQuestion && !liveRun.pendingApproval
    && (liveRun.recoverableSteps.length > 0 || liveRun.canResume) ? liveRun : null
  const pausedResumeStep = pausedLive?.recoverableSteps.length ? pausedLive.nextStep : null

  // ── mission-rail-cards: recovery + relaunch actions ──────────────────────
  // Rendered wherever the run needs a decision (failed / stalled / run-only).
  // Every button disables while ANY action is in flight and re-enables from
  // the next runtime poll / envelope broadcast — no optimistic state.
  const runStatus = deriveMissionRunStatus(envelope, liveRun, pausedRunId !== null)
  // The run strip shows what this card knows; reported on change only.
  const summaryStep = liveRun?.nextStep ?? envelope.runtime?.currentStep ?? null
  const summaryPausedReason = pausedReason
  const summaryStalled = liveRun?.status === 'stalled'
  // A question waits on the person exactly like an approval: the strip says it needs them.
  const summaryApproval = Boolean(liveRun?.pendingApproval) || pausedQuestion !== null
  useEffect(() => {
    onSummary?.({ step: summaryStep, paused: pausedRunId !== null, pausedReason: summaryPausedReason, stalled: summaryStalled, pendingApproval: summaryApproval })
  }, [onSummary, summaryStep, pausedRunId, summaryPausedReason, summaryStalled, summaryApproval])
  const buttons = useRunActionButtons({ envelope, conversationId, runtime, liveRun, actionableRun, runStatus, flowOutcome, busy, controls })
  const section = useRunDiagnosisSection({
    envelope, runFailure, runStatus, flowSpecRun: buttons.flowSpecRun, runtime, actionableRun, busy,
    relaunchBlocked: buttons.relaunchBlocked, relaunching: controls.relaunching, runtimeBusy: buttons.runtimeBusy,
    relaunch: controls.relaunch, setLogRunId, anyBusyRef,
  })
  // Live CI of the open PR(s), read from GitHub whether or not a CI loop ran.
  // "PR ready" only means "not a draft": the CI decides whether it is mergeable.
  const ciLive = usePrCiStatus(envelope.projectId, envelope.prDeliveryId,
    (decision === 'pr_draft' || decision === 'pr_ready') && (!!prUrl || hasRepositoryDeliveries), envelope.updatedAt ?? null)
  // A merge conflict blocks the merge even with green checks: it always wins.
  const ciShown: 'green' | 'red' | 'pending' | 'conflict' | null = ciLive && (ciLive.state === 'green' || ciLive.state === 'red' || ciLive.state === 'pending' || ciLive.state === 'conflict')
    ? ciLive.state
    : envelope.statusCode === 'ci_green' ? 'green' : envelope.statusCode === 'ci_needs_attention' ? 'red' : null
  const runtimeError = FEATURE_MISSION_RAIL_CARDS && runtime.error && runtimeInterest ? (
    <p className="mt-1 text-label text-destructive" data-testid="mission-run-runtime-error">{runtime.error}</p>
  ) : null
  const phaseLine = FEATURE_MISSION_RAIL_CARDS && liveRun?.nextStep ? (
    <span className="inline-flex min-w-0 items-center gap-1 truncate text-label text-muted-foreground" data-testid="mission-run-phase">
      <Activity className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
      <span className="truncate">{liveRun.nextStep}</span>
    </span>
  ) : null

  // Mounted by BOTH render branches (building early-return + settled card).
  const logModal = logRunId && (
    <Suspense fallback={null}>
      <JobDetailModal jobId={logRunId} projectId={envelope.projectId} onClose={() => setLogRunId(null)} />
    </Suspense>
  )

  return {
    t, embedded, envelope, conversationId, decision, prUrl, prState,
    inRouterContext, projectName, confirmLayer, isStackedHead,
    runOnly, runFailure, runtime, runtimeInterest, liveRun, actionableRun,
    cardRef, flash, flashClass, focusRegion,
    hasRepositoryDeliveries, presentation, RunCardActions,
    flowOutcome, returnedAfterFailure, flowFailureView,
    interruptedOperationDetail, recoveredInterruptedOperation,
    degradedDraft, existingPrContinuation, displayedPrNumber, terminal, showArrival,
    statusDetail, statusLabel, partialCreatePending,
    openPr, ticketChips, runChips, setLogRunId,
    pausedRunId, pausedReason, pausedOnBudget, pausedQuestion, buildingPaused, pausedRunLabel, pausedLive, pausedResumeStep,
    runStatus, ciLive, ciShown, runtimeError, phaseLine, logModal,
    actions, confirms, controls, ci, buttons, section,
  }
}

export type PrDecisionCardModel = ReturnType<typeof usePrDecisionCardModel>
