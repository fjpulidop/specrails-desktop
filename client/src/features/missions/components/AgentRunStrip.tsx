// ─── The mission's run strip ──────────────────────────────────────────────────
// ONE strip above the composer is the single live representation of a
// mission's runs: the deliveries it launched (mission-rail-cards), its
// undecided launch proposals and the runs an extension owns (Flow). It shows
// one run at a time — the most urgent (waiting for you › failed › running ›
// paused) unless the person picked another in the switcher — as a status mark,
// the current step in plain words, progress, elapsed time and billed cost.
// A primary action appears only when the run needs the person. The run's card
// DECLARES it (run-primary.tsx: id, label, kind, handler). A `local` action
// (Resume, Relaunch, Back to Flow) runs in one click, in place; an `outward`
// one (Create PR, Publish, Reopen, Approve, Launch) is never fired from here:
// the strip opens the panel with focus on the card's own control.
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

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'motion/react'
import { AlertTriangle, BellRing, ChevronUp, Info, Loader2, Pause } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { formatRunElapsed } from '../../jobs/hooks/useRunVitals'
import type { AgentPrDecisionEnvelope } from '../lib/agent-api'
import { modeAccent, useMissionExtensions, useMissionLiveRuns, type MissionLiveRun, type MissionModeBadge } from '../context/MissionExtensionsContext'
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
import { bestRunPrimary, RunPrimaryScope, type RunPrimaryAction, type RunPrimaryRegistry } from './run-primary'
import type { PinnedRailProposal } from './useRailLaunchProposals'

/** The strip's primary action style — extensions reuse it for their own primary. */
export const RUN_STRIP_PRIMARY =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent-primary px-2.5 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-accent-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50'

/** A quiet control inside the strip (switcher, overflow). */
const QUIET_CONTROL =
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-foreground/60 transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50'

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
  attributes: Readonly<Record<string, string>>
  announcement: string | null
  match: { prDeliveryId: string; runIds: readonly string[] } | null
  source: 'delivery' | 'proposal' | 'extension'
}

const MARK_CLASS = 'h-3.5 w-3.5 shrink-0'

/** The status mark: a shape per state, never color alone. A running run of an
 *  extension's mode (Flow) shows the mode's icon in the mode's color. */
function StatusMark({ tone, quiet, mode }: { tone: MissionRunTone; quiet: boolean; mode: MissionModeBadge | null }) {
  if (tone === 'running' && mode?.icon) {
    const Icon = mode.icon
    return (
      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" style={{ color: modeAccent(mode) }} data-testid="mission-run-strip-mode-mark" aria-hidden>
        <Icon className={cn('h-3.5 w-3.5', !quiet && 'motion-safe:animate-pulse')} aria-hidden />
      </span>
    )
  }
  if (tone === 'launching') return <Loader2 className={cn(MARK_CLASS, 'text-foreground/45 motion-safe:animate-spin')} aria-hidden />
  if (tone === 'decision') return <BellRing className={cn(MARK_CLASS, 'text-accent-primary')} aria-hidden />
  if (tone === 'failed') return <AlertTriangle className={cn(MARK_CLASS, 'text-destructive')} aria-hidden />
  if (tone === 'paused') return <Pause className={cn(MARK_CLASS, 'text-accent-warning')} aria-hidden />
  if (tone === 'info') return <Info className={cn(MARK_CLASS, 'text-foreground/70')} aria-hidden />
  return (
    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden>
      <span className={cn('h-2 w-2 rounded-full bg-accent-info', !quiet && 'motion-safe:animate-pulse')} />
    </span>
  )
}

