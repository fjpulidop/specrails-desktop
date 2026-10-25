/**
 * Review packet page (nontech-review-experience Wave 2).
 *
 * The surface a non-technical person decides on. Deliberately an INVERTED
 * PYRAMID: the verdict, the confidence and the three verbs sit above the fold,
 * because this reader's real budget is a few seconds — the five sections are
 * progressive disclosure underneath, not a wall to wade through first.
 *
 * Two rules the layout enforces:
 *  · Proof is grouped BY SOURCE and labelled, so the agent's own report can
 *    never be mistaken for something Specrails measured.
 *  · A state the three verbs cannot describe honestly renders the existing
 *    fine-grained controls instead (see packet-verbs' fineControlOnly).
 */
import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { useStackedHeadDeliveryIds } from '../../builder/hooks/useMilestoneProgress'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle, ArrowLeft, Ban, Check, ChevronDown, ChevronRight,
  CircleDollarSign, FileDiff, GitPullRequest, History, Loader2, MessageSquare, RefreshCw, SendHorizontal, ShieldCheck, Sparkles,
} from 'lucide-react'
import { getApiBase } from '../../../lib/api'
import { Button } from '../../../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { useDesktop } from '../../../hooks/useDesktop'
import { useRailPrDecisions } from '../context/RailPrDecisionContext'
import { useTicketDetailModal } from '../../specs/context/TicketDetailModalContext'
import { RepositoryDeliveries } from '../components/RepositoryDeliveries'
import { PacketMarkdown } from '../components/review-packet/PacketMarkdown'
import { AgentActionsSummary } from '../components/review-packet/AgentActionsSummary'
import { WhatToLookAt } from '../components/review-packet/WhatToLookAt'
import { PacketDerivation } from '../components/review-packet/PacketDerivation'
import { RequirementsDemonstrated } from '../components/review-packet/RequirementsDemonstrated'
import { PacketBaseline } from '../components/review-packet/PacketBaseline'
import { NeedsHumanEyes } from '../components/review-packet/NeedsHumanEyes'
import { ChangesTab } from '../components/review-packet/ChangesTab'
import { coerceRailPrStateSnapshot, derivePrDeliveryPresentation } from '../lib/pr-delivery'
import { packetVerbAction, resolvePacketVerbs, type PacketVerb } from '../lib/packet-verbs'
import { notifyGitChanged } from '../../code/lib/git-refresh'
import type {
  AcceptCapability, PacketProofItem, PacketTicketSection, ProofTier, ReviewPacket, ReviewPacketResponse,
} from '../../../types'
import { formatUsd } from '../../../lib/format-usd'

const TIER_ORDER: ProofTier[] = ['app-verified', 'ai-reported', 'reviewer-score']

const TIER_ICON: Record<ProofTier, typeof ShieldCheck> = {
  'app-verified': ShieldCheck,
  'ai-reported': Sparkles,
  'reviewer-score': FileDiff,
}

/** Semantic accents only — app-measured reads trustworthy, AI-reported reads soft. */
const TIER_ACCENT: Record<ProofTier, string> = {
  'app-verified': 'text-accent-success border-accent-success/30 bg-accent-success/5',
  'ai-reported': 'text-accent-highlight border-accent-highlight/30 bg-accent-highlight/5',
  'reviewer-score': 'text-accent-info border-accent-info/30 bg-accent-info/5',
}

function ProofRow({ item }: { item: PacketProofItem }) {
  const { t } = useTranslation('packet')
  return (
    <li className="flex flex-col gap-1 py-1.5">
      <span className="text-sm text-foreground">
        {t(item.code, { ...(item.values ?? {}), defaultValue: item.code })}
      </span>
      {item.rawExcerpt ? (
        <pre className="max-h-32 overflow-auto rounded border border-border/60 bg-background-deep/60 p-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {item.rawExcerpt}
        </pre>
      ) : null}
    </li>
  )
}

/** Durable per-unit outcome → one honest word. Never inferred from prose. */
function outcomeKey(section: PacketTicketSection): 'succeeded' | 'failed' | 'noChanges' | 'notStarted' | 'unknown' {
  if (section.implementationOutcome === 'failed') return 'failed'
  if (section.deliveryOutcome === 'no_changes' || (section.implementationOutcome === 'succeeded' && section.changed === false)) return 'noChanges'
  if (section.deliveryOutcome === 'not_started') return 'notStarted'
  if (section.implementationOutcome === 'succeeded') return 'succeeded'
  return 'unknown'
}

