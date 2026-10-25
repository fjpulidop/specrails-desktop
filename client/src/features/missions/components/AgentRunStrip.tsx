// ─── The mission's run strip ──────────────────────────────────────────────────
// ONE strip above the composer is the single live representation of a
// mission's runs: the deliveries it launched (mission-rail-cards), its
// undecided launch proposals and the runs an extension owns (Flow). It shows
// one run at a time — the most urgent (waiting for you › failed › running ›
// paused) unless the person picked another in the switcher — as a status mark,
// the current step in plain words, progress, elapsed time and billed cost.
// A primary action appears only when the run needs the person. The run's card
// DECLARES it (run-primary.tsx: id, label, kind, handler). A `local` action
// (Resume, Back to Flow) runs in one click, in place; an `outward` one (Create
// PR, Publish, Reopen, Approve, Relaunch, Retry delivery, Launch) is never
// fired from here: the strip opens the panel with focus on the card's own
// control.
//
// The strip never swaps the run it shows while the person uses it (panel open,
// focus inside, a run picked in the switcher). A run that starts needing the
// person meanwhile is marked in the switcher ("needs you") and announced.
// Only an idle strip follows urgency on its own.
//
// Clicking the strip opens the run's full card as a panel anchored ABOVE the
// strip, over the conversation (not a modal: Esc or a click in the
// conversation closes it, focus returns to the strip). The cards stay mounted
// while hidden: they measure the run (live step, vitals) the strip shows.
// State changes are announced politely.
//
// Keyboard (run-strip-keys.ts), scoped to this mission: ⌥R jumps here (again:
// details), ⌥[ / ⌥] switch runs outside text fields, Esc returns to where ⌥R
// came from, ←/→ move along the switcher, and a row control may claim a
// letter while the strip has focus (`data-strip-key`, Flow's P and H).

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { useReducedMotion } from '../../../hooks/useReducedMotion'
import { AlertTriangle, BellRing, ChevronUp, Info, Pause } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { keyboardLabel } from '../../../lib/keyboard-label'
import { formatRunElapsed } from '../../jobs/hooks/useRunVitals'
import type { AgentPrDecisionEnvelope } from '../lib/agent-api'
import { useAgentChat } from '../context/AgentChatContext'
import { modeAccent, useMissionExtensions, useMissionLiveRuns, type MissionLiveRun, type MissionModeBadge, type MissionPanelCloseReason } from '../context/MissionExtensionsContext'
import { AgentPrDecisionCard } from './AgentPrDecisionCard'
import { AgentRailLaunchCard } from './AgentRailLaunchCard'
import type { PinnedPrCard } from './agent-pr-pinning'
import {
  FOCUS_PR_CARD_EVENT, OPEN_RUN_STRIP_EVENT, focusInConversation, focusMatchesCard, focusPrCard,
  type FocusPrCardDetail, type OpenRunStripDetail,
} from './agent-run-failure'
import {
  deliveryRunKey, deliveryRunTone, formatRunCost, heldStripKey, urgencyRank, humanizeStepId, missionRunTotals, newlyUrgentKey, pickStripRun,
  proposalRunKey, readStripPick, urgencyOfTone, writeStripPick,
  type MissionRunCardSummary, type MissionRunTone, type MissionRunUrgency, type MissionRunVitalsSnapshot,
} from './mission-run-strip'
import { bestRunPrimary, PRIMARY_ACTION, RunPrimaryScope, type RunPrimaryAction, type RunPrimaryRegistry } from './run-primary'
import { isTextEntry, registerRunStrip, RUN_STRIP_ARIA_KEYS, RUN_STRIP_KEYS, stripKeyCode } from './run-strip-keys'
import type { PinnedRailProposal } from './useRailLaunchProposals'
import { LiveDot } from '../../../components/ui/live-dot'

/** The strip's primary action style (the shared primary recipe) — extensions reuse it. */
export const RUN_STRIP_PRIMARY = PRIMARY_ACTION

/** A quiet control inside the strip (switcher, overflow). Type rule: strip
 *  text and controls are 12px; only compact chips/pills may stay 11px (≥/70). */
const QUIET_CONTROL =
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-label text-muted-foreground transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50'

interface StripEntry {
  key: string
  label: string
  tone: MissionRunTone
  urgency: MissionRunUrgency
  /** Running without current activity: no pulse. */
  quiet: boolean
  /** The run's mode (extension runs, Flow): its mark while running. */
  mode: MissionModeBadge | null
  headline: ReactNode
  /** The headline as text (announcements, switcher titles). */
  headlineText: string
  meta: ReactNode | null
  controls: ReactNode | null
  /** The run may offer a primary action (its card declares which one). */
  wantsPrimary: boolean
  panel: ReactNode | null
  autoOpenToken: string | null
  /** The person closed this run's panel (extension runs). */
  onPanelClose: ((reason: MissionPanelCloseReason) => void) | null
  attributes: Readonly<Record<string, string>>
  announcement: string | null
  match: { prDeliveryId: string; runIds: readonly string[] } | null
  source: 'delivery' | 'proposal' | 'extension'
}

const MARK_CLASS = 'h-3.5 w-3.5 shrink-0'

/** The state's own shape (never color alone). */
function StateGlyph({ tone, quiet, className }: { tone: MissionRunTone; quiet: boolean; className: string }) {
  if (tone === 'launching') return <LiveDot tone="muted" size="sm" className={cn(className, 'h-2 w-2')} aria-hidden />
  if (tone === 'decision') return <BellRing className={cn(className, 'text-accent-primary')} aria-hidden />
  if (tone === 'failed') return <AlertTriangle className={cn(className, 'text-destructive')} aria-hidden />
  if (tone === 'paused') return <Pause className={cn(className, 'text-accent-warning')} aria-hidden />
  if (tone === 'info') return <Info className={cn(className, 'text-muted-foreground')} aria-hidden />
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center', className)} aria-hidden>
      <LiveDot tone="info" pulsing={!quiet} />
    </span>
  )
}

