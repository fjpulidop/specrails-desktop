// ─── Rail launch card (mission-rail-cards) ────────────────────────────────────
// The operator agent proposes "assign these specs to a rail and launch" as a
// fenced ```rail-launch block (client/src/lib/rail-launch-draft.ts). This card
// renders that proposal EDITABLE — every option the Board rail header exposes
// (rail / new rail, specs, loop, engine, model, effort, profile, target PR,
// base branch) — pre-filled with the agent's recommendation and reconciled
// against the pinned project's LIVE state. Play launches from the client under
// the user's own authority (never through the agent tier ladder) and persists
// the decision on the message row so the proposal renders frozen after reload.
//
// Visual language = the mission cards (AgentPrDecisionCard / AgentSpecDraftCard):
// glass surface, header row with rail + `#` chips + status pill, muted rationale,
// motion enter, reduced-motion safe, `data-agent-interactive` on every control.

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FollowUpProposal } from '../../lib/rail-launch-draft'
import { motion, useReducedMotion } from 'motion/react'
import {
  Play, Rocket, Cpu, Gauge, Brain, Workflow, UserCog, GitPullRequest, GitBranch, Plus, X, Sparkles,
  AlertTriangle, Loader2, CheckCircle2, Ban, ExternalLink, TrainFront, Layers, Pin, MessageSquareText,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { API_ORIGIN } from '../../lib/origin'
import { FEATURE_LOOPS_SECTION } from '../../lib/feature-flags'
import type { RailLaunchProposal } from '../../lib/rail-launch-draft'
import { patchAgentMessageIntent, type AgentMessageIntent } from '../../lib/agent-api'
import { recordLocalIntent } from '../../lib/rail-launch-intents'
import { useProviderDetection } from '../../hooks/useProviderDetection'
import { modelsForProvider, defaultModelForProvider } from '../../lib/loop-run-models'
import {
  reasoningEffortsForProvider, providerSupportsFreestyle,
  providerSupportsProfiles, providerLabel, isRolesEngine, ROLES_ENGINE,
} from '../../lib/provider-capabilities'
import { FACTORY_RAIL_LOOPS, deriveRailMode, effectiveLoopId } from '../../lib/rail-loops'
import { loopsApi, type LoopDefinition } from '../../lib/loops-api'
import { loopNeedsTicket } from '../../lib/loop-ticket-need'
import { notifyGitChanged } from '../../lib/git-refresh'
import { AgentToolbarSelector, type AgentToolbarOption } from './AgentToolbarSelector'
import type { LocalTicket } from '../../types'
import type { ProfileListEntry } from '../agents/types'

// ── Live project state the card reconciles against ────────────────────────────

interface RailSnapshot {
  railIndex: number
  ticketIds: number[]
  mode: string
  profileName?: string | null
  aiEngine?: string | null
  name?: string | null
  /** Server-computed when present (mission-rail-cards); else derived below. */
  availability?: RailAvailability
}
type RailAvailability = 'free' | 'busy' | 'pending_decision' | 'on_review'

interface RailsResponse {
  rails?: RailSnapshot[]
  activeJobs?: Record<string, unknown>
  activeLoopRuns?: Record<string, unknown>
  prDeliveries?: Record<string, { decision?: string }>
}

const NEW_RAIL = '__new__'
const NO_PROFILE = '__legacy__'
const NO_EFFORT = '__default__'
const MAX_RAILS = 12

export interface RailLaunchConfig {
  railIndex: number | null
  newRail: boolean
  railName: string
  ticketIds: number[]
  loopId: string
  aiEngine: string | null
  model: string | null
  reasoningEffort: string | null
  profileName: string | null
  targetPrNumber: number | null
  baseBranch: string
  /** PR review follow-up scope (pr-follow-up-fixes); seeded from the proposal, sent frozen on Play. */
  followUp: FollowUpProposal | null
}

/**
 * Window event dispatched by the frozen "Launched" stub's "View run" link so
 * the run card (AgentPrDecisionCard, owned elsewhere) can scroll itself into
 * view / expand. Detail: `{ prDeliveryId: string | null, runIds: string[] }`.
 */
export const FOCUS_PR_CARD_EVENT = 'specrails:focus-pr-card'

// The launched stub's "View run" opens the run's live log; loaded only on click
// so the card chunk stays free of the log-explorer stack (same pattern as
// AgentPrDecisionCard's run-log chips; the modal portals to body at z-[65]).
const JobDetailModal = lazy(() =>
  import('../JobDetailModal').then((m) => ({ default: m.JobDetailModal })),
)

function railAvailability(rail: RailSnapshot, data: RailsResponse, tickets: LocalTicket[]): RailAvailability {
  if (rail.availability) return rail.availability
  const idx = String(rail.railIndex)
  if (data.activeJobs?.[idx] || data.activeLoopRuns?.[idx]) return 'busy'
  const delivery = data.prDeliveries?.[idx]
  if (delivery && delivery.decision && !['merged', 'discarded', 'completed', 'superseded', 'pr_ready'].includes(delivery.decision)) return 'pending_decision'
  if (rail.ticketIds.some((id) => tickets.find((t) => t.id === id)?.status === 'on_review')) return 'on_review'
  return 'free'
}

function railLabel(t: (k: string, o?: Record<string, unknown>) => string, rail: RailSnapshot): string {
  const base = t('railCard.rail', { index: rail.railIndex + 1 })
  return rail.name ? `${base} · ${rail.name}` : base
}

interface Props {
  proposal: RailLaunchProposal
  proposalIndex: number
  messageId: string
  conversationId: string
  /** The mission's pinned project — proposals resolve against it. */
  projectId: string | null
  /** Persisted decision for THIS proposal index (frozen stub), else null. */
  intent: AgentMessageIntent | null
  /** Compact mode inside the pinned dock (the dock owns the outer header). */
  compact?: boolean
}

export function AgentRailLaunchCard({ proposal, proposalIndex, messageId, conversationId, projectId, intent, compact = false }: Props) {
  const { t } = useTranslation('agent')
  const reduced = useReducedMotion()
  const detection = useProviderDetection()

  // ── Live data ────────────────────────────────────────────────────────────────
  const [railsData, setRailsData] = useState<RailsResponse | null>(null)
  const [tickets, setTickets] = useState<LocalTicket[] | null>(null)
  const [profiles, setProfiles] = useState<ProfileListEntry[]>([])
  const [customLoops, setCustomLoops] = useState<LoopDefinition[]>([])
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    if (!projectId || intent) return
    let cancelled = false
    const base = `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}`
    Promise.all([
      fetch(`${base}/rails`).then((r) => (r.ok ? (r.json() as Promise<RailsResponse>) : Promise.reject(new Error(String(r.status))))),
      fetch(`${base}/tickets`).then((r) => (r.ok ? (r.json() as Promise<{ tickets?: LocalTicket[] }>) : Promise.reject(new Error(String(r.status))))),
    ]).then(([rails, tix]) => {
      if (cancelled) return
      setRailsData(rails && typeof rails === 'object' ? rails : {})
      setTickets(Array.isArray(tix?.tickets) ? tix.tickets : [])
    }).catch(() => { if (!cancelled) setLoadError(true) })
    if (FEATURE_LOOPS_SECTION) {
      loopsApi.list()
        .then((ls) => { if (!cancelled) setCustomLoops(ls.filter((l) => l.status === 'published' && loopNeedsTicket(l.graph))) })
        .catch(() => { /* custom loops are optional */ })
    }
    return () => { cancelled = true }
  }, [projectId, intent])

  // ── Editable config, seeded from the proposal ────────────────────────────────
  const [config, setConfig] = useState<RailLaunchConfig>(() => ({
    railIndex: proposal.railIndex,
    newRail: !!proposal.newRail,
    railName: proposal.newRail?.name ?? proposal.railName ?? '',
    ticketIds: proposal.ticketIds,
    loopId: proposal.loopId ?? effectiveLoopId(null, proposal.mode),
    aiEngine: proposal.aiEngine,
    model: proposal.model,
    reasoningEffort: proposal.reasoningEffort,
    profileName: proposal.profileName,
    targetPrNumber: proposal.targetPrNumber,
    baseBranch: proposal.baseBranch ?? '',
    followUp: proposal.followUp ?? null,
  }))
  const patch = useCallback((p: Partial<RailLaunchConfig>) => setConfig((c) => ({ ...c, ...p })), [])

  const detectedProviders = detection.detected
  const providerReady = !detection.loading
  // Engine: the proposal's when detected, else the first detected (never a stale id).
  const effectiveEngine = useMemo(() => {
    if (config.aiEngine && (isRolesEngine(config.aiEngine) || detectedProviders.includes(config.aiEngine))) return config.aiEngine
    return detectedProviders[0] ?? null
  }, [config.aiEngine, detectedProviders])
  const engineStale = !!config.aiEngine && providerReady && effectiveEngine !== config.aiEngine
  // `roles` = the hybrid per-role engines (runtime config + loop roles): no
  // single provider owns the run, so model/effort/profile selectors step aside
  // exactly like the rail header does (RailRow). Freestyle needs one engine.
  const rolesEngine = !!effectiveEngine && isRolesEngine(effectiveEngine)
  const catalogProvider = effectiveEngine && !isRolesEngine(effectiveEngine) ? effectiveEngine : detectedProviders[0] ?? null

  const models = useMemo(() => modelsForProvider(catalogProvider), [catalogProvider])
  const effectiveModel = useMemo(() => {
    if (config.model && models.some((m) => m.value === config.model)) return config.model
    return defaultModelForProvider(catalogProvider) || null
  }, [config.model, models, catalogProvider])
  const modelStale = !!config.model && models.length > 0 && effectiveModel !== config.model

  const efforts = useMemo(() => reasoningEffortsForProvider(catalogProvider, effectiveModel), [catalogProvider, effectiveModel])
  const effectiveEffort = config.reasoningEffort && (efforts as readonly string[]).includes(config.reasoningEffort)
    ? config.reasoningEffort
    : null

  const mode = deriveRailMode(config.loopId)
  const profilesApply = !rolesEngine && mode !== 'loop' && providerSupportsProfiles(catalogProvider)

  useEffect(() => {
    if (!projectId || intent || !catalogProvider || !profilesApply) { setProfiles([]); return }
    let cancelled = false
    fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/profiles?provider=${encodeURIComponent(catalogProvider)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ profiles?: ProfileListEntry[] }>) : { profiles: [] }))
      .then((d) => {
        if (cancelled) return
        const list = Array.isArray(d.profiles) ? d.profiles.filter((p) => !p.provider || p.provider === catalogProvider) : []
        setProfiles(list)
      })
      .catch(() => { if (!cancelled) setProfiles([]) })
    return () => { cancelled = true }
  }, [projectId, intent, catalogProvider, profilesApply])
  const effectiveProfile = config.profileName && profiles.some((p) => p.name === config.profileName) ? config.profileName : null

  // ── Rails + tickets reconciliation ───────────────────────────────────────────
  const rails = useMemo(() => railsData?.rails ?? [], [railsData])
  const availabilityOf = useMemo(() => {
    const map = new Map<number, RailAvailability>()
    if (!railsData) return map
    for (const rail of rails) map.set(rail.railIndex, railAvailability(rail, railsData, tickets ?? []))
    return map
  }, [rails, railsData, tickets])
  const proposedRail = config.railIndex !== null ? rails.find((r) => r.railIndex === config.railIndex) : undefined
  const proposedRailMissing = railsData !== null && config.railIndex !== null && !config.newRail && !proposedRail
  const proposedRailBusy = !!proposedRail && !config.newRail && availabilityOf.get(proposedRail.railIndex) !== 'free' && availabilityOf.get(proposedRail.railIndex) !== undefined
  const railLimitReached = rails.length >= MAX_RAILS
  const firstFreeRail = rails.find((r) => availabilityOf.get(r.railIndex) === 'free')

  const railSelectorValue = config.newRail ? NEW_RAIL : config.railIndex !== null && proposedRail ? String(config.railIndex) : firstFreeRail ? String(firstFreeRail.railIndex) : railLimitReached ? '' : NEW_RAIL
  const resolvedRailIndex = config.newRail ? null : railSelectorValue === NEW_RAIL || railSelectorValue === '' ? null : Number(railSelectorValue)
  const createsRail = railSelectorValue === NEW_RAIL

  const ticketById = useMemo(() => new Map((tickets ?? []).map((tk) => [tk.id, tk])), [tickets])
  const validTicketIds = useMemo(
    () => (tickets ? config.ticketIds.filter((id) => ticketById.has(id)) : config.ticketIds),
    [config.ticketIds, ticketById, tickets],
  )
  const droppedTickets = tickets ? config.ticketIds.filter((id) => !ticketById.has(id)) : []
  const addableTickets = useMemo(
    () => (tickets ?? []).filter((tk) => (tk.status === 'todo' || tk.status === 'draft') && !config.ticketIds.includes(tk.id)),
    [tickets, config.ticketIds],
  )

  const freestyleAvailable = !rolesEngine && providerSupportsFreestyle(catalogProvider)
  const loopOptions: AgentToolbarOption[] = useMemo(() => {
    const builtIn = FACTORY_RAIL_LOOPS
      .filter((l) => (!l.requiresFreestyle || freestyleAvailable) && (!l.requiresLoops || FEATURE_LOOPS_SECTION))
      .map((l) => ({ value: l.id, label: t(`dashboard:${l.labelKey}`) }))
    return [...builtIn, ...customLoops.map((l) => ({ value: l.id, label: l.name }))]
  }, [customLoops, freestyleAvailable, t])
  const loopKnown = loopOptions.some((o) => o.value === config.loopId)
  const effectiveLoop = loopKnown ? config.loopId : loopOptions[0]?.value ?? config.loopId

  // ── Play ─────────────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState<'launch' | 'dismiss' | null>(null)
  const [inlineError, setInlineError] = useState<{ error: string; detail?: string; action?: string } | null>(null)
  const [localIntent, setLocalIntent] = useState<AgentMessageIntent | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const decided = intent ?? localIntent
  const blockReason: string | null = !projectId
    ? t('railCard.block.noProject')
    : loadError ? t('railCard.block.loadFailed')
    : validTicketIds.length === 0 ? t('railCard.block.noSpecs')
    : railSelectorValue === '' ? t('railCard.block.railLimit', { max: MAX_RAILS })
    : null

  const finalize = useCallback(async (decision: Omit<AgentMessageIntent, 'at'>) => {
    const res = await patchAgentMessageIntent(conversationId, messageId, decision)
    const stored: AgentMessageIntent = res.ok ? res.intent : { ...decision, at: new Date().toISOString() }
    recordLocalIntent(messageId, stored)
    if (mounted.current) setLocalIntent(stored)
  }, [conversationId, messageId])

  const play = useCallback(async () => {
    if (!projectId || blockReason || busy) return
    setBusy('launch')
    setInlineError(null)
    const base = `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/rails`
    const json = { 'content-type': 'application/json' }
    const readError = async (r: Response) => {
      let body: Record<string, unknown> = {}
      try { body = await r.json() as Record<string, unknown> } catch { /* no body */ }
      return {
        error: typeof body.error === 'string' ? body.error : `HTTP ${r.status}`,
        detail: typeof body.detail === 'string' ? body.detail : undefined,
        action: typeof body.action === 'string' ? body.action : undefined,
      }
    }
    try {
      let railIndex = resolvedRailIndex
      const wantsName = config.railName.trim().slice(0, 60)
      if (railIndex === null) {
        const r = await fetch(base, { method: 'POST', headers: json, body: JSON.stringify({ name: wantsName || null }) })
        if (!r.ok) { setInlineError(await readError(r)); return }
        const created = await r.json() as { rail?: { railIndex?: number } }
        if (typeof created.rail?.railIndex !== 'number') { setInlineError({ error: 'invalid_response' }); return }
        railIndex = created.rail.railIndex
      } else if (wantsName && wantsName !== (proposedRail?.name ?? '')) {
        const r = await fetch(`${base}/${railIndex}/name`, { method: 'PUT', headers: json, body: JSON.stringify({ name: wantsName }) })
        if (!r.ok) { setInlineError(await readError(r)); return }
      }
      const engineForRail = effectiveEngine && detectedProviders.length > 1 ? effectiveEngine : undefined
      const r1 = await fetch(`${base}/${railIndex}/tickets`, {
        method: 'PUT', headers: json,
        body: JSON.stringify({ ticketIds: validTicketIds, mode, profileName: profilesApply ? effectiveProfile : null, ...(engineForRail ? { aiEngine: engineForRail } : {}) }),
      })
      if (!r1.ok) { setInlineError(await readError(r1)); return }
      const launchBody: Record<string, unknown> = {
        mode,
        loopId: effectiveLoop,
        originConversationId: conversationId,
        originSurface: 'agent-chat',
        ...(engineForRail ? { aiEngine: engineForRail } : {}),
        ...(!rolesEngine && effectiveModel ? { model: effectiveModel } : {}),
        ...(!rolesEngine && effectiveEffort ? { reasoning_effort: effectiveEffort } : {}),
        ...(profilesApply && effectiveProfile ? { profileName: effectiveProfile } : {}),
        ...(config.targetPrNumber ? { targetPrNumber: config.targetPrNumber } : {}),
        ...(config.baseBranch.trim() ? { baseBranch: config.baseBranch.trim() } : {}),
        // The follow-up travels as-is; the route freezes it (id + hash) and
        // persists it on the delivery — never on the spec.
        ...(config.followUp ? { followUp: config.followUp } : {}),
      }
      const r2 = await fetch(`${base}/${railIndex}/launch`, { method: 'POST', headers: json, body: JSON.stringify(launchBody) })
      if (!r2.ok) { setInlineError(await readError(r2)); return }
      const launched = await r2.json() as { loopRunIds?: string[]; jobIds?: string[]; jobId?: string; prDeliveryId?: string | null }
      const runIds = Array.isArray(launched.loopRunIds) && launched.loopRunIds.length
        ? launched.loopRunIds
        : Array.isArray(launched.jobIds) && launched.jobIds.length ? launched.jobIds : launched.jobId ? [launched.jobId] : []
      notifyGitChanged(projectId)
      await finalize({
        kind: 'rail-launch', proposalIndex, status: 'launched', railIndex, runIds,
        prDeliveryId: typeof launched.prDeliveryId === 'string' ? launched.prDeliveryId : null,
        config: { ...launchBody, ticketIds: validTicketIds, railName: wantsName || null },
      })
    } catch (err) {
      setInlineError({ error: err instanceof Error ? err.message : 'network' })
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [projectId, blockReason, busy, resolvedRailIndex, config, proposedRail, effectiveEngine, rolesEngine, detectedProviders.length, validTicketIds, mode, profilesApply, effectiveProfile, effectiveLoop, effectiveModel, effectiveEffort, conversationId, proposalIndex, finalize])

  const dismiss = useCallback(async () => {
    if (busy) return
    setBusy('dismiss')
    try { await finalize({ kind: 'rail-launch', proposalIndex, status: 'dismissed' }) }
    finally { if (mounted.current) setBusy(null) }
  }, [busy, finalize, proposalIndex])

  // ── Frozen stubs ─────────────────────────────────────────────────────────────
  // "View run" = the run's JobDetailModal (the live log), scoped to the
  // proposal's project. Bringing the PR card into view is a separate,
  // honestly-labelled action ("Go to card") — it used to hide behind "View run",
  // which merely scrolled + flashed a card that is usually already pinned.
  const [logRunId, setLogRunId] = useState<string | null>(null)
  if (decided) {
    const launched = decided.status === 'launched'
    const primaryRunId = decided.runIds?.[0] ?? null
    const focusCard = (): void => {
      window.dispatchEvent(new CustomEvent(FOCUS_PR_CARD_EVENT, { detail: { prDeliveryId: decided.prDeliveryId ?? null, runIds: decided.runIds ?? [] } }))
    }
    return (
      <div
        data-testid={launched ? 'agent-rail-launch-stub-launched' : 'agent-rail-launch-stub-dismissed'}
        className={cn(
          'my-1 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs backdrop-blur',
          launched ? 'border-accent-success/30 bg-accent-success/[0.06] text-foreground/80' : 'border-border/50 bg-surface/40 text-foreground/50',
        )}
      >
        {launched ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent-success" /> : <Ban className="h-3.5 w-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">
          {launched
            ? t('railCard.stub.launched', { rail: typeof decided.railIndex === 'number' ? decided.railIndex + 1 : '?' })
            : t('railCard.stub.dismissed')}
          {' '}
          <span className="text-foreground/50">{proposal.ticketIds.map((id) => `#${id}`).join(' ')}</span>
        </span>
        {launched && (
          <button
            type="button"
            data-agent-interactive
            data-testid="agent-rail-launch-focus-card"
            title={t('railCard.stub.goToCardTitle')}
            onClick={focusCard}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-card/70 px-2 py-0.5 text-[11px] font-medium text-foreground/70 transition-colors hover:border-accent-primary/40 hover:text-foreground"
          >
            <Pin className="h-3 w-3" />
            {t('railCard.stub.goToCard')}
          </button>
        )}
        {launched && projectId && primaryRunId && (
          <button
            type="button"
            data-agent-interactive
            data-testid="agent-rail-launch-view-run"
            title={t('railCard.stub.viewRunTitle')}
            onClick={() => setLogRunId(primaryRunId)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-accent-primary/40 bg-accent-primary/10 px-2 py-0.5 text-[11px] font-medium text-accent-primary transition-colors hover:bg-accent-primary/20"
          >
            <ExternalLink className="h-3 w-3" />
            {t('railCard.stub.viewRun')}
          </button>
        )}
        {logRunId && projectId && (
          <Suspense fallback={null}>
            <JobDetailModal jobId={logRunId} projectId={projectId} onClose={() => setLogRunId(null)} />
          </Suspense>
        )}
      </div>
    )
  }

  // ── Editable card ────────────────────────────────────────────────────────────
  const railOptions: AgentToolbarOption[] = [
    ...rails.map((r) => {
      const avail = availabilityOf.get(r.railIndex)
      const suffix = avail && avail !== 'free' ? ` · ${t(`railCard.availability.${avail}`)}` : ''
      return { value: String(r.railIndex), label: `${railLabel(t, r)}${suffix}` }
    }),
    ...(railLimitReached ? [] : [{ value: NEW_RAIL, label: t('railCard.newRail'), icon: Plus }]),
  ]
  const engineOptions: AgentToolbarOption[] = [
    ...detectedProviders.map((id) => ({ value: id, label: detection.providers[id]?.displayName ?? providerLabel(id) })),
    // Same offer as the rail header: Roles whenever there is a choice of engines.
    ...(detectedProviders.length > 1 ? [{ value: ROLES_ENGINE, label: t('agents:railSelectors.rolesEngine'), icon: Layers }] : []),
  ]
  const modelOptions: AgentToolbarOption[] = models.map((m) => ({ value: m.value, label: m.label ?? m.value }))
  const effortOptions: AgentToolbarOption[] = [{ value: NO_EFFORT, label: t('railCard.effortDefault') }, ...efforts.map((e) => ({ value: e, label: t(`effort.${e}`, { defaultValue: e }) }))]
  const profileOptions: AgentToolbarOption[] = [{ value: NO_PROFILE, label: t('railCard.profileNone') }, ...profiles.map((p) => ({ value: p.name, label: p.name }))]
  const loading = !!projectId && !loadError && (railsData === null || tickets === null)
  const statusPill = loading
    ? { tone: 'border-border/60 bg-surface/60 text-foreground/50', label: t('railCard.status.loading') }
    : blockReason
      ? { tone: 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning', label: t('railCard.status.blocked') }
      : { tone: 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary', label: t('railCard.status.ready') }

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      data-testid="agent-rail-launch-card"
      className={cn(
        'my-1 overflow-hidden rounded-xl border border-accent-primary/25 bg-card/80 shadow-lg backdrop-blur',
        compact && 'my-0',
      )}
    >
      {/* Header: identity + status pill */}
      <div className="flex items-center gap-2 border-b border-border/40 bg-accent-primary/[0.06] px-3.5 py-2">
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-accent-primary/90">
          <Rocket className="h-3 w-3" />
          {t('railCard.heading')}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/55">
          {validTicketIds.map((id) => `#${id}`).join(' ')}
        </span>
        <span className={cn('inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide', statusPill.tone)}>
          {statusPill.label}
        </span>
      </div>

      <div className="space-y-2.5 px-3.5 py-3">
        {proposal.rationale && (
          <p className="flex items-start gap-1.5 text-xs italic text-foreground/60">
            <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-accent-primary/70" />
            <span>{proposal.rationale}</span>
          </p>
        )}

        {/* Rail + name */}
        <div className="flex flex-wrap items-center gap-2">
          <AgentToolbarSelector
            label={t('railCard.fields.rail')}
            icon={TrainFront}
            value={railSelectorValue}
            options={railOptions}
            disabled={loading || !!busy}
            testId="rail-card-rail"
            onSelect={(v) => (v === NEW_RAIL ? patch({ newRail: true, railIndex: null }) : patch({ newRail: false, railIndex: Number(v) }))}
          />
          {(createsRail || proposedRail) && (
            <input
              type="text"
              data-agent-interactive
              data-testid="rail-card-name"
              value={config.railName}
              maxLength={60}
              placeholder={createsRail ? t('railCard.fields.newRailName') : t('railCard.fields.railName')}
              onChange={(e) => patch({ railName: e.target.value })}
              className="h-7 min-w-[120px] flex-1 rounded-md border border-border/60 bg-surface/50 px-2 text-xs text-foreground outline-none placeholder:text-foreground/35 focus:border-accent-primary/50"
            />
          )}
        </div>
        {proposedRailMissing && <Note tone="warning" text={t('railCard.notes.railMissing', { index: (config.railIndex ?? 0) + 1 })} />}
        {proposedRailBusy && proposedRail && (
          <Note
            tone="warning"
            text={t('railCard.notes.railBusy', { index: proposedRail.railIndex + 1, state: t(`railCard.availability.${availabilityOf.get(proposedRail.railIndex) ?? 'busy'}`) })}
            action={firstFreeRail ? { label: t('railCard.notes.useFree', { index: firstFreeRail.railIndex + 1 }), onClick: () => patch({ newRail: false, railIndex: firstFreeRail.railIndex }) } : undefined}
          />
        )}

        {/* Specs */}
        <div className="flex flex-wrap items-center gap-1.5" data-testid="rail-card-specs">
          {validTicketIds.map((id) => {
            const tk = ticketById.get(id)
            return (
              <span
                key={id}
                title={tk?.title}
                className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-accent-primary/35 bg-accent-primary/10 py-0.5 pl-2 pr-1 text-[11px] font-medium text-accent-primary"
              >
                <span className="truncate">#{id}{tk ? ` ${tk.title}` : ''}</span>
                <button
                  type="button"
                  data-agent-interactive
                  aria-label={t('railCard.fields.removeSpec', { id })}
                  disabled={!!busy}
                  onClick={() => patch({ ticketIds: config.ticketIds.filter((x) => x !== id) })}
                  className="rounded-full p-0.5 text-accent-primary/60 hover:bg-accent-primary/20 hover:text-accent-primary"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )
          })}
          {addableTickets.length > 0 && (
            <AgentToolbarSelector
              label={t('railCard.fields.addSpec')}
              icon={Plus}
              value=""
              placeholder={t('railCard.fields.addSpec')}
              options={addableTickets.slice(0, 40).map((tk) => ({ value: String(tk.id), label: `#${tk.id} ${tk.title}` }))}
              disabled={!!busy}
              testId="rail-card-add-spec"
              onSelect={(v) => patch({ ticketIds: [...config.ticketIds, Number(v)] })}
            />
          )}
        </div>
        {droppedTickets.length > 0 && <Note tone="muted" text={t('railCard.notes.specsDropped', { ids: droppedTickets.map((id) => `#${id}`).join(', ') })} />}

        {/* Loop · engine · model · effort · profile */}
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
          <AgentToolbarSelector label={t('railCard.fields.loop')} icon={Workflow} value={effectiveLoop} options={loopOptions} disabled={!!busy} testId="rail-card-loop" onSelect={(v) => patch({ loopId: v })} />
          {engineOptions.length > 1 && (
            <AgentToolbarSelector label={t('railCard.fields.engine')} icon={Cpu} value={effectiveEngine ?? ''} options={engineOptions} disabled={!!busy} testId="rail-card-engine" onSelect={(v) => patch({ aiEngine: v, model: null, reasoningEffort: null, profileName: null })} />
          )}
          {!rolesEngine && modelOptions.length > 0 && (
            <AgentToolbarSelector label={t('railCard.fields.model')} icon={Brain} value={effectiveModel ?? ''} options={modelOptions} disabled={!!busy} testId="rail-card-model" onSelect={(v) => patch({ model: v })} />
          )}
          {!rolesEngine && efforts.length > 0 && (
            <AgentToolbarSelector label={t('railCard.fields.effort')} icon={Gauge} value={effectiveEffort ?? NO_EFFORT} options={effortOptions} disabled={!!busy} testId="rail-card-effort" onSelect={(v) => patch({ reasoningEffort: v === NO_EFFORT ? null : v })} />
          )}
          {profilesApply && profiles.length > 0 && (
            <AgentToolbarSelector label={t('railCard.fields.profile')} icon={UserCog} value={effectiveProfile ?? NO_PROFILE} options={profileOptions} disabled={!!busy} testId="rail-card-profile" onSelect={(v) => patch({ profileName: v === NO_PROFILE ? null : v })} />
          )}
        </div>
        {engineStale && <Note tone="muted" text={t('railCard.notes.engineStale', { engine: config.aiEngine, fallback: effectiveEngine ? providerLabel(effectiveEngine) : '' })} />}
        {modelStale && <Note tone="muted" text={t('railCard.notes.modelStale', { model: config.model, fallback: effectiveModel })} />}

        {/* Delivery target (optional) */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="inline-flex items-center gap-1 text-foreground/60">
            <GitPullRequest className="h-3.5 w-3.5 text-accent-primary/70" />
            <span className="sr-only">{t('railCard.fields.targetPr')}</span>
            <input
              type="number"
              min={1}
              inputMode="numeric"
              data-agent-interactive
              data-testid="rail-card-target-pr"
              value={config.targetPrNumber ?? ''}
              placeholder={t('railCard.fields.targetPr')}
              disabled={!!busy}
              onChange={(e) => patch({ targetPrNumber: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null })}
              className="h-7 w-28 rounded-md border border-border/60 bg-surface/50 px-2 text-xs text-foreground outline-none placeholder:text-foreground/35 focus:border-accent-primary/50"
            />
          </label>
          <label className="inline-flex items-center gap-1 text-foreground/60">
            <GitBranch className="h-3.5 w-3.5 text-accent-primary/70" />
            <span className="sr-only">{t('railCard.fields.baseBranch')}</span>
            <input
              type="text"
              data-agent-interactive
              data-testid="rail-card-base-branch"
              value={config.baseBranch}
              placeholder={t('railCard.fields.baseBranch')}
              disabled={!!busy}
              onChange={(e) => patch({ baseBranch: e.target.value })}
              className="h-7 w-40 rounded-md border border-border/60 bg-surface/50 px-2 text-xs text-foreground outline-none placeholder:text-foreground/35 focus:border-accent-primary/50"
            />
          </label>
        </div>

        {config.followUp && (
          <div data-testid="rail-card-follow-up" className="rounded-lg border border-accent-primary/25 bg-accent-primary/[0.05] px-2.5 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 font-medium text-foreground/85">
                <MessageSquareText className="h-3.5 w-3.5 text-accent-primary/80" />
                {t('railCard.followUp.title', { count: config.followUp.comments.length })}
              </span>
              <span className="text-foreground/55">{config.followUp.scope.objective}</span>
            </div>
            <ul className="mt-1.5 space-y-1">
              {config.followUp.comments.map((comment) => (
                <li key={comment.id} className="flex gap-2 text-foreground/75">
                  <span className="shrink-0 rounded bg-surface/70 px-1 font-mono text-[10px] text-foreground/60">{comment.id}</span>
                  <span className="min-w-0">
                    {comment.path ? <span className="font-mono text-[11px] text-accent-info">{comment.path}{comment.line ? `:${comment.line}` : ''} · </span> : null}
                    <span className="line-clamp-2">{comment.body}</span>
                    <span className="ml-1 text-[10px] text-foreground/45">{t(`railCard.followUp.source.${comment.source === 'github' ? 'github' : 'pasted'}`)}</span>
                  </span>
                </li>
              ))}
            </ul>
            {config.followUp.scope.excludedChanges.length > 0 && (
              <div className="mt-1.5 text-foreground/60">
                <span className="font-medium">{t('railCard.followUp.excluded')}:</span> {config.followUp.scope.excludedChanges.join(' · ')}
              </div>
            )}
            {config.followUp.scope.verification.length > 0 && (
              <div className="mt-1 text-foreground/60">
                <span className="font-medium">{t('railCard.followUp.verification')}:</span> {config.followUp.scope.verification.join(' · ')}
              </div>
            )}
            <div className="mt-1.5 text-[11px] text-foreground/45">{t('railCard.followUp.specUntouched')}</div>
          </div>
        )}

        {inlineError && (
          <div data-testid="rail-card-error" className="flex items-start gap-2 rounded-lg border border-destructive/35 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t(`railCard.errors.${inlineError.error}`, { defaultValue: inlineError.error })}</div>
              {inlineError.detail && <div className="text-destructive/80">{inlineError.detail}</div>}
              {inlineError.action && <div className="text-foreground/70">{inlineError.action}</div>}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/45">
            {blockReason ?? t('railCard.playHint')}
          </span>
          <button
            type="button"
            data-agent-interactive
            data-testid="rail-card-dismiss"
            disabled={!!busy}
            onClick={() => void dismiss()}
            className="rounded-md px-2 py-1 text-xs text-foreground/60 transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50"
          >
            {t('railCard.dismiss')}
          </button>
          <button
            type="button"
            data-agent-interactive
            data-testid="rail-card-play"
            disabled={!!busy || loading || !!blockReason}
            onClick={() => void play()}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1 text-xs font-semibold text-white shadow transition-colors hover:bg-accent-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'launch' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {busy === 'launch' ? t('railCard.launching') : t('railCard.play')}
          </button>
        </div>
      </div>
    </motion.div>
  )
}

function Note({ tone, text, action }: { tone: 'warning' | 'muted'; text: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[11px]',
        tone === 'warning' ? 'border-accent-warning/35 bg-accent-warning/10 text-accent-warning' : 'border-border/50 bg-surface/40 text-foreground/55',
      )}
    >
      {tone === 'warning' && <AlertTriangle className="h-3 w-3 shrink-0" />}
      <span className="min-w-0 flex-1">{text}</span>
      {action && (
        <button type="button" data-agent-interactive onClick={action.onClick} className="shrink-0 rounded px-1.5 py-0.5 font-medium underline-offset-2 hover:underline">
          {action.label}
        </button>
      )}
    </div>
  )
}

/** Streaming placeholder while a ```rail-launch block is still arriving. */
export function AgentRailLaunchPending() {
  const { t } = useTranslation('agent')
  return (
    <div data-testid="agent-rail-launch-pending" className="my-1 inline-flex items-center gap-1.5 rounded-full border border-accent-primary/30 bg-accent-primary/10 px-2.5 py-1 text-[11px] text-accent-primary">
      <Loader2 className="h-3 w-3 animate-spin" />
      {t('railCard.pending')}
    </div>
  )
}

/** Muted note for a settled block the parser could not read (never silent). */
export function AgentRailLaunchUnreadable({ excerpts }: { excerpts: string[] }) {
  const { t } = useTranslation('agent')
  return (
    <div
      data-testid="agent-rail-launch-unreadable"
      title={excerpts.join('\n')}
      className="my-1 inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-surface/40 px-2.5 py-1 text-[11px] text-foreground/55"
    >
      <AlertTriangle className="h-3 w-3 shrink-0 text-accent-warning/80" />
      {t('railCard.unreadable', { count: excerpts.length })}
    </div>
  )
}
