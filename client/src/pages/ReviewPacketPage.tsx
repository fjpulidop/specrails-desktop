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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStackedHeadDeliveryIds } from '../hooks/useMilestoneProgress'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle, ArrowLeft, Ban, Check, ChevronDown, ChevronRight,
  CircleDollarSign, FileDiff, GitPullRequest, History, Loader2, MessageSquare, SendHorizontal, ShieldCheck, Sparkles,
} from 'lucide-react'
import { getApiBase } from '../lib/api'
import { useDesktop } from '../hooks/useDesktop'
import { useRailPrDecisions } from '../context/RailPrDecisionContext'
import { useTicketDetailModal } from '../context/TicketDetailModalContext'
import { derivePrDeliveryPresentation } from '../lib/pr-delivery'
import { packetVerbAction, resolvePacketVerbs, type PacketVerb } from '../lib/packet-verbs'
import { notifyGitChanged } from '../lib/git-refresh'
import type {
  AcceptCapability, PacketProofItem, ProofTier, ReviewPacket, ReviewPacketResponse,
} from '../types'

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
        <pre className="max-h-32 overflow-auto rounded border border-border/60 bg-background-deep/60 p-2 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {item.rawExcerpt}
        </pre>
      ) : null}
    </li>
  )
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

export default function ReviewPacketPage(props: ReviewPacketPageProps = {}) {
  const params = useParams<{ prDeliveryId: string }>()
  const prDeliveryId = props.prDeliveryId ?? params.prDeliveryId
  const { t } = useTranslation(['packet', 'common'])
  const navigate = useNavigate()
  const goBack = props.onClose ?? (() => navigate('/'))
  const { activeProjectId } = useDesktop()
  const stackedHeads = useStackedHeadDeliveryIds(activeProjectId)
  const isStackedHead = prDeliveryId ? stackedHeads.has(prDeliveryId) : false
  const { act } = useRailPrDecisions()
  const { openTicketDetail } = useTicketDetailModal()

  const [data, setData] = useState<ReviewPacketResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PacketVerb | null>(null)
  const [confirmIrreversible, setConfirmIrreversible] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [revisionNote, setRevisionNote] = useState('')
  const [revising, setRevising] = useState(false)
  const [revisionError, setRevisionError] = useState<string | null>(null)
  const [askingChanges, setAskingChanges] = useState(false)

  const load = useCallback(async () => {
    if (!prDeliveryId || !activeProjectId) return
    setLoading(true)
    try {
      const res = await fetch(`${getApiBase()}/rails/pr-deliveries/${prDeliveryId}/packet`)
      if (!res.ok) {
        setError(res.status === 404 ? 'notFound' : 'loadFailed')
        setData(null)
        return
      }
      setData(await res.json() as ReviewPacketResponse)
      setError(null)
    } catch {
      setError('loadFailed')
    } finally {
      setLoading(false)
    }
  }, [prDeliveryId, activeProjectId])

  useEffect(() => { void load() }, [load])

  const packet: ReviewPacket | null = data?.packet ?? null
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
    if (!packet || !verbs) return
    const action = packetVerbAction(verb, verbs)
    if (!action) return
    setActionError(null)
    setPending(verb)
    try {
      const result = await act(packet.railIndex, action, packet.decision, packet.prDeliveryId)
      if (!result.ok) {
        setActionError(result.status === 409 ? 'alreadyResolved' : 'actionFailed')
      } else {
        if (activeProjectId) notifyGitChanged(activeProjectId)
      }
      await load()
    } finally {
      setPending(null)
      setConfirmIrreversible(false)
    }
  }, [act, activeProjectId, load, packet, verbs])

  /**
   * "Ask for changes" launches the Architect-less revision loop against THIS
   * generation. The server re-validates the exemption, so a raced decision (the
   * delivery was just accepted elsewhere) fails closed with a clear message
   * rather than appending work to branches nobody is reviewing any more.
   */
  const submitRevision = useCallback(async () => {
    if (!packet || !revisionNote.trim() || !activeProjectId) return
    setRevisionError(null)
    setRevising(true)
    try {
      const res = await fetch(`${getApiBase()}/rails/${packet.railIndex}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revisionOfDeliveryId: packet.prDeliveryId,
          revisionNote: revisionNote.trim(),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        setRevisionError(body?.error === 'invalid_revision_target' ? 'revisionStale' : 'revisionFailed')
        return
      }
      // The note is preserved until the launch is accepted, so a failure never
      // loses what the user typed.
      setRevisionNote('')
      setAskingChanges(false)
      await load()
    } catch {
      setRevisionError('revisionFailed')
    } finally {
      setRevising(false)
    }
  }, [activeProjectId, load, packet, revisionNote])

  if (loading && !packet) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
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
        <button
          type="button"
          onClick={goBack}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-surface"
        >
          {t('backToBoard')}
        </button>
      </div>
    )
  }

  const proofByTier = TIER_ORDER
    .map((tier) => ({ tier, items: packet.proof.filter((item) => item.tier === tier) }))
    .filter((group) => group.items.length > 0)

  const costLabel = packet.cost.totalUsd === null
    ? '—'
    : `${packet.cost.estimated ? '~' : ''}$${packet.cost.totalUsd.toFixed(2)}`

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <button
        type="button"
        onClick={goBack}
        className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {t('backToBoard')}
      </button>

      {/* ── Above the fold: verdict, confidence, decision ──────────────────── */}
      <div className="rounded-xl border border-border/70 bg-surface/60 p-5 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">
          {t(packet.headlineCode, {
            count: packet.totalCount,
            succeeded: packet.succeededCount,
            total: packet.totalCount,
            defaultValue: packet.headlineCode,
          })}
        </h1>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {packet.confidence?.overall !== null && packet.confidence?.overall !== undefined ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-accent-info/30 bg-accent-info/10 px-2 py-0.5 text-accent-info"
              title={t('confidence.tooltip')}
            >
              {t('confidence.pill', { overall: packet.confidence.overall })}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background-deep/50 px-2 py-0.5 text-muted-foreground">
              {t('confidence.unavailable')}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <CircleDollarSign className="size-3.5" aria-hidden />
            {t('cost.thisBuild', { amount: costLabel })}
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
            {verbs.verbs.includes('accept') ? (
              confirmIrreversible ? (
                <div className="flex w-full flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                  <p className="text-xs text-foreground">{t('accept.irreversibleWarning')}</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void runVerb('accept')}
                      disabled={pending !== null}
                      className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      data-testid="packet-accept-confirm"
                    >
                      {t('accept.irreversibleConfirm')}
                    </button>
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
                <button
                  type="button"
                  onClick={() => {
                    if (verbs.requiresIrreversibleConfirm) setConfirmIrreversible(true)
                    else void runVerb('accept')
                  }}
                  disabled={pending !== null}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent-success px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  data-testid="packet-accept"
                >
                  {pending === 'accept' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
                  {t(`accept.${verbs.acceptMeaning ?? 'generic'}`)}
                </button>
              )
            ) : null}

            {verbs.verbs.includes('request-changes') ? (
              <button
                type="button"
                onClick={() => setAskingChanges((v) => !v)}
                disabled={pending !== null || revising}
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
                onClick={() => void runVerb('discard')}
                disabled={pending !== null}
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

        {askingChanges ? (
          <div className="mt-4 flex flex-col gap-2 rounded-md border border-border/70 bg-background-deep/40 p-3">
            <label htmlFor="packet-revision-note" className="text-xs font-medium text-foreground">
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
              <button
                type="button"
                onClick={() => void submitRevision()}
                disabled={revising || revisionNote.trim().length === 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                data-testid="packet-revision-submit"
              >
                {revising ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <SendHorizontal className="size-4" aria-hidden />}
                {t('requestChanges.submit')}
              </button>
              {/* No duration promise: nothing measured yet for revision runs. */}
              <span className="text-[11px] text-muted-foreground">{t('requestChanges.hint')}</span>
            </div>
            {revisionError ? (
              <p className="text-xs text-accent-warning">{t(`error.${revisionError}`)}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {packet.driftNudges.length > 0 ? (
        <div className="rounded-lg border border-accent-highlight/30 bg-accent-highlight/5 p-4" data-testid="packet-drift-nudges">
          <h2 className="mb-1 text-sm font-medium text-accent-highlight">{t('drift.title')}</h2>
          <ul className="space-y-1 text-xs text-foreground">
            {packet.driftNudges.map((nudge) => (
              <li key={nudge.code}>{t(nudge.code, { ...nudge.values, defaultValue: nudge.code })}</li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted-foreground">{t('drift.advisory')}</p>
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
                    <span className="rounded-full border border-accent-primary/40 bg-accent-primary/10 px-1.5 text-[10px] text-accent-primary">
                      {t('versions.current')}
                    </span>
                  ) : null}
                  <span className="text-[11px] text-muted-foreground">
                    {version.costUsd === null ? '—' : `${version.costEstimated ? '~' : ''}$${version.costUsd.toFixed(2)}`}
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
                : `${packet.chainCostEstimated ? '~' : ''}$${packet.chainCostUsd.toFixed(2)}`,
            })}
          </p>
        </Section>
      ) : null}

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
                <p className="mt-1 text-muted-foreground">{section.problem}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t('sections.whatIDid')}>
        <ul className="space-y-3">
          {packet.sections.map((section) => (
            <li key={section.ticketId} className="text-sm">
              <span className="font-medium text-foreground">#{section.ticketId}</span>{' '}
              {section.solution ?? <span className="text-muted-foreground">{t('noSolutionRecorded')}</span>}
              {section.churn ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('churn.line', {
                    files: section.churn.filesTouched,
                    added: section.churn.addedLines,
                    removed: section.churn.removedLines,
                  })}
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">{t('churn.batchNotSplittable')}</p>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title={t('sections.howItWasChecked')}
        badge={packet.evidenceUnavailable ? (
          <span className="rounded-full border border-border bg-background-deep/50 px-2 py-0.5 text-[10px] text-muted-foreground">
            {t('proof.evidenceUnavailable')}
          </span>
        ) : undefined}
      >
        <div className="space-y-4">
          {proofByTier.map(({ tier, items }) => {
            const Icon = TIER_ICON[tier]
            return (
              <div key={tier} className={`rounded-md border px-3 py-2 ${TIER_ACCENT[tier]}`}>
                <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                  <Icon className="size-3.5" aria-hidden />
                  {t(`tier.${tier}.title`)}
                </h3>
                <p className="mb-2 text-[11px] opacity-80">{t(`tier.${tier}.caveat`)}</p>
                <ul className="space-y-1">
                  {items.map((item, index) => <ProofRow key={`${item.code}-${index}`} item={item} />)}
                </ul>
              </div>
            )
          })}
        </div>
      </Section>
    </div>
  )
}