const FOLLOW_UP_PILL: Record<'resolved' | 'partial' | 'blocked' | 'unreported', string> = {
  resolved: 'border-accent-success/40 bg-accent-success/10 text-accent-success',
  partial: 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning',
  blocked: 'border-destructive/40 bg-destructive/10 text-destructive',
  unreported: 'border-border bg-background-deep/50 text-muted-foreground',
}

const OUTCOME_PILL: Record<ReturnType<typeof outcomeKey>, string> = {
  succeeded: 'border-accent-success/40 bg-accent-success/10 text-accent-success',
  noChanges: 'border-accent-info/40 bg-accent-info/10 text-accent-info',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  notStarted: 'border-border bg-background-deep/50 text-muted-foreground',
  unknown: 'border-border bg-background-deep/50 text-muted-foreground',
}

function Section({
  title, children, defaultOpen = false, badge,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
  badge?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border border-border/60 bg-surface/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="flex-1 text-sm font-medium text-foreground">{title}</span>
        {badge}
      </button>
      {open ? <div className="border-t border-border/60 px-4 py-3">{children}</div> : null}
    </div>
  )
}

interface ReviewPacketPageProps {
  /** Embedded use (Mission-mode modal): the delivery to show, else the route param. */
  prDeliveryId?: string
  /** Embedded use: "Back to the board" closes the host instead of routing. */
  onClose?: () => void
}

/** Radix Select forbids an empty item value; this sentinel means "all repositories". */
const ALL_REPOSITORIES = '__all__'