/** Small tone dot for the switcher. */
function ToneDot({ tone }: { tone: MissionRunTone }) {
  return (
    <span
      aria-hidden
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        tone === 'decision' && 'bg-accent-primary',
        tone === 'failed' && 'bg-destructive',
        tone === 'paused' && 'bg-accent-warning',
        tone === 'info' && 'bg-foreground/45',
        (tone === 'running' || tone === 'launching') && 'bg-accent-info',
      )}
    />
  )
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
  return <span aria-hidden className="text-foreground/25">·</span>
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
  const { describeRun } = useMissionExtensions()
  const extensionRuns = useMissionLiveRuns({ conversationId, projectId, inline })

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
        {totals.progress && (
          <span data-testid="mission-run-strip-progress" aria-label={t('runStrip.progressAria', { done: totals.progress.done, total: totals.progress.total })}>
            {totals.progress.done}/{totals.progress.total}
          </span>
        )}
        {totals.progress && <Dot />}
        <span data-testid="mission-run-strip-elapsed" aria-label={totals.elapsedMs !== null ? t('prCard.runElapsedAria', { elapsed: formatRunElapsed(totals.elapsedMs) }) : undefined}>
          {totals.elapsedMs !== null ? formatRunElapsed(totals.elapsedMs) : '—'}
        </span>
        <Dot />
        <span
          data-testid="mission-run-strip-cost"
          title={totals.costPartial ? t('runStrip.costPartial') : t('runStrip.costTitle')}
          aria-label={totals.costUsd !== null ? t('prCard.runCostAria', { cost: formatRunCost(totals.costUsd) }) : t('runStrip.costNone')}
        >
          {totals.costUsd !== null ? `${formatRunCost(totals.costUsd)}${totals.costPartial ? '*' : ''}` : '—'}
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
  const entriesRef = useRef(entries)
  entriesRef.current = entries
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

  const [overflowOpen, setOverflowOpen] = useState(false)
  if (!selected) {
    return <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="mission-run-strip-announcer">{announcement}</div>
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
    if (event.key !== 'Escape') return
    if (overflowOpen) { setOverflowOpen(false); event.stopPropagation(); return }
    if (panelOpen) { event.stopPropagation(); closePanel(true) }
  }

  // Switcher: every run when few, else the shown one + the two most urgent + "+N".
  const others = entries.filter((entry) => entry.key !== selected.key)
  const inlineOthers = entries.length <= 3 ? others : [...others].sort((a, b) => urgencyOrder(a) - urgencyOrder(b)).slice(0, 2)
  const overflow = others.filter((entry) => !inlineOthers.includes(entry))
  const overflowNeedsYou = overflow.some((entry) => needsYou.has(entry.key))
  const switchTo = (key: string): void => {
    choose(key)
    if (openKey) setOpenKey(key)
    setOverflowOpen(false)
  }

  const toggleContent = (
    <>
      <StatusMark tone={selected.tone} quiet={selected.quiet} mode={selected.mode} />
      <span className="sr-only">{t(`runStrip.state.${selected.tone}`)} </span>
      <span
        data-testid="mission-run-strip-headline"
        className={cn('min-w-0 truncate text-[12px] font-medium', selected.tone === 'failed' ? 'text-destructive' : 'text-foreground/85')}
      >
        {selected.headline}
      </span>
      {selected.meta && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-foreground/55" data-testid="mission-run-strip-meta">
          {selected.meta}
        </span>
      )}
    </>
  )

  return (
    <div
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
      className={cn('relative shrink-0 pb-2', inline ? 'mx-auto w-full max-w-[960px] px-4' : 'px-3')}
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
            'absolute inset-x-0 bottom-full z-20 mb-2 overflow-y-auto overscroll-contain rounded-xl border border-border/60 bg-card p-3 text-xs shadow-[0_14px_36px_-14px_rgb(0_0_0/0.5)] outline-none',
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
            'flex min-h-10 flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl border bg-card/90 px-1.5 py-1 shadow-[0_6px_18px_-12px_rgb(0_0_0/0.45)] backdrop-blur',
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
              title={panelOpen ? t('runStrip.hideDetails') : t('runStrip.showDetails')}
              onClick={() => (panelOpen ? closePanel(false) : openPanel(selected.key))}
              className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-surface/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
            >
              {toggleContent}
              <ChevronUp
                aria-hidden
                className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-foreground/40 transition-transform duration-200 group-hover:text-foreground/70 motion-reduce:transition-none', panelOpen && 'rotate-180')}
              />
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1" data-testid="mission-run-strip-summary">{toggleContent}</div>
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

          {(entries.length > 1 || selected.source !== 'extension') && (
            <div role="group" aria-label={t('runStrip.switcher')} className="relative flex shrink-0 items-center gap-0.5 border-l border-border/50 pl-1.5" data-testid="mission-run-strip-switcher">
              {entries.length === 1 ? (
                <span className="px-1 text-[11px] text-foreground/50" data-testid="mission-run-strip-label">{selected.label}</span>
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
                      title={`${entry.label} · ${entry.headlineText}`}
                      onClick={() => switchTo(entry.key)}
                      className={cn(QUIET_CONTROL, entry.key === selected.key && 'bg-surface text-foreground')}
                    >
                      <ToneDot tone={entry.tone} />
                      <span className="max-w-[7rem] truncate">{entry.label}</span>
                      {needsYou.has(entry.key) && <NeedsYouMark />}
                    </button>
                  ))}
                  {overflow.length > 0 && (
                    <>
                      <button
                        type="button"
                        data-agent-interactive
                        data-testid="mission-run-strip-more"
                        aria-haspopup="menu"
                        aria-expanded={overflowOpen}
                        aria-label={overflowNeedsYou
                          ? `${t('runStrip.more', { count: overflow.length })}, ${t('runStrip.needsYou')}`
                          : t('runStrip.more', { count: overflow.length })}
                        onClick={() => setOverflowOpen((value) => !value)}
                        className={QUIET_CONTROL}
                      >
                        +{overflow.length}
                        {overflowNeedsYou && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-primary" data-testid="mission-run-strip-more-needs-you" />}
                      </button>
                      {overflowOpen && (
                        <div role="menu" aria-label={t('runStrip.switcher')} className="absolute bottom-full right-0 z-30 mb-2 min-w-[10rem] rounded-lg border border-border/60 bg-card p-1 shadow-[0_10px_28px_-12px_rgb(0_0_0/0.5)]">
                          {overflow.map((entry) => (
                            <button
                              key={entry.key}
                              type="button"
                              role="menuitem"
                              data-agent-interactive
                              data-testid="mission-run-strip-switch"
                              data-run-key={entry.key}
                              onClick={() => switchTo(entry.key)}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] text-foreground/75 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
                            >
                              <ToneDot tone={entry.tone} />
                              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                              {needsYou.has(entry.key) && <NeedsYouMark />}
                              <span className="max-w-[9rem] truncate text-foreground/45">{entry.headlineText}</span>
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
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="mission-run-strip-announcer">{announcement}</div>
    </div>
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
    wantsPrimary: run.tone !== 'running' && run.tone !== 'launching' && run.tone !== 'info',
    panel: run.panel ?? null,
    autoOpenToken: run.autoOpenToken ?? null,
    attributes: run.attributes ?? {},
    announcement: run.announcement ?? null,
    match: null,
    source: 'extension',
  }
}