/** The status mark: a shape per state, never color alone. A run of an
 *  extension's mode (Flow) keeps the mode's icon in the mode's color in every
 *  state; outside running the state's shape sits on it as a small badge. */
function StatusMark({ tone, quiet, mode }: { tone: MissionRunTone; quiet: boolean; mode: MissionModeBadge | null }) {
  if (mode?.icon) {
    const Icon = mode.icon
    const running = tone === 'running'
    return (
      <span className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" style={{ color: modeAccent(mode) }} data-testid="mission-run-strip-mode-mark" data-tone={tone} aria-hidden>
        <Icon className={cn('h-3.5 w-3.5', running && !quiet && 'motion-safe:animate-pulse')} aria-hidden />
        {!running && (
          <span className="absolute -bottom-1 -right-1 inline-flex h-2.5 w-2.5 items-center justify-center rounded-full bg-card" data-testid="mission-run-strip-state-badge">
            <StateGlyph tone={tone} quiet={quiet} className="h-2 w-2" />
          </span>
        )}
      </span>
    )
  }
  return <StateGlyph tone={tone} quiet={quiet} className={MARK_CLASS} />
}

/** The switcher's small state mark: the same shape per state as the strip mark (never color alone). */
function ToneDot({ tone }: { tone: MissionRunTone }) {
  return <StateGlyph tone={tone} quiet className="h-3 w-3 shrink-0" />
}

/** A run that started needing the person while another was shown: a dot AND words. */
function NeedsYouMark() {
  const { t } = useTranslation('agent')
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-medium text-accent-primary" data-testid="mission-run-strip-needs-you">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-primary" />
      {t('runStrip.needsYou')}
    </span>
  )
}

function Dot() {
  return <span aria-hidden className="text-muted-foreground">·</span>
}

/** Launching: the data slots exist but have nothing yet. */
function MetaSkeleton() {
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="mission-run-strip-skeleton" aria-hidden>
      <span className="h-2 w-8 rounded-full bg-foreground/10 motion-safe:animate-pulse" />
      <span className="h-2 w-10 rounded-full bg-foreground/10 motion-safe:animate-pulse" />
    </span>
  )
}

export interface AgentRunStripProps {
  conversationId: string
  projectId: string | null
  inline: boolean
  /** Live deliveries in message order (newest last) — `derivePrCards().pinned`. */
  deliveries?: readonly PinnedPrCard[]
  /** Undecided launch proposals in message order. */
  proposals?: readonly PinnedRailProposal[]
}