export default function ReviewPacketPage(props: ReviewPacketPageProps = {}) {
  const params = useParams<{ prDeliveryId: string }>()
  const prDeliveryId = props.prDeliveryId ?? params.prDeliveryId
  const { t } = useTranslation(['packet', 'common'])
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const repositoryId = searchParams.get('repositoryId')
  const tab: 'overview' | 'changes' = searchParams.get('tab') === 'changes' ? 'changes' : 'overview'
  const requestRevision = useRef(0)
  const goBack = props.onClose ?? (() => navigate('/'))
  const { activeProjectId } = useDesktop()
  const stackedHeads = useStackedHeadDeliveryIds(activeProjectId)
  const isStackedHead = prDeliveryId ? stackedHeads.has(prDeliveryId) : false
  const { act, checkout } = useRailPrDecisions()
  const { openTicketDetail } = useTicketDetailModal()

  const scopeKey = JSON.stringify([activeProjectId, prDeliveryId, repositoryId])
  const scopeRef = useRef({ key: scopeKey, epoch: 0 })
  if (scopeRef.current.key !== scopeKey) scopeRef.current = { key: scopeKey, epoch: scopeRef.current.epoch + 1 }
  const scopeEpoch = scopeRef.current.epoch
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  const isCurrentScope = useCallback(() => mountedRef.current && scopeRef.current.key === scopeKey && scopeRef.current.epoch === scopeEpoch, [scopeKey, scopeEpoch])
  const [loaded, setLoaded] = useState<{ key: string; epoch: number; data: ReviewPacketResponse | null; loading: boolean; error: string | null } | null>(null)
  // A response is evidence for exactly one project, generation and repository.
  // Hide it synchronously on a scope change, before the next effect can run.
  const currentLoaded = loaded?.key === scopeKey && loaded.epoch === scopeEpoch ? loaded : null
  const data = currentLoaded?.data ?? null
  const loading = currentLoaded?.loading ?? true
  const error = currentLoaded?.error ?? null
  const [pending, setPending] = useState<PacketVerb | null>(null)
  const [confirmIrreversible, setConfirmIrreversible] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [revisionNote, setRevisionNote] = useState('')
  const [revising, setRevising] = useState(false)
  const [revisionError, setRevisionError] = useState<string | null>(null)
  const [askingChanges, setAskingChanges] = useState(false)

  const load = useCallback(async () => {
    // An old action may finish after the user changes scope. Its captured load
    // must not even invalidate the newer scope's in-flight request.
    if (!prDeliveryId || !activeProjectId || !isCurrentScope()) return
    const revision = ++requestRevision.current
    const requestIsCurrent = () => isCurrentScope() && requestRevision.current === revision
    setLoaded((previous) => ({ key: scopeKey, epoch: scopeEpoch,
      data: previous?.key === scopeKey && previous.epoch === scopeEpoch ? previous.data : null,
      loading: true, error: null }))
    try {
      const query = repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : ''
      const res = await fetch(`${getApiBase()}/rails/pr-deliveries/${prDeliveryId}/packet${query}`)
      if (!requestIsCurrent()) return
      if (!res.ok) {
        setLoaded({ key: scopeKey, epoch: scopeEpoch, data: null, loading: false, error: res.status === 404 ? 'notFound' : 'loadFailed' })
        return
      }
      const next = await res.json() as ReviewPacketResponse
      if (!requestIsCurrent()) return
      setLoaded({ key: scopeKey, epoch: scopeEpoch, data: next, loading: false, error: null })
    } catch {
      if (!requestIsCurrent()) return
      setLoaded({ key: scopeKey, epoch: scopeEpoch, data: null, loading: false, error: 'loadFailed' })
    }
  }, [prDeliveryId, activeProjectId, repositoryId, scopeKey, scopeEpoch, isCurrentScope])

  useEffect(() => {
    void load()
    setConfirmIrreversible(false); setAskingChanges(false); setPending(null)
    setActionError(null); setRevisionError(null); setRevising(false); setRevisionNote('')
    return () => { requestRevision.current++ }
  }, [load])
  const delivery = useMemo(() => coerceRailPrStateSnapshot(data?.snapshot), [data?.snapshot])

  const packet: ReviewPacket | null = data?.packet ?? null
  const operationBusy = loading || pending !== null || revising || !!delivery?.operation
  const capability: AcceptCapability | null = data?.acceptCapability ?? null

  const verbs = useMemo(() => {
    if (!packet) return null
    const presentation = derivePrDeliveryPresentation({
      decision: packet.decision,
      ticketIds: packet.ticketIds,
      prState: packet.prUrl ? 'pr-created' : 'none',
      statusCode: packet.statusCode,
      prUrl: packet.prUrl,
      runIds: packet.runIds,
    })
    return resolvePacketVerbs({
      decision: packet.decision,
      presentation,
      prUrl: packet.prUrl,
      canCreatePr: capability?.target === 'create-pr',
    })
  }, [packet, capability])

  const runVerb = useCallback(async (verb: PacketVerb) => {
    if (!packet || !verbs || operationBusy || !isCurrentScope()) return
    const action = packetVerbAction(verb, verbs)
    if (!action) return
    setActionError(null)
    setPending(verb)
    try {
      const result = await (repositoryId && delivery ? act(delivery.railIndex, action, delivery.decision, delivery.prDeliveryId, repositoryId) : act(packet.railIndex, action, packet.decision, packet.prDeliveryId))
      if (!isCurrentScope()) return
      if (!result.ok) {
        setActionError(result.status === 409 && result.error === 'stale_decision' ? 'alreadyResolved' : 'actionFailed')
      } else {
        if (activeProjectId) notifyGitChanged(activeProjectId)
      }
      await load()
    } finally {
      if (isCurrentScope()) { setPending(null); setConfirmIrreversible(false) }
    }
  }, [act, activeProjectId, load, packet, verbs, delivery, repositoryId, operationBusy, isCurrentScope])

  /**
   * "Ask for changes" launches Quick SDD against THIS
   * generation. The server re-validates the exemption, so a raced decision (the
   * delivery was just accepted elsewhere) fails closed with a clear message
   * rather than appending work to branches nobody is reviewing any more.
   */
  const submitRevision = useCallback(async () => {
    if (!packet || !revisionNote.trim() || !activeProjectId || operationBusy || !isCurrentScope()) return
    setRevisionError(null)
    setRevising(true)
    try {
      const res = await fetch(`${getApiBase()}/rails/${packet.railIndex}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          loopId: 'factory:sdd-quick-openspec',
          revisionOfDeliveryId: delivery?.prDeliveryId ?? packet.prDeliveryId,
          revisionNote: revisionNote.trim(),
          ...(delivery?.executionManifest ? { repositoryIds: delivery.executionManifest.selectedRepositoryIds } : {}),
        }),
      })
      if (!isCurrentScope()) return
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        if (!isCurrentScope()) return
        setRevisionError(body?.error === 'invalid_revision_target' ? 'revisionStale' : body?.error === 'daily_budget_exceeded' ? 'revisionBudget' : 'revisionFailed')
        return
      }
      // The note is preserved until the launch is accepted, so a failure never
      // loses what the user typed.
      setRevisionNote('')
      setAskingChanges(false)
      const launched = await res.json().catch(() => null) as { prDeliveryId?: string } | null
      if (!isCurrentScope()) return
      if (launched?.prDeliveryId && launched.prDeliveryId !== prDeliveryId) {
        if (props.onClose) props.onClose()
        else navigate(`/review/${encodeURIComponent(launched.prDeliveryId)}`)
      } else await load()
    } catch {
      if (isCurrentScope()) setRevisionError('revisionFailed')
    } finally {
      if (isCurrentScope()) setRevising(false)
    }
  }, [activeProjectId, load, packet, revisionNote, delivery, operationBusy, isCurrentScope, prDeliveryId, props.onClose, navigate])

  if (loading && !packet) {
    return (
      <div role="status" className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
        {t('common:states.loading')}
      </div>
    )
  }

  if (error || !packet || !verbs) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 p-10 text-center">
        <AlertTriangle className="size-6 text-accent-warning" aria-hidden />
        <p className="text-sm text-muted-foreground">
          {t(error === 'notFound' ? 'error.notFound' : 'error.loadFailed')}
        </p>
        <div className="flex items-center gap-2">
          {error !== 'notFound' && (
            <Button type="button" onClick={() => void load()} className="gap-1.5">
              <RefreshCw className="size-3.5" aria-hidden />
              {t('common:actions.retry')}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={goBack}>
            {t('backToBoard')}
          </Button>
        </div>
      </div>
    )
  }

  const proofByTier = TIER_ORDER
    .map((tier) => ({ tier, items: packet.proof.filter((item) => item.tier === tier) }))
    .filter((group) => group.items.length > 0)

  // Baseline-on-touch spend, reported apart (only when every baseline reported a cost).
  const baselineCosts = (packet.baseline ?? []).map((entry) => entry.cost?.costUsd ?? null)
  const baselineCostUsd = baselineCosts.length > 0 && baselineCosts.every((value) => value !== null)
    ? baselineCosts.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null
  const costLabel = packet.cost.totalUsd === null
    ? '—'
    : `${packet.cost.estimated ? '~' : ''}${formatUsd(packet.cost.totalUsd)}`

  // Rendered inside the App shell's <main> (route) or a modal, so the page is a
  // labelled <article> rather than a second <main> landmark. The article keeps ONE width for both tabs
  // (switching tabs must not move the header); only the Overview panel is held to a reading measure.
  return (
    <article aria-labelledby="review-packet-headline" className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
      <button
        type="button"
        onClick={goBack}
        className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {t('backToBoard')}
      </button>

      {delivery?.repositoryDeliveries?.length ? <>
        <div className="flex items-center gap-2 text-xs">
          <span id="review-packet-repository-label">{t('common:repositories.select')}</span>
          <Select
            value={repositoryId ?? ALL_REPOSITORIES}
            onValueChange={(value) => {
              const next = new URLSearchParams(searchParams)
              if (value !== ALL_REPOSITORIES) next.set('repositoryId', value)
              else next.delete('repositoryId')
              setSearchParams(next, { replace: true })
            }}
          >
            <SelectTrigger aria-labelledby="review-packet-repository-label" className="h-7 w-auto min-w-[10rem] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_REPOSITORIES}>{t('common:repositories.all')}</SelectItem>
              {delivery.repositoryDeliveries.map((repository) => (
                <SelectItem key={repository.repositoryId} value={repository.repositoryId}>{repository.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <RepositoryDeliveries deliveryId={delivery.prDeliveryId} repositories={delivery.repositoryDeliveries} busy={operationBusy}
          onAct={async (action, id) => {
            if (operationBusy || !isCurrentScope()) return
            setPending('accept')
            try {
              const result = await act(delivery.railIndex, action, delivery.decision, delivery.prDeliveryId, id)
              if (!isCurrentScope()) return
              if (!result.ok) setActionError('actionFailed')
              await load()
            } finally { if (isCurrentScope()) setPending(null) }
          }}
          onCheckout={async (id) => {
            if (operationBusy || !isCurrentScope()) return
            setPending('accept')
            try {
              const result = await checkout(delivery.railIndex, delivery.prDeliveryId, id)
              if (!isCurrentScope()) return
              if (!result.ok) setActionError('actionFailed')
              await load()
            } finally { if (isCurrentScope()) setPending(null) }
          }} />
      </> : null}

      {/* ── Above the fold: verdict, confidence, decision ──────────────────── */}
      <div className="rounded-xl border border-border/70 bg-surface/60 p-5 shadow-sm">
        <h1 id="review-packet-headline" className="text-lg font-semibold text-foreground">
          {t(packet.headlineCode, {
            count: packet.totalCount,
            succeeded: packet.succeededCount,
            total: packet.totalCount,
            defaultValue: t('headline.generic'),
          })}
        </h1>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {packet.confidence?.overall !== null && packet.confidence?.overall !== undefined ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-accent-info/30 bg-accent-info/10 px-2 py-0.5 text-accent-info"
              title={t('confidence.tooltip')}
            >
              {t('confidence.pill', { overall: packet.confidence.overall })}
            <span className="sr-only"> ({t('confidence.tooltip')})</span></span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background-deep/50 px-2 py-0.5 text-muted-foreground">
              {t('confidence.unavailable')}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <CircleDollarSign className="size-3.5" aria-hidden />
            {t('cost.thisBuild', { amount: costLabel })}
            {baselineCostUsd !== null ? (
              <span className="text-muted-foreground" data-testid="packet-cost-baseline">{t('cost.baselinePart', { amount: formatUsd(baselineCostUsd) })}</span>
            ) : null}
          </span>
          {packet.prUrl ? (
            <a
              href={packet.prUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent-info hover:underline"
            >
              <GitPullRequest className="size-3.5" aria-hidden />
              {t('openPr', { number: packet.prNumber ?? '' })}
            </a>
          ) : null}
        </div>

        {verbs.fineControlOnly ? (
          <p className="mt-4 rounded-md border border-accent-warning/30 bg-accent-warning/5 px-3 py-2 text-xs text-accent-warning">
            {t('fineControlOnly')}
          </p>
        ) : verbs.inFlight ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t('stillWorking')}
          </p>
        ) : verbs.terminal ? (
          <p className="mt-4 text-sm text-muted-foreground">{t('alreadyResolved')}</p>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {verbs.verbs.includes('accept') && (!delivery?.repositoryDeliveries?.length || repositoryId) ? (
              confirmIrreversible ? (
                <div className="flex w-full flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                  <p className="text-xs text-foreground">{t('accept.irreversibleWarning')}</p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => void runVerb('accept')}
                      disabled={operationBusy}
                      className="text-sm"
                      data-testid="packet-accept-confirm"
                    >
                      {t('accept.irreversibleConfirm')}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setConfirmIrreversible(false)}
                      className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground"
                    >
                      {t('common:actions.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  onClick={() => {
                    if (verbs.requiresIrreversibleConfirm) setConfirmIrreversible(true)
                    else void runVerb('accept')
                  }}
                  disabled={operationBusy}
                  className="gap-1.5 text-sm bg-accent-success text-background hover:bg-accent-success/90"
                  data-testid="packet-accept"
                >
                  {pending === 'accept' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
                  {t(`accept.${verbs.acceptMeaning ?? 'generic'}`)}
                </Button>
              )
            ) : null}

            {verbs.verbs.includes('request-changes') ? (
              <button
                type="button"
                onClick={() => setAskingChanges((v) => !v)}
                disabled={operationBusy || revising}
                aria-expanded={askingChanges}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-surface disabled:opacity-50"
                data-testid="packet-request-changes"
              >
                <MessageSquare className="size-4" aria-hidden />
                {t('requestChanges.label')}
              </button>
            ) : null}

            {verbs.verbs.includes('discard') ? (
              <button
                type="button"
                onClick={() => setConfirmDiscard(true)}
                disabled={operationBusy}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-surface disabled:opacity-50"
                data-testid="packet-discard"
              >
                {pending === 'discard' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Ban className="size-4" aria-hidden />}
                {t('discard.label')}
              </button>
            ) : null}
          </div>
        )}

        {isStackedHead && verbs.verbs.includes('discard') ? (
          <p className="mt-3 rounded-md border border-accent-warning/40 bg-accent-warning/10 px-3 py-2 text-xs text-accent-warning" data-testid="packet-discard-stacked-note">
            {t('discard.stackedNote')}
          </p>
        ) : null}
        {actionError ? (
          <p className="mt-3 text-xs text-accent-warning">{t(`error.${actionError}`)}</p>
        ) : null}

        <ConfirmDialog
          open={confirmDiscard}
          onOpenChange={setConfirmDiscard}
          title={t('discard.confirmTitle')}
          description={
            <>
              {t('discard.confirmBody')}
              {isStackedHead ? <span className="mt-2 block">{t('discard.stackedNote')}</span> : null}
            </>
          }
          confirmLabel={t('discard.label')}
          busy={operationBusy}
          onConfirm={() => {
            setConfirmDiscard(false)
            void runVerb('discard')
          }}
        />

        {askingChanges ? (
          <div className="mt-4 flex flex-col gap-2 rounded-md border border-border/70 bg-background-deep/40 p-3">
            <label htmlFor="packet-revision-note" className="text-label text-foreground">
              {t('requestChanges.prompt')}
            </label>
            <textarea
              id="packet-revision-note"
              value={revisionNote}
              onChange={(e) => setRevisionNote(e.target.value)}
              rows={2}
              placeholder={t('requestChanges.placeholder')}
              className="resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
              data-testid="packet-revision-input"
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="default"
                onClick={() => void submitRevision()}
                disabled={operationBusy || revisionNote.trim().length === 0}
                className="gap-1.5 text-sm"
                data-testid="packet-revision-submit"
              >
                {revising ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <SendHorizontal className="size-4" aria-hidden />}
                {t('requestChanges.submit')}
              </Button>
              {/* No duration promise: nothing measured yet for revision runs. */}
              <span className="text-xs text-muted-foreground">{t('requestChanges.hint')}</span>
            </div>
            {revisionError ? (
              <p className="text-xs text-accent-warning">{t(`error.${revisionError}`)}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ── Overview / Changes: the packet's two views of the same delivery ─── */}
      <div role="tablist" aria-label={t('tabs.label')} className="flex gap-1 border-b border-border/60" data-testid="packet-tabs">
        {(['overview', 'changes'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`packet-tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`packet-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => {
              const next = new URLSearchParams(searchParams)
              if (value === 'changes') next.set('tab', 'changes'); else next.delete('tab')
              setSearchParams(next, { replace: true })
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
              event.preventDefault()
              const next = new URLSearchParams(searchParams)
              if (value === 'overview') next.set('tab', 'changes'); else next.delete('tab')
              setSearchParams(next, { replace: true })
              requestAnimationFrame(() => document.getElementById(`packet-tab-${value === 'overview' ? 'changes' : 'overview'}`)?.focus())
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-label ${tab === value ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t(`tabs.${value}`)}
          </button>
        ))}
      </div>

      <div id="packet-panel-changes" role="tabpanel" aria-labelledby="packet-tab-changes" hidden={tab !== 'changes'}>
        <ChangesTab
          prDeliveryId={delivery?.prDeliveryId ?? packet.prDeliveryId}
          repositoryId={repositoryId}
          active={tab === 'changes'}
          tickets={packet.ticketIds.map((ticketId) => { const title = packet.sections.find((section) => section.ticketId === ticketId)?.title; return { ticketId, label: title ? `#${ticketId} ${title}` : `#${ticketId}` } })}
        />
      </div>

      <div id="packet-panel-overview" role="tabpanel" aria-labelledby="packet-tab-overview" className={tab === 'changes' ? 'hidden' : 'mx-auto flex w-full max-w-3xl flex-col gap-4'} data-testid="packet-overview-panel">
      {/* ── What to look at: the reviewer's risk brief, first after the verdict.
          Absent for runs without a brief, so older packets read as before. */}
      {packet.whatToLookAt ? (
        <WhatToLookAt brief={packet.whatToLookAt} multiTicket={packet.ticketIds.length > 1} />
      ) : null}

      {/* ── Needs human eyes: the project's human-only rules (rules inventory) */}
      {packet.needsHumanEyes?.length ? <NeedsHumanEyes rules={packet.needsHumanEyes} /> : null}

      {/* ── Requirements demonstrated X/Y (spec trace) ─────────────────────── */}
      {packet.requirementsDemonstrated ? (
        <RequirementsDemonstrated section={packet.requirementsDemonstrated} multiTicket={packet.ticketIds.length > 1} />
      ) : null}

      {/* ── Spec created where the work passed (baseline on touch) ─────────── */}
      {packet.baseline?.length ? <PacketBaseline entries={packet.baseline} multiTicket={packet.ticketIds.length > 1} /> : null}

      {packet.driftNudges.length > 0 ? (
        <div className="rounded-lg border border-accent-highlight/30 bg-accent-highlight/5 p-4" data-testid="packet-drift-nudges">
          <h2 className="mb-1 text-sm font-medium text-accent-highlight">{t('drift.title')}</h2>
          <ul className="space-y-1 text-xs text-foreground">
            {packet.driftNudges.map((nudge) => (
              <li key={nudge.code}>{t(nudge.code, { ...nudge.values, defaultValue: nudge.code })}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">{t('drift.advisory')}</p>
        </div>
      ) : null}

      {packet.versions.length > 1 ? (
        <Section
          title={t('versions.title', { count: packet.versions.length })}
          badge={<History className="size-3.5 text-muted-foreground" aria-hidden />}
        >
          <ol className="space-y-2" data-testid="packet-versions">
            {packet.versions.map((version) => (
              <li key={version.prDeliveryId} className="flex flex-col gap-0.5 text-sm">
                <span className="flex items-center gap-2">
                  <span className={version.current ? 'font-medium text-foreground' : 'text-muted-foreground'}>
                    {t('versions.label', { version: version.version })}
                  </span>
                  {version.current ? (
                    <span data-chip="" className="inline-flex h-5 items-center rounded-full border border-accent-primary/40 bg-accent-primary/10 px-1.5 text-caption text-accent-primary">
                      {t('versions.current')}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {version.costUsd === null ? '—' : `${version.costEstimated ? '~' : ''}${formatUsd(version.costUsd)}`}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {version.revisionNote ?? t('versions.originalBuild')}
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">
            {t('cost.allVersions', {
              amount: packet.chainCostUsd === null
                ? '—'
                : `${packet.chainCostEstimated ? '~' : ''}${formatUsd(packet.chainCostUsd)}`,
            })}
          </p>
        </Section>
      ) : null}

      {/* ── Derivation (Flow -> Spec): coverage before what to watch out for ─── */}
      {packet.derivation ? <PacketDerivation derivation={packet.derivation} settlement={packet.flowSettlement} /> : null}

      {/* ── What to watch out for: real signals only, never boilerplate ─────── */}
      {packet.watchOut.length > 0 ? (
        <div className="rounded-lg border border-accent-warning/30 bg-accent-warning/5 p-4">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-accent-warning">
            <AlertTriangle className="size-4" aria-hidden />
            {t('watchOut.title')}
          </h2>
          <ul className="space-y-1">
            {packet.watchOut.map((item, index) => <ProofRow key={`${item.code}-${index}`} item={item} />)}
          </ul>
        </div>
      ) : null}

      {/* ── Progressive disclosure ──────────────────────────────────────────── */}
      <Section title={t('sections.whatYouAsked')} defaultOpen>
        <ul className="space-y-3">
          {packet.sections.map((section) => (
            <li key={section.ticketId} className="text-sm">
              <button
                type="button"
                onClick={() => openTicketDetail(section.ticketId)}
                className="text-accent-primary hover:underline"
              >
                #{section.ticketId} {section.title ?? ''}
              </button>
              {section.problem ? (
                <PacketMarkdown muted className="mt-1">{section.problem}</PacketMarkdown>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      {packet.followUp && (
        <Section title={t('followUp.title', { count: packet.followUp.comments.length })} defaultOpen>
          <p className="mb-2 text-xs text-muted-foreground">{t('followUp.caveat')}</p>
          <ul className="space-y-3" data-testid="packet-follow-up">
            {packet.followUp.comments.map((comment) => {
              const report = packet.followUpReport?.find((line) => line.commentId === comment.id) ?? null
              const verdictKey = report ? report.verdict : 'unreported'
              return (
                <li key={comment.id} className="rounded-md border border-border/50 bg-background-deep/30 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span data-chip="" className="inline-flex h-5 items-center rounded bg-surface/70 px-1 font-mono text-caption text-muted-foreground">{comment.id}</span>
                    {comment.path ? <span className="font-mono text-xs text-accent-info">{comment.path}{comment.line ? `:${comment.line}` : ''}</span> : null}
                    <span data-chip="" className={`inline-flex h-5 items-center rounded-full border px-2 text-caption font-medium ${FOLLOW_UP_PILL[verdictKey]}`} data-testid="packet-follow-up-verdict">
                      {t(`followUp.verdict.${verdictKey}`)}
                    </span>
                    <span className="text-xs text-muted-foreground">{t(`followUp.source.${comment.source === 'github' ? 'github' : 'pasted'}`)}{comment.author ? ` · ${comment.author}` : ''}</span>
                  </div>
                  <PacketMarkdown muted className="mt-1">{comment.body}</PacketMarkdown>
                  {report ? (
                    <dl className="mt-1 grid gap-x-3 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-[auto_1fr]">
                      {report.files ? <><dt className="font-medium">{t('followUp.files')}</dt><dd className="font-mono">{report.files}</dd></> : null}
                      {report.tests ? <><dt className="font-medium">{t('followUp.tests')}</dt><dd>{report.tests}</dd></> : null}
                      {report.notes ? <><dt className="font-medium">{t('followUp.notes')}</dt><dd>{report.notes}</dd></> : null}
                    </dl>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">{t('followUp.noReport')}</p>
                  )}
                </li>
              )
            })}
          </ul>
          {packet.followUp.scope.excludedChanges.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground"><span className="font-medium">{t('followUp.excluded')}:</span> {packet.followUp.scope.excludedChanges.join(' · ')}</p>
          )}
        </Section>
      )}

      {packet.specAddenda && packet.specAddenda.length > 0 && (
        <Section title={t('addenda.title', { count: packet.specAddenda.length })} defaultOpen>
          <p className="mb-2 text-xs text-muted-foreground">{t('addenda.caveat')}</p>
          <ul className="space-y-2" data-testid="packet-addenda">
            {packet.specAddenda.map((entry) => {
              const report = packet.specAddendaReport?.find((line) => line.addendumId === entry.id) ?? null
              const verdictKey = report ? report.verdict : 'unreported'
              const pill = verdictKey === 'applied' ? FOLLOW_UP_PILL.resolved : FOLLOW_UP_PILL[verdictKey]
              return (
                <li key={entry.id} className="rounded-md border border-border/50 bg-background-deep/30 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-accent-primary">#{entry.ticketId}</span>
                    <span data-chip="" className="inline-flex h-5 items-center rounded-full border border-border/50 px-1.5 text-caption text-muted-foreground">{t(`addenda.kind.${entry.kind}`)}</span>
                    <span className="font-medium">{entry.title}</span>
                    <span data-chip="" className={`inline-flex h-5 items-center rounded-full border px-2 text-caption font-medium ${pill}`} data-testid="packet-addenda-verdict">
                      {t(`addenda.verdict.${verdictKey}`)}
                    </span>
                  </div>
                  {report ? (
                    <dl className="mt-1 grid gap-x-3 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-[auto_1fr]">
                      {report.files ? <><dt className="font-medium">{t('followUp.files')}</dt><dd className="font-mono">{report.files}</dd></> : null}
                      {report.tests ? <><dt className="font-medium">{t('followUp.tests')}</dt><dd>{report.tests}</dd></> : null}
                      {report.notes ? <><dt className="font-medium">{t('followUp.notes')}</dt><dd>{report.notes}</dd></> : null}
                    </dl>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">{t('addenda.noReport')}</p>
                  )}
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      <Section title={t('sections.whatIDid')}>
        <ul className="space-y-3">
          {packet.sections.map((section) => (
            <li key={section.ticketId} className="text-sm" data-testid={`packet-done-${section.ticketId}`}>
              {/* Facts first: the durable outcome + measured churn. The spec's
                  proposed solution is NOT what was done — it is shown below,
                  collapsed and labelled as the plan (honesty contract). */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">#{section.ticketId}</span>
                {section.title ? <span className="text-foreground/80">{section.title}</span> : null}
                {(() => { const key = outcomeKey(section); return (
                  <span data-chip="" className={`inline-flex h-5 items-center rounded-full border px-2 text-caption font-medium ${OUTCOME_PILL[key]}`} data-testid="packet-outcome-pill">
                    {t(`outcome.${key}`)}
                  </span>
                ) })()}
              </div>
              {section.churn ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('churn.line', {
                    files: section.churn.filesTouched,
                    added: section.churn.addedLines,
                    removed: section.churn.removedLines,
                  })}
                  {' · '}
                  {section.churn.testFilesTouched.length > 0
                    ? t('churn.testFiles', { count: section.churn.testFilesTouched.length })
                    : t('churn.noTestFiles')}
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">{t('churn.batchNotSplittable')}</p>
              )}
              {section.solution ? (
                <details className="group mt-2 rounded-md border border-border/50 bg-background-deep/30 px-3 py-2">
                  <summary className="cursor-pointer select-none text-label text-muted-foreground group-open:text-foreground/80">
                    {t('planned.title')}
                  </summary>
                  <p className="mt-1 text-xs italic text-muted-foreground">{t('planned.caveat')}</p>
                  <PacketMarkdown className="mt-2">{section.solutionOverflow ?? section.solution}</PacketMarkdown>
                </details>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">{t('noSolutionRecorded')}</p>
              )}
            </li>
          ))}
        </ul>
      </Section>

      {packet.agentActions && packet.agentActions.total > 0 ? (
        <Section
          title={t('sections.whatTheAgentDid')}
          badge={(
            <span data-chip="" className="inline-flex h-5 items-center rounded-full border border-border bg-background-deep/50 px-2 text-caption tabular-nums text-muted-foreground">
              {t('agentActions.total', { count: packet.agentActions.total })}
            </span>
          )}
        >
          <AgentActionsSummary actions={packet.agentActions} />
        </Section>
      ) : null}

      <Section
        title={t('sections.howItWasChecked')}
        badge={packet.evidenceUnavailable ? (
          <span data-chip="" className="inline-flex h-5 items-center rounded-full border border-border bg-background-deep/50 px-2 text-caption text-muted-foreground">
            {t('proof.evidenceUnavailable')}
          </span>
        ) : undefined}
      >
        <div className="space-y-4">
          {proofByTier.map(({ tier, items }) => {
            const Icon = TIER_ICON[tier]
            return (
              <div key={tier} className={`rounded-md border px-3 py-2 ${TIER_ACCENT[tier]}`}>
                <h3 className="mb-1 flex items-center gap-1.5 text-label">
                  <Icon className="size-3.5" aria-hidden />
                  {t(`tier.${tier}.title`)}
                </h3>
                <p className="mb-2 text-xs opacity-80">{t(`tier.${tier}.caveat`)}</p>
                <ul className="space-y-1">
                  {items.map((item, index) => <ProofRow key={`${item.code}-${index}`} item={item} />)}
                </ul>
              </div>
            )
          })}
        </div>
      </Section>
      </div>
    </article>
  )
}