export function AgentRunStrip({ conversationId, projectId, inline, deliveries = [], proposals = [] }: AgentRunStripProps) {
  const { t } = useTranslation('agent')
  const reduced = useReducedMotion()
  const { describeRun, ConversationDock, useRunAttention } = useMissionExtensions()
  // The extension derives its runs' attention app-wide: the strip leaves it be.
  const attentionOwnedElsewhere = !!useRunAttention
  const extensionRuns = useMissionLiveRuns({ conversationId, projectId, inline })
  const { reportRunAttention } = useAgentChat()

  // What the hidden cards measured: their live summary and each run's vitals.
  const [summaries, setSummaries] = useState<ReadonlyMap<string, MissionRunCardSummary>>(new Map())
  const [vitals, setVitals] = useState<ReadonlyMap<string, ReadonlyMap<string, MissionRunVitalsSnapshot>>>(new Map())
  const summaryHandlers = useRef(new Map<string, (summary: MissionRunCardSummary) => void>())
  const vitalsHandlers = useRef(new Map<string, (runId: string, snapshot: MissionRunVitalsSnapshot) => void>())
  const summaryHandler = useCallback((key: string) => {
    let handler = summaryHandlers.current.get(key)
    if (!handler) {
      handler = (summary) => setSummaries((current) => {
        const before = current.get(key)
        if (before && before.step === summary.step && before.paused === summary.paused && before.pausedReason === summary.pausedReason
          && before.stalled === summary.stalled && before.pendingApproval === summary.pendingApproval) return current
        return new Map(current).set(key, summary)
      })
      summaryHandlers.current.set(key, handler)
    }
    return handler
  }, [])
  const vitalsHandler = useCallback((key: string) => {
    let handler = vitalsHandlers.current.get(key)
    if (!handler) {
      handler = (runId, snapshot) => setVitals((current) => {
        const runs = current.get(key)
        const before = runs?.get(runId)
        if (before && before.running === snapshot.running && before.loaded === snapshot.loaded && before.status === snapshot.status
          && before.elapsedMs === snapshot.elapsedMs && before.costUsd === snapshot.costUsd) return current
        const nextRuns = new Map(runs ?? []).set(runId, snapshot)
        return new Map(current).set(key, nextRuns)
      })
      vitalsHandlers.current.set(key, handler)
    }
    return handler
  }, [])

  const deliveryEntry = useCallback((card: PinnedPrCard): StripEntry => {
    const envelope: AgentPrDecisionEnvelope = card.envelope
    const key = deliveryRunKey(envelope.prDeliveryId)
    const summary = summaries.get(key) ?? null
    const tone = deliveryRunTone(envelope, summary)
    const label = envelope.railName || t('prCard.rail', { index: envelope.railIndex + 1 })
    const loopId = envelope.loopId ?? null
    let headlineText: string
    if (tone === 'launching') {
      headlineText = t('runStrip.launching', { rail: label })
    } else if (tone === 'running') {
      const described = summary?.step ? describeRun?.(t, { loopId, stepId: summary.step, codes: [] })?.step ?? null : null
      headlineText = described ?? (summary?.step ? humanizeStepId(summary.step) : t('runStrip.running'))
    } else if (tone === 'paused') {
      headlineText = summary?.pausedReason ? t('runStrip.pausedReason', { reason: summary.pausedReason }) : t('runStrip.paused')
    } else if (tone === 'info') {
      headlineText = t(`runStrip.decision.${envelope.decision}`, { defaultValue: t('runStrip.decision.generic') })
    } else if (tone === 'decision') {
      headlineText = summary?.pendingApproval || envelope.runtime?.pendingApproval
        ? t('runStrip.decision.approval')
        : envelope.statusCode === 'review_changes_requested'
          ? t('runStrip.decision.changes')
          : t(`runStrip.decision.${envelope.decision}`, { defaultValue: t('runStrip.decision.generic') })
    } else {
      const failure = envelope.runtime?.failure ?? null
      const stepId = failure?.stepId ?? summary?.step ?? null
      const codes = [envelope.statusCode, failure?.code, ...(envelope.units ?? []).map((unit) => unit.failureCode)]
      const described = describeRun?.(t, { loopId, stepId, codes })?.failure ?? null
      const code = failure?.code ?? (summary?.stalled ? 'stalled' : envelope.statusCode)
        ?? (envelope.decision === 'implementation_failed' || envelope.decision === 'pr_failed' ? envelope.decision : null)
      headlineText = described ?? (code ? t(`runStrip.failed.${code}`, { defaultValue: '' }) : '') ?? ''
      if (!headlineText) headlineText = t('runStrip.failed.generic')
    }
    const totals = missionRunTotals(envelope.runIds ?? [], vitals.get(key))
    const meta = tone === 'launching' ? <MetaSkeleton /> : (
      <>
        {/* Each figure: the short visible form, and its words for screen readers
            (a generic span cannot carry an accessible name). */}
        {totals.progress && (
          <span data-testid="mission-run-strip-progress">
            <span aria-hidden>{totals.progress.done}/{totals.progress.total}</span>
            <span className="sr-only">{t('runStrip.progressAria', { done: totals.progress.done, total: totals.progress.total })}</span>
          </span>
        )}
        {totals.progress && <Dot />}
        <span data-testid="mission-run-strip-elapsed">
          {totals.elapsedMs !== null ? (
            <>
              <span aria-hidden>{formatRunElapsed(totals.elapsedMs)}</span>
              <span className="sr-only">{t('prCard.runElapsedAria', { elapsed: formatRunElapsed(totals.elapsedMs) })}</span>
            </>
          ) : <span aria-hidden>—</span>}
        </span>
        <Dot />
        <span data-testid="mission-run-strip-cost" title={totals.costPartial ? t('runStrip.costPartial') : t('runStrip.costTitle')}>
          <span aria-hidden>{totals.costUsd !== null ? `${formatRunCost(totals.costUsd)}${totals.costPartial ? '*' : ''}` : '—'}</span>
          <span className="sr-only">
            {totals.costUsd !== null ? t('prCard.runCostAria', { cost: formatRunCost(totals.costUsd) }) : t('runStrip.costNone')}
            {totals.costUsd !== null && !totals.costPartial ? ` (${t('runStrip.costTitle')})` : ''}
          </span>
          {/* The `*` is said in words too, not only in a tooltip. */}
          {totals.costPartial && <span className="sr-only" data-testid="mission-run-strip-cost-partial"> ({t('runStrip.costPartial')})</span>}
        </span>
      </>
    )
    const needsPerson = tone === 'decision' || tone === 'failed' || tone === 'paused'
    return {
      key, label, tone, urgency: urgencyOfTone(tone), quiet: false, mode: null,
      headline: headlineText, headlineText, meta, controls: null,
      wantsPrimary: needsPerson,
      panel: (
        <AgentPrDecisionCard
          envelope={envelope}
          conversationId={conversationId}
          embedded
          onSummary={summaryHandler(key)}
          onRunVitals={vitalsHandler(key)}
        />
      ),
      autoOpenToken: null,
      onPanelClose: null,
      attributes: { 'data-pr-delivery-id': envelope.prDeliveryId },
      announcement: `${label}: ${t(`runStrip.state.${tone}`)} ${headlineText}`,
      match: { prDeliveryId: envelope.prDeliveryId, runIds: envelope.runIds ?? [] },
      source: 'delivery',
    }
  }, [summaries, vitals, t, describeRun, conversationId, summaryHandler, vitalsHandler])

  const entries = useMemo<StripEntry[]>(() => {
    const list: StripEntry[] = []
    for (const p of proposals) {
      const tickets = p.proposal.ticketIds.map((id) => `#${id}`).join(' ')
      const headlineText = tickets ? t('runStrip.proposal', { tickets }) : t('runStrip.proposalNoTickets')
      list.push({
        key: proposalRunKey(p.messageId, p.proposalIndex),
        label: t('runStrip.proposalLabel'),
        tone: 'decision', urgency: 'decision', quiet: false, mode: null,
        headline: headlineText, headlineText, meta: null, controls: null,
        wantsPrimary: true,
        panel: (
          <AgentRailLaunchCard
            proposal={p.proposal}
            proposalIndex={p.proposalIndex}
            messageId={p.messageId}
            conversationId={conversationId}
            projectId={projectId}
            intent={null}
            compact
          />
        ),
        autoOpenToken: null,
        onPanelClose: null,
        attributes: {},
        announcement: `${t('runStrip.proposalLabel')}: ${headlineText}`,
        match: null,
        source: 'proposal',
      })
    }
    for (const card of deliveries) list.push(deliveryEntry(card))
    for (const run of extensionRuns) {
      const yielded = run.yieldsTo && deliveries.some((card) => focusMatchesCard(
        { prDeliveryId: run.yieldsTo?.prDeliveryId ?? null, runIds: [...(run.yieldsTo?.runIds ?? [])] },
        { prDeliveryId: card.envelope.prDeliveryId, runIds: card.envelope.runIds },
      ))
      if (yielded) continue
      list.push(extensionEntry(run))
    }
    return list
  }, [proposals, deliveries, extensionRuns, deliveryEntry, conversationId, projectId, t])
  const entriesRef = useRef(entries)
  entriesRef.current = entries

  // An extension's run that waits for the person (decision or failure) feeds
  // the mission list's attention dot like a delivery does; a calm state (the
  // Flow's "Ready to turn into a PR") does not. Deliveries report from their
  // envelopes (deliveryNeedsPerson), so only extension runs are reported here,
  // and only for an extension WITHOUT an app-wide source (`useRunAttention`,
  // Flow's): that source stays live while the mission is closed, which a
  // strip cannot (it reports only while mounted).
  const reported = useRef(new Map<string, string>())
  const attentionSignature = attentionOwnedElsewhere ? '' : entries.filter((entry) => entry.source === 'extension')
    .map((entry) => `${entry.key}=${entry.urgency === 'decision' || entry.urgency === 'failed' ? entry.urgency : 0}`).join('|')
  useEffect(() => {
    if (!reportRunAttention) return
    const now = new Map<string, boolean | 'decision' | 'failed'>()
    if (!attentionOwnedElsewhere) {
      for (const entry of entriesRef.current) {
        if (entry.source === 'extension') now.set(entry.key, entry.urgency === 'decision' || entry.urgency === 'failed' ? entry.urgency : false)
      }
    }
    for (const [key, owner] of reported.current) {
      if (owner === conversationId && !now.has(key)) reportRunAttention(conversationId, key, false)
    }
    reported.current = new Map()
    for (const [key, needs] of now) {
      reportRunAttention(conversationId, key, needs)
      reported.current.set(key, conversationId)
    }
  }, [attentionSignature, attentionOwnedElsewhere, conversationId, reportRunAttention])

  // ── Which run shows ───────────────────────────────────────────────────────────
  // The person's pick (switcher), the open panel and focus inside the strip
  // each HOLD the shown run; with none of them the strip is idle and shows the
  // most urgent run.
  const [pick, setPick] = useState<string | null>(() => readStripPick(conversationId))
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  useEffect(() => { setPick(readStripPick(conversationId)); setOpenKey(null); setFocusKey(null) }, [conversationId])
  const choose = useCallback((key: string | null) => {
    writeStripPick(conversationId, key)
    setPick(key)
  }, [conversationId])
  const liveKeys = entries.map((entry) => entry.key)
  const held = heldStripKey(liveKeys, { pick, open: openKey, focus: focusKey })
  const selected = pickStripRun(entries, held)

  // Runs that started needing the person while the strip was held on another.
  const [needsYou, setNeedsYou] = useState<ReadonlySet<string>>(() => new Set())
  const [needsYouNotice, setNeedsYouNotice] = useState<{ key: string; seq: number } | null>(null)
  const urgencies = useRef(new Map<string, MissionRunUrgency>())
  const urgencySignature = entries.map((entry) => `${entry.key}=${entry.urgency}`).join('|')
  useEffect(() => {
    const newly = newlyUrgentKey(urgencies.current, entries)
    urgencies.current = new Map(entries.map((entry) => [entry.key, entry.urgency]))
    setNeedsYou((current) => {
      const next = new Set([...current].filter((key) => entries.some((entry) => entry.key === key && (entry.urgency === 'decision' || entry.urgency === 'failed'))))
      if (newly && held && newly !== selected?.key) next.add(newly)
      return next.size === current.size && [...next].every((key) => current.has(key)) ? current : next
    })
    if (newly && held && newly !== selected?.key) setNeedsYouNotice((n) => ({ key: newly, seq: (n?.seq ?? 0) + 1 }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the signature
  }, [urgencySignature])
  // Showing a marked run clears its mark.
  const selectedKey = selected?.key ?? null
  useEffect(() => {
    if (!selectedKey) return
    setNeedsYou((current) => {
      if (!current.has(selectedKey)) return current
      const next = new Set(current)
      next.delete(selectedKey)
      return next
    })
  }, [selectedKey])

  // ── Primary actions: what each run's card declares (run-primary.tsx) ──────────
  const declared = useRef(new Map<string, Map<symbol, RunPrimaryAction>>())
  const registries = useRef(new Map<string, RunPrimaryRegistry>())
  const [, setPrimaryVersion] = useState(0)
  const registryFor = useCallback((key: string): RunPrimaryRegistry => {
    let registry = registries.current.get(key)
    if (!registry) {
      const bump = (): void => setPrimaryVersion((n) => n + 1)
      registry = {
        set: (owner, action) => {
          let actions = declared.current.get(key)
          if (!actions) { actions = new Map(); declared.current.set(key, actions) }
          const before = actions.get(owner)
          actions.set(owner, action)
          if (!before || before.id !== action.id || before.label !== action.label || before.kind !== action.kind
            || before.rank !== action.rank || before.disabled !== action.disabled) bump()
        },
        remove: (owner) => {
          if (declared.current.get(key)?.delete(owner)) bump()
        },
      }
      registries.current.set(key, registry)
    }
    return registry
  }, [])
  const primaryOf = (key: string): RunPrimaryAction | null => bestRunPrimary(declared.current.get(key)?.values() ?? [])

  // ── Panel ─────────────────────────────────────────────────────────────────────
  const open = openKey !== null
  const panelId = useId()
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const panelsRef = useRef<HTMLDivElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const panelOpen = open && !!selected?.panel
  const [focusPanel, setFocusPanel] = useState(0)
  const [pendingOutward, setPendingOutward] = useState<string | null>(null)
  const [pendingFocus, setPendingFocus] = useState<FocusPrCardDetail | null>(null)

  const openPanel = useCallback((key: string, focus = true) => {
    setOpenKey(key)
    if (focus) setFocusPanel((n) => n + 1)
  }, [])
  const closePanel = useCallback((restoreFocus: boolean) => {
    setOpenKey(null)
    if (restoreFocus) toggleRef.current?.focus()
  }, [])

  // Focus moves into the panel when the person opened it.
  useEffect(() => {
    if (!focusPanel || !panelOpen) return
    const frame = requestAnimationFrame(() => {
      try { panelRef.current?.focus({ preventScroll: true }) } catch { panelRef.current?.focus() }
    })
    return () => cancelAnimationFrame(frame)
  }, [focusPanel, panelOpen])

  // Auto-open (the Flow hand-off): once per token.
  const seenTokens = useRef(new Set<string>())
  const tokenSignature = entries.map((entry) => entry.autoOpenToken ?? '').join('|')
  useEffect(() => {
    for (const entry of entries) {
      if (!entry.autoOpenToken || seenTokens.current.has(entry.autoOpenToken)) continue
      seenTokens.current.add(entry.autoOpenToken)
      openPanel(entry.key)
      return
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the tokens
  }, [tokenSignature])

  // The person closed a run's panel: its owner hears it once, with HOW — Esc
  // dismisses (Flow: the hand-off's "Not yet"); a click outside, the toggle or
  // another run only collapses it.
  const previousOpenKey = useRef<string | null>(null)
  const closeReason = useRef<MissionPanelCloseReason>('collapse')
  useEffect(() => {
    const previous = previousOpenKey.current
    previousOpenKey.current = openKey
    const reason = closeReason.current
    closeReason.current = 'collapse'
    if (!previous || previous === openKey) return
    entriesRef.current.find((entry) => entry.key === previous)?.onPanelClose?.(reason)
  }, [openKey])

  // A click in the conversation closes the panel (it is not a modal). Portaled
  // menus and dialogs of the card live outside the surface and never close it.
  useEffect(() => {
    if (!panelOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null
      const strip = stripRef.current
      if (!target || !strip || strip.contains(target)) return
      const surface = strip.closest('[data-mission-surface]')
      if (surface && surface.contains(target)) setOpenKey(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [panelOpen])

  // Space above the strip: the panel never grows past it, so it is never clipped.
  const [maxHeight, setMaxHeight] = useState<number>(420)
  useLayoutEffect(() => {
    if (!panelOpen) return
    const strip = stripRef.current
    const bounds = strip?.parentElement
    if (!strip || !bounds) return
    const measure = (): void => {
      const space = strip.getBoundingClientRect().top - bounds.getBoundingClientRect().top - 12
      setMaxHeight(space > 120 ? space : 420)
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(bounds)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [panelOpen])

  // An outward primary: once its panel shows, focus lands on the card's own control.
  useEffect(() => {
    if (!pendingOutward || !panelOpen) return
    const key = pendingOutward
    const frame = requestAnimationFrame(() => {
      setPendingOutward(null)
      const action = primaryOf(key)
      if (action) action.focus()
      else setFocusPanel((n) => n + 1)
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- primaryOf reads the live registry
  }, [pendingOutward, panelOpen])

  // Focus bus: a history line asks for a run. A live run opens here; the card
  // hears the re-dispatch once visible (scroll, focus, pulse).
  useEffect(() => {
    const onFocus = (event: Event): void => {
      const detail = (event as CustomEvent<FocusPrCardDetail>).detail
      if (!detail || detail.expanded || !focusInConversation(detail, conversationId)) return
      const match = entriesRef.current.find((entry) => entry.match && focusMatchesCard(detail, { prDeliveryId: entry.match.prDeliveryId, runIds: [...entry.match.runIds] }))
      if (!match) return
      openPanel(match.key, false)
      setPendingFocus({ ...detail, prDeliveryId: match.match?.prDeliveryId ?? null, conversationId })
    }
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<OpenRunStripDetail>).detail
      if (!detail || (detail.conversationId && detail.conversationId !== conversationId)) return
      if (entriesRef.current.some((entry) => entry.key === detail.key)) openPanel(detail.key)
    }
    window.addEventListener(FOCUS_PR_CARD_EVENT, onFocus)
    window.addEventListener(OPEN_RUN_STRIP_EVENT, onOpen)
    return () => {
      window.removeEventListener(FOCUS_PR_CARD_EVENT, onFocus)
      window.removeEventListener(OPEN_RUN_STRIP_EVENT, onOpen)
    }
  }, [conversationId, openPanel])
  useEffect(() => {
    if (!pendingFocus) return
    setPendingFocus(null)
    focusPrCard({ ...pendingFocus, expanded: true })
  }, [pendingFocus])

  // ── Announcements (polite): state changes, a run leaving the strip, needs you ──
  const [announcement, setAnnouncement] = useState('')
  // The extension's dock (Flow) speaks through this same region: one voice.
  const announce = useCallback((message: string) => { if (message) setAnnouncement(message) }, [])
  const dock = ConversationDock ? <ConversationDock conversationId={conversationId} projectId={projectId} inline={inline} announce={announce} /> : null
  const announced = useRef<Map<string, { text: string; label: string }> | null>(null)
  const announceSignature = entries.map((entry) => `${entry.key}\u0000${entry.announcement ?? ''}`).join('\u0001')
  useEffect(() => {
    if (!needsYouNotice) return
    const entry = entriesRef.current.find((candidate) => candidate.key === needsYouNotice.key)
    if (entry) setAnnouncement(t('runStrip.announce.needsYou', { run: entry.label }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per notice
  }, [needsYouNotice])
  useEffect(() => {
    const previous = announced.current
    const next = new Map<string, { text: string; label: string }>()
    let message = ''
    for (const entry of entries) {
      if (!entry.announcement) continue
      next.set(entry.key, { text: entry.announcement, label: entry.label })
      if (previous && previous.get(entry.key)?.text !== entry.announcement) message = entry.announcement
    }
    // A run marked "needs you" is announced by its mark, not twice.
    if (message && needsYouNotice && message === next.get(needsYouNotice.key)?.text) message = ''
    if (previous && !message) {
      for (const [key, value] of previous) {
        if (!next.has(key) && key.startsWith('delivery:')) message = t('runStrip.announce.settled', { run: value.label })
      }
    }
    announced.current = next
    if (message) setAnnouncement(message)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the announcements
  }, [announceSignature])

  // The "+N" menu: roving focus (arrows, Home/End), Esc back to its button.
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [menuIndex, setMenuIndex] = useState(0)
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!overflowOpen) return
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    const item = items?.[Math.min(menuIndex, (items?.length ?? 1) - 1)]
    if (item) { try { item.focus({ preventScroll: true }) } catch { item.focus() } }
  }, [overflowOpen, menuIndex])
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOverflowOpen(false)
    if (restoreFocus) moreRef.current?.focus()
  }, [])
  const switchRun = useCallback((key: string) => {
    choose(key)
    setOpenKey((current) => (current ? key : current))
    setOverflowOpen(false)
  }, [choose])

  // ── Keyboard: this mission's strip in the app-wide shortcut layer ─────────────
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const returnFocus = useRef<Element | null>(null)
  const live = useRef({ selectedKey: null as string | null, panelOpen: false })
  live.current = { selectedKey: selected?.key ?? null, panelOpen: open && !!selected?.panel }
  const focusStrip = useCallback(() => {
    const bar = stripRef.current?.querySelector<HTMLElement>('[data-testid="mission-run-strip-bar"]')
    const target = toggleRef.current
      ?? bar?.querySelector<HTMLElement>('button:not([disabled])')
      ?? bar?.querySelector<HTMLElement>('[data-testid="mission-run-strip-summary"]')
    if (target) { try { target.focus({ preventScroll: true }) } catch { target.focus() } }
  }, [])
  useEffect(() => registerRunStrip({
    surface: () => anchorRef.current?.closest('[data-mission-surface]') ?? null,
    hasRuns: () => live.current.selectedKey !== null,
    hasFocus: () => !!stripRef.current && stripRef.current.contains(document.activeElement),
    focus: (from) => {
      returnFocus.current = from && from !== document.body ? from : null
      focusStrip()
    },
    togglePanel: () => {
      const key = live.current.selectedKey
      if (!key) return
      if (live.current.panelOpen) { setOpenKey(null); toggleRef.current?.focus() } else { setOpenKey(key); setFocusPanel((n) => n + 1) }
    },
    cycle: (direction) => {
      const list = entriesRef.current
      if (list.length < 2) return
      const index = list.findIndex((entry) => entry.key === live.current.selectedKey)
      const next = list[(index + direction + list.length) % list.length]
      const hadFocus = !!stripRef.current?.contains(document.activeElement)
      switchRun(next.key)
      setAnnouncement(t('runStrip.announce.shown', { run: next.label, state: next.headlineText }))
      // The bar re-keys on a new run: keep the person's focus in the strip.
      if (hadFocus) requestAnimationFrame(focusStrip)
    },
  }), [focusStrip, switchRun, t])
  if (!selected) {
    // Keyed like the full strip below: the dock and the live region keep their state.
    return (
      <>
        <Fragment key="dock">{dock}</Fragment>
        <div key="announcer" ref={anchorRef} role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="mission-run-strip-announcer">{announcement}</div>
      </>
    )
  }

  // The run's declared primary; a run that needs the person but declares none
  // gets a specific way into its card. While the panel is open its card shows
  // the action itself: no second copy.
  const primary = selected.wantsPrimary ? primaryOf(selected.key) : null
  const fallbackLabel = selected.wantsPrimary && !primary && selected.panel && selected.source !== 'extension'
    ? t(`runStrip.open.${selected.tone}`, { defaultValue: t('runStrip.open.decision') })
    : null
  const showPrimary = !panelOpen && (primary !== null || fallbackLabel !== null)
  const runPrimary = (): void => {
    if (primary?.kind === 'local') { primary.run(); return }
    if (!selected.panel) return
    if (primary) { openPanel(selected.key, false); setPendingOutward(selected.key); return }
    openPanel(selected.key)
  }
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const target = event.target as HTMLElement
    const inPanel = !!panelRef.current?.contains(target)
    if (event.key === 'Escape') {
      if (overflowOpen) { closeMenu(true); event.stopPropagation(); return }
      if (panelOpen) { event.stopPropagation(); closeReason.current = 'escape'; closePanel(true); return }
      // Nothing open: back to where ⌥R came from.
      const back = returnFocus.current
      returnFocus.current = null
      if (back && back.isConnected && back instanceof HTMLElement) {
        event.preventDefault()
        event.stopPropagation()
        back.focus()
      }
      return
    }
    if (inPanel || event.altKey || event.metaKey || event.ctrlKey || isTextEntry(target)) return
    // ←/→ along the switcher's buttons (the "+N" menu keeps its own arrows).
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && target.matches('[data-testid="mission-run-strip-switch"]:not([role="menuitem"]), [data-testid="mission-run-strip-more"]')) {
      const buttons = [...(stripRef.current?.querySelectorAll<HTMLElement>('[data-testid="mission-run-strip-switch"]:not([role="menuitem"]), [data-testid="mission-run-strip-more"]') ?? [])]
      const index = buttons.indexOf(target)
      const next = buttons[index + (event.key === 'ArrowRight' ? 1 : -1)]
      if (next) { event.preventDefault(); next.focus() }
      return
    }
    // A row control's own letter (Flow: P pause/resume, H hand off), only while the strip has focus.
    if (event.shiftKey || !/^Key[A-Z]$/.test(event.code)) return
    const claimed = [...(stripRef.current?.querySelectorAll<HTMLButtonElement>('[data-strip-key]') ?? [])]
      .find((element) => !panelRef.current?.contains(element) && stripKeyCode(element.dataset.stripKey ?? '') === event.code)
    if (!claimed) return
    event.preventDefault()
    if (!claimed.disabled) claimed.click()
  }

  // Switcher: every run when few, else the shown one + the two most urgent + "+N".
  const others = entries.filter((entry) => entry.key !== selected.key)
  const inlineOthers = entries.length <= 3 ? others : [...others].sort((a, b) => urgencyOrder(a) - urgencyOrder(b)).slice(0, 2)
  const overflow = others.filter((entry) => !inlineOthers.includes(entry))
  const overflowNeedsYou = overflow.some((entry) => needsYou.has(entry.key))
  const openMenu = (index: number): void => {
    setMenuIndex(index < 0 ? overflow.length - 1 : index)
    setOverflowOpen(true)
  }
  const onMoreKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMenu(0) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); openMenu(-1) }
  }
  const onMenuKeyDown = (event: React.KeyboardEvent): void => {
    const last = overflow.length - 1
    if (event.key === 'ArrowDown') { event.preventDefault(); setMenuIndex((i) => (i >= last ? 0 : i + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setMenuIndex((i) => (i <= 0 ? last : i - 1)) }
    else if (event.key === 'Home') { event.preventDefault(); setMenuIndex(0) }
    else if (event.key === 'End') { event.preventDefault(); setMenuIndex(last) }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true) }
    else if (event.key === 'Tab') { setOverflowOpen(false) }
  }
  const switchTo = switchRun
  const focusKeys = keyboardLabel(RUN_STRIP_KEYS.focus)
  const cycleHint = t('runStrip.cycleHint', { keys: `${keyboardLabel(RUN_STRIP_KEYS.previous)} ${keyboardLabel(RUN_STRIP_KEYS.next)}` })

  const toggleContent = (
    <>
      <StatusMark tone={selected.tone} quiet={selected.quiet} mode={selected.mode} />
      <span className="sr-only">{t(`runStrip.state.${selected.tone}`)} </span>
      <span
        data-testid="mission-run-strip-headline"
        className={cn('min-w-0 truncate text-label font-medium', selected.tone === 'failed' ? 'text-destructive' : 'text-foreground')}
      >
        {selected.headline}
      </span>
      {selected.meta && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-label tabular-nums text-muted-foreground" data-testid="mission-run-strip-meta">
          {selected.meta}
        </span>
      )}
    </>
  )

  return (
    <>
    <div
      key="strip"
      ref={stripRef}
      onKeyDown={onKeyDown}
      onFocus={() => { if (!focusKey) setFocusKey(selected.key) }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (!next || !stripRef.current?.contains(next)) setFocusKey(null)
      }}
      data-testid="mission-run-strip"
      data-run-key={selected.key}
      data-tone={selected.tone}
      {...selected.attributes}
      className={cn('relative shrink-0 pb-2', inline ? 'w-full px-4' : 'px-3')}
    >
      <div className="relative">
        {/* Panels: every run's full card stays mounted (it measures the run);
            only the shown run's panel is visible, and only while open. */}
        <div
          ref={panelRef}
          id={panelId}
          role="region"
          tabIndex={-1}
          aria-label={t('runStrip.panelLabel', { run: selected.label })}
          aria-hidden={!panelOpen}
          data-testid="mission-run-strip-panel"
          data-open={panelOpen ? 'true' : 'false'}
          style={{ maxHeight }}
          className={cn(
            'absolute inset-x-0 bottom-full z-20 mb-2 overflow-y-auto overscroll-contain rounded-xl border border-border/60 bg-card p-3 text-xs shadow-[0_14px_36px_-14px_rgb(0_0_0/0.5)] outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'origin-bottom transition-[opacity,transform,visibility] duration-200 ease-out motion-reduce:transition-none',
            panelOpen ? 'visible translate-y-0 opacity-100' : 'pointer-events-none invisible translate-y-1 opacity-0',
          )}
        >
          <div ref={panelsRef}>
            {entries.map((entry) => entry.panel && (
              <div key={entry.key} data-run-panel={entry.key} hidden={!(panelOpen && entry.key === selected.key)}>
                <RunPrimaryScope registry={registryFor(entry.key)}>{entry.panel}</RunPrimaryScope>
              </div>
            ))}
          </div>
        </div>

        <motion.div
          key={`${selected.key}:${selected.tone}`}
          initial={reduced ? false : { opacity: 0.4, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          data-testid="mission-run-strip-bar"
          className={cn(
            'flex min-h-10 flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl border bg-card px-1.5 py-1 shadow-[0_6px_18px_-12px_rgb(0_0_0/0.45)]',
            selected.tone === 'decision' ? 'border-accent-primary/35' : 'border-border/60',
          )}
        >
          {selected.panel ? (
            <button
              ref={toggleRef}
              type="button"
              data-agent-interactive
              data-testid="mission-run-strip-toggle"
              aria-expanded={panelOpen}
              aria-controls={panelId}
              aria-keyshortcuts={RUN_STRIP_ARIA_KEYS.focus}
              title={t('runStrip.withShortcut', { label: panelOpen ? t('runStrip.hideDetails') : t('runStrip.showDetails'), keys: focusKeys })}
              onClick={() => (panelOpen ? closePanel(false) : openPanel(selected.key))}
              className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-surface/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
            >
              {toggleContent}
              <ChevronUp
                aria-hidden
                className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-muted-foreground motion-reduce:transition-none', panelOpen && 'rotate-180')}
              />
            </button>
          ) : (
            <div tabIndex={-1} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50" data-testid="mission-run-strip-summary">{toggleContent}</div>
          )}

          {selected.controls}

          {showPrimary && (
            <button
              type="button"
              data-agent-interactive
              data-testid="mission-run-strip-primary"
              data-kind={primary?.kind ?? 'open'}
              disabled={primary?.disabled ?? false}
              onClick={runPrimary}
              aria-describedby={primary?.kind === 'local' ? undefined : `${panelId}-primary-hint`}
              title={primary?.kind === 'local' ? undefined : t('runStrip.opensCard')}
              className={RUN_STRIP_PRIMARY}
            >
              {primary?.label ?? fallbackLabel}
              {primary?.kind !== 'local' && <ChevronUp className="h-3 w-3 shrink-0 opacity-80" aria-hidden />}
            </button>
          )}
          {showPrimary && primary?.kind !== 'local' && <span id={`${panelId}-primary-hint`} hidden>{t('runStrip.opensCard')}</span>}

          {entries.length > 0 && (
            <div role="group" aria-label={t('runStrip.switcher')} className="relative flex shrink-0 items-center gap-0.5 border-l border-border/50 pl-1.5" data-testid="mission-run-strip-switcher">
              {entries.length === 1 ? (
                <span className="max-w-[11rem] truncate px-1 text-label text-muted-foreground" title={selected.label} data-testid="mission-run-strip-label">{selected.label}</span>
              ) : (
                <>
                  {[selected, ...inlineOthers].map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      data-agent-interactive
                      data-testid="mission-run-strip-switch"
                      data-run-key={entry.key}
                      aria-pressed={entry.key === selected.key}
                      aria-label={`${entry.label}: ${entry.headlineText}${needsYou.has(entry.key) ? `, ${t('runStrip.needsYou')}` : ''}`}
                      title={`${entry.label} · ${entry.headlineText}\n${cycleHint}`}
                      onClick={() => switchTo(entry.key)}
                      className={cn(QUIET_CONTROL, entry.key === selected.key && 'bg-surface text-foreground')}
                    >
                      <ToneDot tone={entry.tone} />
                      <span className="max-w-[11rem] truncate">{entry.label}</span>
                      {needsYou.has(entry.key) && <NeedsYouMark />}
                    </button>
                  ))}
                  {overflow.length > 0 && (
                    <>
                      <button
                        ref={moreRef}
                        type="button"
                        data-agent-interactive
                        data-testid="mission-run-strip-more"
                        aria-haspopup="menu"
                        aria-expanded={overflowOpen}
                        aria-controls={`${panelId}-more-menu`}
                        onKeyDown={onMoreKeyDown}
                        aria-label={overflowNeedsYou
                          ? `${t('runStrip.more', { count: overflow.length })}, ${t('runStrip.needsYou')}`
                          : t('runStrip.more', { count: overflow.length })}
                        onClick={() => (overflowOpen ? closeMenu(false) : openMenu(0))}
                        className={QUIET_CONTROL}
                      >
                        +{overflow.length}
                        {overflowNeedsYou && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-primary" data-testid="mission-run-strip-more-needs-you" />}
                      </button>
                      {overflowOpen && (
                        <div ref={menuRef} id={`${panelId}-more-menu`} role="menu" aria-label={t('runStrip.switcher')} onKeyDown={onMenuKeyDown} className="absolute bottom-full right-0 z-30 mb-2 min-w-[10rem] rounded-lg border border-border/60 bg-card p-1 shadow-[0_10px_28px_-12px_rgb(0_0_0/0.5)]">
                          {overflow.map((entry, index) => (
                            <button
                              key={entry.key}
                              type="button"
                              role="menuitem"
                              tabIndex={index === menuIndex ? 0 : -1}
                              aria-label={`${entry.label}: ${entry.headlineText}${needsYou.has(entry.key) ? `, ${t('runStrip.needsYou')}` : ''}`}
                              data-agent-interactive
                              data-testid="mission-run-strip-switch"
                              data-run-key={entry.key}
                              onClick={() => switchTo(entry.key)}
                              title={`${entry.label} · ${entry.headlineText}`}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-label text-foreground hover:bg-surface focus:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
                            >
                              <ToneDot tone={entry.tone} />
                              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                              {needsYou.has(entry.key) && <NeedsYouMark />}
                              <span className="max-w-[12rem] truncate text-muted-foreground">{entry.headlineText}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </motion.div>
      </div>
    </div>
    <Fragment key="dock">{dock}</Fragment>
    <div key="announcer" ref={anchorRef} role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="mission-run-strip-announcer">{announcement}</div>
    </>
  )
}

function urgencyOrder(entry: StripEntry): number {
  return urgencyRank(entry.urgency)
}

function extensionEntry(run: MissionLiveRun): StripEntry {
  return {
    key: run.key,
    label: run.label,
    tone: run.tone,
    urgency: urgencyOfTone(run.tone),
    quiet: run.working === false,
    mode: run.mode ?? null,
    headline: run.headline,
    headlineText: typeof run.headline === 'string' ? run.headline : run.label,
    meta: run.tone === 'launching' && !run.meta ? <MetaSkeleton /> : run.meta ?? null,
    controls: run.controls ?? null,
    wantsPrimary: run.wantsPrimary ?? (run.tone !== 'running' && run.tone !== 'launching' && run.tone !== 'info'),
    panel: run.panel ?? null,
    autoOpenToken: run.autoOpenToken ?? null,
    onPanelClose: run.onPanelClose ?? null,
    attributes: run.attributes ?? {},
    announcement: run.announcement ?? null,
    match: null,
    source: 'extension',
  }
}
