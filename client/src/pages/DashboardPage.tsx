import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  pointerWithin,
  rectIntersection,
  getFirstCollision,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useTickets } from '../hooks/useTickets'
import { SpecsBoard } from '../components/SpecsBoard'
import { JiraDiscardProvider } from '../context/JiraDiscardContext'
import { RailsBoard, type RailState, applyRailJobOutcome, isRailSortId, extractRailId } from '../components/RailsBoard'
import { applyWorktreeProgress, type RailWorktreeMap, type WorktreeState } from '../lib/worktree-progress'
import { useRailMetrics } from '../context/RailMetricsContext'
import { useRailPrDecisions } from '../context/RailPrDecisionContext'
import { DashboardSplitter } from '../components/DashboardSplitter'
import { useDashboardSplit } from '../hooks/useDashboardSplit'
import { TicketDetailModal } from '../components/TicketDetailModal'
import { CreateTicketModal } from '../components/CreateTicketModal'
import { FreestyleLaunchDialog } from '../components/FreestyleLaunchDialog'
import { LaunchAllDialog } from '../components/LaunchAllDialog'
import { TargetPrLaunchDialog } from '../components/TargetPrLaunchDialog'
import type { RailTargetPr } from '../components/RailTargetPrSelector'
import { getApiBase } from '../lib/api'
import { FEATURE_LOOPS_SECTION } from '../lib/feature-flags'
import { effectiveLoopId, deriveRailMode } from '../lib/rail-loops'
import { defaultModelForProvider, modelsForProvider } from '../lib/loop-run-models'
import {
  defaultReasoningEffortForProvider,
  providerSupportsCustomModelAliases,
  providerSupportsFreestyle,
  reasoningEffortsForProvider,
} from '../lib/provider-capabilities'
import { isSafeCustomModelAlias } from '../lib/model-alias'
import { railIdFromIndex, railIndexFromId, MAX_RAILS } from '../lib/rail-id'
import { useDesktop, projectProviders } from '../hooks/useDesktop'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import { useSpecGenTracker } from '../hooks/useSpecGenTracker'
import { useActiveTheme } from '../context/ThemeContext'
import { Starfield } from '../components/theme-effects/Starfield'
import type { LocalTicket, RailPrStateSnapshot } from '../types'
import type { RailMode, RailStatus } from '../components/RailControls'
import type { SpecSortMode, SpecSortDir } from '../types/spec-sort'
import { applySpecSort, loadSpecSort, saveSpecSort } from '../lib/spec-sort'
import {
  loadSpecsViewTier,
  saveSpecsViewTier,
  type SpecsViewTier,
} from '../lib/specs-view-tier'
import { insertAt, resolveDestContainer } from '../lib/dashboard-dnd'

const INITIAL_RAILS: RailState[] = [
  { id: 'rail-1', label: 'Rail 1', ticketIds: [], mode: 'implement', status: 'idle' },
  { id: 'rail-2', label: 'Rail 2', ticketIds: [], mode: 'implement', status: 'idle' },
  { id: 'rail-3', label: 'Rail 3', ticketIds: [], mode: 'implement', status: 'idle' },
]

const isRailMode = (m: string | undefined): m is RailMode =>
  m === 'implement' || m === 'batch-implement' || m === 'freestyle' || m === 'loop'

function prDecisionContinuesTickets(decision: RailPrStateSnapshot | undefined, ticketIds: number[]): boolean {
  if (!decision) return false
  if (decision.decision !== 'pr_draft' && decision.decision !== 'pr_ready') return false
  if (!decision.prUrl || !decision.branch) return false
  const covered = new Set(decision.ticketIds)
  return ticketIds.length > 0 && ticketIds.every((id) => covered.has(id))
}

function ticketHasContinuablePr(ticketId: number, decisions: ReadonlyMap<number, RailPrStateSnapshot>): boolean {
  for (const decision of decisions.values()) {
    if (prDecisionContinuesTickets(decision, [ticketId])) return true
  }
  return false
}

/** Why a rail is excluded from a Launch-all batch. */
type LaunchAllSkipReason = 'running' | 'empty' | 'pendingDecision' | 'onReview'
/** Per-rail terminal outcome of a (batched) launch attempt. */
type LaunchOutcome = 'launched' | 'failed' | 'pendingDecision' | 'skipped'

function loadSpecOrder(projectId: string | null): number[] | null {
  if (!projectId) return null
  try {
    const raw = localStorage.getItem(`specrails-desktop:spec-order:${projectId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

function saveSpecOrder(projectId: string | null, ids: number[] | null) {
  if (!projectId) return
  // B23: these run inside setState updaters; an uncaught throw (quota exceeded,
  // Safari private mode) would crash the Dashboard render. Persistence is
  // best-effort — losing it is acceptable, crashing is not.
  try {
    if (ids) {
      localStorage.setItem(`specrails-desktop:spec-order:${projectId}`, JSON.stringify(ids))
    } else {
      localStorage.removeItem(`specrails-desktop:spec-order:${projectId}`)
    }
  } catch { /* non-fatal */ }
}

interface PersistedRail {
  id: string
  label: string
  ticketIds: number[]
  mode: RailMode
  status: RailStatus
  profileName?: string | null
  freestyleModel?: import('../components/agents/RailModelSelector').FreestyleModel | null
}

function loadRails(projectId: string | null): RailState[] | null {
  if (!projectId) return null
  try {
    const raw = localStorage.getItem(`specrails-desktop:rails:${projectId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedRail[]
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    return parsed
  } catch { return null }
}

function saveRails(projectId: string | null, rails: RailState[]) {
  if (!projectId) return
  // B23: best-effort persistence (see saveSpecOrder) — never crash the render.
  try {
    localStorage.setItem(`specrails-desktop:rails:${projectId}`, JSON.stringify(rails))
  } catch { /* non-fatal */ }
}

export default function DashboardPage() {
  const { t } = useTranslation('dashboard')
  const { activeProjectId, projects } = useDesktop()
  const isGalaxy = useActiveTheme().id === 'galaxy'
  const railProviders = (() => {
    const p = projects.find((pr) => pr.id === activeProjectId)
    return p ? projectProviders(p) : ['claude']
  })()
  const { tickets, isLoading, error: ticketsError, updateTicket, updateTicketStatus, updateTicketPriority, deleteTicket, createTicket, refetch, contractRefiningIds } = useTickets()
  const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()
  const { specToOpen, clearSpecToOpen } = useSpecGenTracker()
  const [detailTicket, setDetailTicket] = useState<LocalTicket | null>(null)
  const [createTicketOpen, setCreateTicketOpen] = useState(false)
  // Rail pending an freestyle-launch confirmation (variable-cost warning modal).
  const [freestyleConfirm, setFreestyleConfirm] = useState<{ railId: string } | null>(null)
  // Confirm-before-launch when the rail targets an EXISTING PR (mis-pick must
  // be visible before any work starts on that PR's head branch).
  const [targetPrConfirm, setTargetPrConfirm] = useState<{ railId: string } | null>(null)
  // Launch-all pending its batch confirmation (N parallel AI launches).
  const [launchAllConfirm, setLaunchAllConfirm] = useState(false)

  // Open a spec when the tracker signals "View" was clicked for this project
  useEffect(() => {
    if (!specToOpen || specToOpen.projectId !== activeProjectId) return
    setDetailTicket(specToOpen.ticket)
    refetch()
    clearSpecToOpen()
  }, [specToOpen, activeProjectId, refetch, clearSpecToOpen])

  // ── Drag state ───────────────────────────────────────────────────────────────
  const [activeId, setActiveId] = useState<number | null>(null)
  const [activeRailDragLabel, setActiveRailDragLabel] = useState<string | null>(null)
  const [specOrderIds, setSpecOrderIds] = useState<number[] | null>(() => loadSpecOrder(activeProjectId))
  const [rails, setRails] = useState<RailState[]>(() => loadRails(activeProjectId) ?? INITIAL_RAILS)
  // Per-rail worktree merge-back progress (parallel/isolated launches). railIndex → ticketId → state.
  const [railWorktrees, setRailWorktrees] = useState<RailWorktreeMap>({})
  // Live per-rail execution metrics (elapsed/steps/lines) — app-level provider so
  // they survive Dashboard ⇄ Jobs navigation.
  const railMetrics = useRailMetrics()
  // Ask-first PR decisions per rail (safe-pr-review-flow) — app-level provider,
  // WS-hydrated snapshots + the single POST /rails/pr-decision caller.
  const { decisions: railPrDecisions, hydrated: railPrDecisionsHydrated, act: actRailPrDecision, checkout: checkoutRailPrBranch } = useRailPrDecisions()
  const initialSort = loadSpecSort(activeProjectId)
  const [sortMode, setSortMode] = useState<SpecSortMode>(initialSort.mode)
  const [sortDir, setSortDir] = useState<SpecSortDir>(initialSort.dir)
  const [viewTier, setViewTier] = useState<SpecsViewTier>(() => loadSpecsViewTier(activeProjectId))

  // Reset spec order, rails, sort, and view tier when active project changes
  useEffect(() => {
    setSpecOrderIds(loadSpecOrder(activeProjectId))
    setRails(loadRails(activeProjectId) ?? INITIAL_RAILS)
    setRailWorktrees({})
    const s = loadSpecSort(activeProjectId)
    setSortMode(s.mode)
    setSortDir(s.dir)
    setViewTier(loadSpecsViewTier(activeProjectId))
  }, [activeProjectId])

  const handleSortChange = useCallback((mode: SpecSortMode, dir: SpecSortDir) => {
    setSortMode(mode)
    setSortDir(dir)
    saveSpecSort(activeProjectId, mode, dir)
  }, [activeProjectId])

  const handleViewTierChange = useCallback((tier: SpecsViewTier) => {
    setViewTier(tier)
    saveSpecsViewTier(activeProjectId, tier)
  }, [activeProjectId])

  // ── Reconcile rails against the server on mount / project switch / reconnect ─
  // The Kanban's rail state is a client-local projection (localStorage + live WS
  // while THIS component is mounted). Launches can happen while it is unmounted
  // — the global agent via MCP (Agent Mode), the mobile companion, another
  // window — and after a server restart stale 'running' state persists locally.
  // So this reconcile is BIDIRECTIONAL and always runs:
  //   • server-active rail, local idle  → ADOPT (running + activeJobId + the
  //     server's ticket assignment), so an agent-launched rail lights up here;
  //   • local running, server inactive  → CLEAR (finished while we were away);
  //   • both running                    → restore a lost activeJobId only.
  useEffect(() => {
    if (connectionStatus !== 'connected' || !activeProjectId) return

    let cancelled = false
    // Snapshot BEFORE the fetch: a rail that goes running only AFTER this point
    // was launched locally while the request was in flight — the (stale)
    // response must not clear that optimistic state back to idle.
    const preRails = loadRails(activeProjectId) ?? INITIAL_RAILS
    const preById = new Map(preRails.map((p) => [p.id, p]))
    fetch(`${getApiBase()}/rails`)
      .then((res) => res.ok ? res.json() : null)
      .then((data: {
        rails?: { railIndex: number; ticketIds?: number[]; mode?: string; name?: string | null }[]
        activeJobs?: Record<string, { jobId: string; mode?: string }>
        activeLoopRuns?: Record<string, { loopRunId: string; loopId?: string }>
      } | null) => {
        if (cancelled || !data) return
        const activeJobs = data.activeJobs ?? {}
        // Loop-mode rails track an active LOOP run (not a queue job), so a rail
        // running a loop must be treated as still-running here too — otherwise
        // refresh wrongly clears it and releases its in-flight ticket.
        const activeLoopRuns = data.activeLoopRuns ?? {}
        const activeIndices = new Set<number>([
          ...Object.keys(activeJobs).map(Number),
          ...Object.keys(activeLoopRuns).map(Number),
        ])
        const serverRails = data.rails ?? []
        const serverTicketsByIndex = new Map<number, number[]>()
        for (const r of serverRails) {
          serverTicketsByIndex.set(r.railIndex, Array.isArray(r.ticketIds) ? r.ticketIds : [])
        }
        const serverIndices = new Set(serverRails.map((r) => r.railIndex))
        setRails((prev) => {
          let changed = false
          const adoptedTickets = new Map<string, number[]>()
          const next = prev.map((r, pos) => {
            // IDENTITY, not position: rail id `rail-N` ↔ server railIndex N-1
            // (a reordered board or a deleted middle rail breaks the positional
            // assumption). Exotic ids (test fixtures) fall back to position.
            const idx = railIndexFromId(r.id) ?? pos
            const loopRun = activeLoopRuns[String(idx)]
            const serverJobId = activeJobs[String(idx)]?.jobId ?? loopRun?.loopRunId
            if (activeIndices.has(idx)) {
              if (r.status === 'running') {
                // Still running — restore the active id (job or loop run) if lost.
                if (serverJobId && !r.activeJobId) {
                  changed = true
                  return { ...r, activeJobId: serverJobId }
                }
                return r
              }
              // Was running when the fetch STARTED but idle now: a completion WS
              // event landed during the round-trip — the response is stale, do
              // not resurrect the finished run.
              if (preById.get(r.id)?.status === 'running') return r
              // Idle locally but EXECUTING server-side: launched while this board
              // was unmounted (agent via MCP, mobile, another window). Adopt the
              // run + the server's ticket assignment. Desktop launches always
              // register as LOOP runs (factory:implement etc.) — derive the real
              // mode from the loopId instead of hardcoding 'loop'.
              const serverTickets = serverTicketsByIndex.get(idx) ?? []
              const jobMode = activeJobs[String(idx)]?.mode
              const serverMode = isRailMode(jobMode) ? jobMode : loopRun ? deriveRailMode(loopRun.loopId) : undefined
              const ticketIds = serverTickets.length ? serverTickets : r.ticketIds
              adoptedTickets.set(r.id, ticketIds)
              changed = true
              return {
                ...r,
                status: 'running' as const,
                activeJobId: serverJobId,
                ticketIds,
                mode: serverMode ?? r.mode,
                // A custom loop needs its id selected for the rail header to
                // label the run; factory loops keep the rail's own selection.
                ...(loopRun?.loopId && loopRun.loopId.startsWith('custom:')
                  ? { selectedLoopId: loopRun.loopId }
                  : {}),
              }
            }
            if (r.status !== 'running') return r
            // Launched locally AFTER the fetch started (optimistic 202 state):
            // the response predates the launch — leave it alone.
            if (preById.get(r.id)?.status !== 'running') return r
            // Rail was running but server has no active job → job finished while
            // we were away. Clear tickets so they reappear in Specs/Done based
            // on their current server-side status (useTickets re-fetches on mount).
            changed = true
            return { ...r, status: 'idle' as const, activeJobId: undefined, ticketIds: [] }
          })
          // ADOPT server rails this board doesn't know yet (created via the
          // agent/MCP create_rail, mobile, another window) so every rail has a
          // board row — including its assignment and any in-flight run.
          const knownIds = new Set(next.map((r) => r.id))
          const appended: RailState[] = []
          for (const sr of serverRails) {
            const id = railIdFromIndex(sr.railIndex)
            if (knownIds.has(id)) continue
            const loopRun = activeLoopRuns[String(sr.railIndex)]
            const jobMode = activeJobs[String(sr.railIndex)]?.mode
            const mode = isRailMode(jobMode)
              ? jobMode
              : loopRun
                ? deriveRailMode(loopRun.loopId)
                : isRailMode(sr.mode) ? sr.mode : 'implement'
            const running = activeIndices.has(sr.railIndex)
            const ticketIds = serverTicketsByIndex.get(sr.railIndex) ?? []
            appended.push({
              id,
              label: sr.name ? `Rail ${sr.name}` : `Rail ${sr.railIndex + 1}`,
              ticketIds,
              mode,
              status: running ? ('running' as const) : ('idle' as const),
              activeJobId: activeJobs[String(sr.railIndex)]?.jobId ?? loopRun?.loopRunId,
              ...(loopRun?.loopId && loopRun.loopId.startsWith('custom:')
                ? { selectedLoopId: loopRun.loopId }
                : {}),
            })
            if (ticketIds.length > 0) adoptedTickets.set(id, ticketIds)
            changed = true
          }
          // DROP local rails the server deleted elsewhere — only when they are
          // safe to drop (idle + empty), so an optimistic local state is never
          // destroyed. Guarded on a non-empty server list (a failed/odd payload
          // must not wipe the board), and a rail that did NOT exist when the
          // fetch STARTED was added while the request was in flight (Add rail's
          // optimistic append) — the stale response must not remove it.
          let merged = appended.length > 0 ? [...next, ...appended] : next
          if (serverRails.length > 0) {
            const kept = merged.filter((r) => {
              const idx = railIndexFromId(r.id)
              if (idx === null || serverIndices.has(idx)) return true
              if (!preById.has(r.id)) return true
              return r.status === 'running' || r.ticketIds.length > 0
            })
            if (kept.length !== merged.length) {
              merged = kept
              changed = true
            }
          }
          if (!changed) return prev
          // An adopted ticket may still sit on ANOTHER rail from a local drag —
          // strip it there (mirrors handleMoveTicketToRail) so no ticket renders
          // on two rails at once (duplicate dnd ids / double-launch risk).
          const adoptedIdSet = new Set([...adoptedTickets.values()].flat())
          const deduped = adoptedIdSet.size
            ? merged.map((r) => {
                if (adoptedTickets.has(r.id)) return r
                const filtered = r.ticketIds.filter((id) => !adoptedIdSet.has(id))
                return filtered.length === r.ticketIds.length ? r : { ...r, ticketIds: filtered }
              })
            : merged
          saveRails(activeProjectId, deduped)
          return deduped
        })
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [activeProjectId, connectionStatus])

  // ── Adopt server-side rail names on load/switch (desktop ⇄ mobile sync) ──────
  // Names only — never ticketIds — so a fresh load can't clobber locally-dragged
  // assignments. A null server name leaves the local label untouched (so an
  // existing desktop-only custom label survives until explicitly renamed).
  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    fetch(`${getApiBase()}/rails`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { rails?: { railIndex: number; name?: string | null }[] } | null) => {
        if (cancelled || !data?.rails) return
        const nameByIndex = new Map<number, string | null>()
        for (const r of data.rails) nameByIndex.set(r.railIndex, r.name ?? null)
        setRails((prev) => {
          let changed = false
          const next = prev.map((r, pos) => {
            const idx = railIndexFromId(r.id) ?? pos
            const name = nameByIndex.get(idx) ?? null
            if (!name) return r
            const label = `Rail ${name}`
            if (label === r.label) return r
            changed = true
            return { ...r, label }
          })
          if (!changed) return prev
          saveRails(activeProjectId, next)
          return next
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeProjectId])

  // ── Auto-remove done / blocked on-review tickets from rails ─────────────────
  // When ticket status changes to 'done' (via WS ticket_updated, re-fetch, etc.),
  // strip those tickets from rails so they appear in Done Specs instead.
  // 'on_review' is stripped only while there is no real PR head to continue.
  // Once a draft/published PR exists, keeping the ticket on a rail is the
  // intentional "add another commit to this PR" flow.
  useEffect(() => {
    const doneIds = new Set(
      tickets
        .filter((t) => (
          t.status === 'done' ||
          (railPrDecisionsHydrated && t.status === 'on_review' && !ticketHasContinuablePr(t.id, railPrDecisions))
        ))
        .map((t) => t.id),
    )
    if (doneIds.size === 0) return
    setRails((prev) => {
      const next = prev.map((r) => {
        const filtered = r.ticketIds.filter((id) => !doneIds.has(id))
        if (filtered.length === r.ticketIds.length) return r
        return { ...r, ticketIds: filtered }
      })
      if (next.every((r, i) => r === prev[i])) return prev // no change
      saveRails(activeProjectId, next)
      return next
    })
    // `rails` is a dep so a reconcile ADOPTION that re-introduces a done ticket
    // is stripped too (the updater returns `prev` identity when nothing changes,
    // so this cannot loop).
  }, [tickets, activeProjectId, rails, railPrDecisions, railPrDecisionsHydrated])

  // Persist-aware spec order updater
  const updateSpecOrder = useCallback((updater: (prev: number[] | null) => number[] | null) => {
    setSpecOrderIds((prev) => {
      const next = updater(prev)
      saveSpecOrder(activeProjectId, next)
      return next
    })
  }, [activeProjectId])

  // Persist-aware rails updater
  const updateRails = useCallback((updater: (prev: RailState[]) => RailState[]) => {
    setRails((prev) => {
      const next = updater(prev)
      saveRails(activeProjectId, next)
      return next
    })
  }, [activeProjectId])

  // Dynamic container IDs for DnD (specs + all current rail IDs)
  const containerIds = useMemo(() => {
    const ids = new Set<string>(['specs', 'done-specs'])
    for (const r of rails) ids.add(r.id)
    return ids
  }, [rails])

  // ── Add / Delete rails ──────────────────────────────────────────────────────
  const handleAddRail = useCallback(async () => {
    // SERVER-BACKED creation: the new rail gets durable identity (survives a
    // reload, visible to the agent/MCP, mobile and other windows). Falls back
    // to a local-only slot when the request fails (offline) — a local rail
    // becomes server-backed on its first name/ticket sync anyway.
    try {
      const res = await fetch(`${getApiBase()}/rails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (res.ok) {
        const data = await res.json() as { rail?: { railIndex?: number } }
        const idx = data.rail?.railIndex
        if (typeof idx === 'number') {
          const id = railIdFromIndex(idx)
          updateRails((prev) => prev.some((r) => r.id === id)
            ? prev
            : [...prev, { id, label: `Rail ${idx + 1}`, ticketIds: [], mode: 'implement', status: 'idle' }])
          toast.success(t('toasts.railAdded', { n: idx + 1 }))
          return
        }
      } else {
        const data = await res.json().catch(() => ({ error: '' })) as { error?: string; maxRails?: number }
        if (data.error === 'rail_limit_reached') {
          toast.error(t('toasts.railLimitReached', { max: data.maxRails ?? MAX_RAILS }))
          return
        }
      }
    } catch { /* offline — fall through to the local-only slot */ }
    // Local fallback (legacy behavior): find the next available rail number.
    const existingNums = rails.map((r) => railIndexFromId(r.id)).filter((n): n is number => n !== null)
    const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 2 : 1
    const newRail: RailState = {
      id: `rail-${nextNum}`,
      label: `Rail ${nextNum}`,
      ticketIds: [],
      mode: 'implement',
      status: 'idle',
    }
    updateRails((prev) => [...prev, newRail])
    toast.success(t('toasts.railAdded', { n: nextNum }))
  }, [rails, updateRails, t])

  const handleDeleteRail = useCallback(async (railId: string) => {
    const rail = rails.find((r) => r.id === railId)
    if (!rail || rail.status === 'running') return
    const removeLocally = () => {
      // Return tickets to specs
      if (rail.ticketIds.length > 0) {
        updateSpecOrder((prev) => {
          const current = prev ?? []
          return [...current, ...rail.ticketIds]
        })
      }
      updateRails((prev) => prev.filter((r) => r.id !== railId))
      toast.info(t('toasts.railRemoved', { rail: rail.label }))
    }
    const railIndex = railIndexFromId(railId)
    if (railIndex === null) { removeLocally(); return }
    try {
      // The server releases assignments and removes the rail atomically after
      // validating last-rail, active-run, and pending-PR guards.
      const res = await fetch(`${getApiBase()}/rails/${railIndex}`, { method: 'DELETE' })
      // 404 = the server never knew this rail (legacy local-only) — still drop it.
      if (res.ok || res.status === 404) { removeLocally(); return }
      // 409 rail_active / pr_decision_pending, 400 last-rail:
      // the server knows something this board doesn't — keep the rail visible.
      toast.error(t('toasts.railDeleteFailed'))
    } catch {
      // Unknown server state: keep the rail visible until a successful retry
      // or refresh reconciles it. Optimistic removal here can desync the board.
      toast.error(t('toasts.railDeleteFailed'))
    }
  }, [rails, updateRails, updateSpecOrder, t])

  const handleRenameRail = useCallback((railId: string, newLabel: string) => {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, label: `Rail ${newLabel}` } : r)))
    // Sync the name to the server so the mobile companion (and any other
    // desktop client) reflects it live via rail.updated. EVERY rail has server
    // identity now — the PUT also materializes a legacy local-only rail's
    // rail_meta row, making it server-backed from then on.
    const idx = railIndexFromId(railId)
    if (idx !== null) {
      fetch(`${getApiBase()}/rails/${idx}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newLabel }),
      }).catch(() => { /* best-effort; localStorage already holds the label */ })
    }
  }, [updateRails])


  // ── WebSocket: listen for rail.job_completed to reset rail status ────────────
  const activeProjectIdRef = useRef(activeProjectId)
  useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])

  const handleRailWsMessage = useCallback((msg: unknown) => {
    const m = msg as {
      type?: string; projectId?: string; railIndex?: number | null; status?: string
      ticketIds?: number[]; changed?: 'tickets' | 'name' | 'profile' | 'engine'; name?: string | null
      mode?: string; jobId?: string; loopRunId?: string
    }
    if (m.projectId !== activeProjectIdRef.current) return

    // A rail started running ELSEWHERE — the MCP server, the mobile companion, or
    // another desktop tab. The local launch path (doLaunchRail) sets this
    // optimistically; mirror it for external launches so any rail the MCP starts
    // lights up here (status + the active id for "View Log"). Without this the
    // dashboard only ever reacted to the *completion* of an external launch, so
    // an MCP-launched rail looked idle the whole time it ran. Covers both the
    // legacy queue job (rail.job_started) and the loop run (loop.run_started)
    // paths; a loop run with railIndex==null is a Loops-page run, not a rail.
    if (m.type === 'rail.job_started' || m.type === 'loop.run_started') {
      if (m.railIndex == null) return
      const railId = railIdFromIndex(m.railIndex)
      const startedJobId = m.jobId ?? m.loopRunId
      updateRails((prev) => prev.map((r) =>
        r.id === railId ? { ...r, status: 'running' as const, activeJobId: startedJobId ?? r.activeJobId } : r
      ))
      return
    }

    // A rail's config changed elsewhere (mobile companion / another desktop).
    // Adopt the name on every variant; adopt ticketIds ONLY on a tickets-change
    // so a remote rename never wipes this client's locally-dragged assignments.
    // A railIndex this board doesn't know yet is a rail CREATED elsewhere (the
    // agent's create_rail, another window) — append its row live.
    if (m.type === 'rail.updated') {
      const idx = m.railIndex ?? 0
      const railId = railIdFromIndex(idx)
      const serverTicketIds = m.ticketIds ?? []
      const label = m.name ? `Rail ${m.name}` : `Rail ${idx + 1}`
      updateRails((prev) => {
        if (!prev.some((r) => r.id === railId)) {
          return [...prev, {
            id: railId,
            label,
            ticketIds: serverTicketIds,
            mode: isRailMode(m.mode) ? m.mode : 'implement',
            status: 'idle' as const,
          }]
        }
        return prev.map((r) => {
          if (r.id !== railId) return r
          // A running rail keeps its launched ticket set; still adopt the name.
          if (m.changed !== 'tickets' || r.status === 'running') return { ...r, label }
          return { ...r, label, ticketIds: serverTicketIds }
        })
      })
      return
    }

    // A rail was deleted elsewhere — drop the row (never a running one; the
    // server refuses to delete an active rail, so this is belt-and-braces).
    if (m.type === 'rail.removed') {
      if (m.railIndex == null) return
      const railId = railIdFromIndex(m.railIndex)
      updateRails((prev) => prev.filter((r) => r.id !== railId || r.status === 'running'))
      return
    }

    if (m.type === 'rail.worktree_progress') {
      const idx = m.railIndex ?? 0
      const ticketId = (m as { ticketId?: number }).ticketId
      const state = (m as { state?: WorktreeState }).state
      if (typeof ticketId === 'number' && state) {
        setRailWorktrees((prev) => applyWorktreeProgress(prev, idx, ticketId, state))
        if (state === 'needs-review') {
          toast.error(t('toasts.railWorktreeNeedsReview', { n: idx + 1, ticket: ticketId }))
        }
      }
      return
    }

    if (m.type === 'rail.job_completed') {
      const targetIndex = m.railIndex ?? 0
      // Strip this job's tickets from the rail on every terminal outcome so they
      // return to the Specs / Done column instead of being stranded on the rail.
      updateRails((prev) => applyRailJobOutcome(prev, targetIndex, m.ticketIds ?? []))

      if (m.status === 'completed') {
        toast.info(t('toasts.railCompleted', { n: targetIndex + 1 }))
      } else if (m.status === 'failed' || m.status === 'zombie_terminated') {
        toast.error(t('toasts.railFailed', { n: targetIndex + 1 }))
      } else {
        toast.info(t('toasts.railEnded', { n: targetIndex + 1, status: m.status ?? 'finished' }))
      }
    }

    // Loop runs (Loops mode) mirror rail.job_completed: strip the run's tickets
    // and reset the rail. The engine emits one completed event per per-ticket run.
    if (m.type === 'loop.run_completed') {
      const targetIndex = m.railIndex ?? 0
      updateRails((prev) => applyRailJobOutcome(prev, targetIndex, m.ticketIds ?? []))
      if (m.status === 'success') {
        toast.info(t('toasts.railCompleted', { n: targetIndex + 1 }))
      } else if (m.status === 'failed' || m.status === 'max-iterations') {
        toast.error(t('toasts.railFailed', { n: targetIndex + 1 }))
      } else {
        toast.info(t('toasts.railEnded', { n: targetIndex + 1, status: m.status ?? 'finished' }))
      }
    }
  }, [updateRails, t])

  useEffect(() => {
    registerHandler('dashboard-rails', handleRailWsMessage)
    return () => unregisterHandler('dashboard-rails')
  }, [handleRailWsMessage, registerHandler, unregisterHandler])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  // Custom collision detection. Two drag domains share the same DndContext:
  //   - Rail reorder (active.id starts with `__rail:`) — only other rail-sort
  //     wrappers should be considered as drop targets.
  //   - Ticket drag (active.id is a number) — only spec/rail body droppables
  //     and ticket items should be considered. Rail-sort wrappers (which
  //     overlap their inner rail body) must be excluded or `over.id` resolves
  //     to a prefixed string and the drop is dropped on the floor.
  // pointerWithin is the most natural fit for cross-container drops; rect /
  // closest-corners are fallbacks for edge-of-window or scroll situations.
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const activeIsRailSort = typeof args.active.id === 'string' && isRailSortId(args.active.id)
    const filtered = args.droppableContainers.filter((c) => {
      const id = c.id
      if (typeof id === 'string' && isRailSortId(id)) return activeIsRailSort
      return !activeIsRailSort
    })
    const scoped = { ...args, droppableContainers: filtered }
    if (activeIsRailSort) return closestCorners(scoped)
    const pointerCols = pointerWithin(scoped)
    if (getFirstCollision(pointerCols)) return pointerCols
    const rectCols = rectIntersection(scoped)
    if (getFirstCollision(rectCols)) return rectCols
    return closestCorners(scoped)
  }, [])

  // ── Derived maps ─────────────────────────────────────────────────────────────
  const ticketMap = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets])

  // ── Launch all (parallel) ────────────────────────────────────────────────────
  // Which rails a "Launch all" would start right now, and why the rest are
  // skipped. Eligible = idle + has specs + no uncontinuable PR delivery + no
  // spec frozen on review without an open PR head. Worktree isolation makes the
  // parallel fan-out safe.
  const launchAllPlan = useMemo(() => {
    const eligible: RailState[] = []
    const skipped: { rail: RailState; reason: LaunchAllSkipReason }[] = []
    rails.forEach((r, pos) => {
      const idx = railIndexFromId(r.id) ?? pos
      if (r.status === 'running') { skipped.push({ rail: r, reason: 'running' }); return }
      if (r.ticketIds.length === 0) { skipped.push({ rail: r, reason: 'empty' }); return }
      const decision = railPrDecisions.get(idx)
      if (decision && !prDecisionContinuesTickets(decision, r.ticketIds)) {
        skipped.push({ rail: r, reason: 'pendingDecision' }); return
      }
      if (r.ticketIds.some((id) => ticketMap.get(id)?.status === 'on_review' && (!railPrDecisionsHydrated || !ticketHasContinuablePr(id, railPrDecisions)))) {
        skipped.push({ rail: r, reason: 'onReview' }); return
      }
      eligible.push(r)
    })
    return { eligible, skipped }
  }, [rails, railPrDecisions, railPrDecisionsHydrated, ticketMap])

  const allTicketLabels = useMemo(() => {
    const set = new Set<string>()
    for (const t of tickets) for (const l of t.labels) set.add(l)
    return Array.from(set).sort()
  }, [tickets])

  const railTicketIds = useMemo(() => {
    const ids = new Set<number>()
    for (const r of rails) for (const id of r.ticketIds) ids.add(id)
    return ids
  }, [rails])

  // All spec-source tickets not in rails. `explore-draft` is the source of
  // tickets persisted via "Save as Draft" in ExploreSpecShell; they live on
  // the spec board until the user commits or discards them. `free-prompt` is
  // the source of Raw-mode specs (verbatim prompt, no AI at intake).
  const allSpecTickets = useMemo(() => {
    return tickets.filter(
      (t) =>
        (t.source === 'propose-spec' ||
          t.source === 'product-backlog' ||
          t.source === 'get-backlog-specs' ||
          t.source === 'explore-draft' ||
          t.source === 'specs-smash' ||
          t.source === 'free-prompt' ||
          // Specs created by an external LLM through the MCP server.
          t.source === 'mcp' ||
          // Day-0 specs committed by the Project Builder. The created_by
          // fallback keeps projects created before `project-builder` became a
          // first-class source visible without rewriting their ticket store.
          t.source === 'project-builder' ||
          (t.source === 'manual' && t.created_by === 'project-builder') ||
          // Jira-backed specs are materialized into local-tickets.json with
          // source:'jira' — they must show on the board like any other spec.
          t.source === 'jira') &&
        !railTicketIds.has(t.id),
    )
  }, [tickets, railTicketIds])

  // If a persisted "jira-key" sort survives into a project that has no
  // Jira-linked specs (disconnected, or never synced), the option is hidden in
  // the toolbar — fall back to default so the trigger never shows an unreachable
  // mode. Gated on !isLoading so a legit jira-key sort isn't reset before the
  // ticket list (and its jira_key fields) has loaded.
  useEffect(() => {
    if (isLoading) return
    if (sortMode === 'jira-key' && !allSpecTickets.some((t) => t.jira_key)) {
      handleSortChange('default', sortDir)
    }
  }, [isLoading, sortMode, sortDir, allSpecTickets, handleSortChange])

  // Active specs (not done). Default mode → user drag-order; sorted modes
  // → comparator applied to the unordered filtered list.
  const specTickets = useMemo(() => {
    const filtered = allSpecTickets.filter((t) => t.status !== 'done')
    if (sortMode !== 'default') return applySpecSort(filtered, sortMode, sortDir)
    if (!specOrderIds) return filtered
    const map = new Map(filtered.map((t) => [t.id, t]))
    const result: LocalTicket[] = []
    for (const id of specOrderIds) {
      const t = map.get(id)
      if (t) result.push(t)
    }
    for (const t of filtered) {
      if (!specOrderIds.includes(t.id)) result.push(t)
    }
    return result
  }, [allSpecTickets, specOrderIds, sortMode, sortDir])

  // Done specs own their sort/view controls inside the Done pane.
  const doneSpecTickets = useMemo(() => {
    return allSpecTickets.filter((t) => t.status === 'done')
  }, [allSpecTickets])

  const continuableReviewTicketIds = useMemo(() => {
    const ids = new Set<number>()
    if (!railPrDecisionsHydrated) return ids
    for (const ticket of tickets) {
      if (ticket.status === 'on_review' && ticketHasContinuablePr(ticket.id, railPrDecisions)) {
        ids.add(ticket.id)
      }
    }
    return ids
  }, [tickets, railPrDecisions, railPrDecisionsHydrated])

  // Shared assignment helper. Used both by the drag-and-drop ticket→rail
  // path (`handleDragEnd`) and by the `Move to Rail` popover on the
  // dashboard postit tier. Idempotent: re-assigning to the same rail is a
  // no-op; assigning to a different rail moves the ticket atomically.
  const handleMoveTicketToRail = useCallback((ticketId: number, railId: string) => {
    const targetRail = rails.find((r) => r.id === railId)
    if (!targetRail) return
    // On-review specs are frozen unless they already have a draft/published PR
    // head that a relaunch can continue.
    if (tickets.find((tk) => tk.id === ticketId)?.status === 'on_review' && (!railPrDecisionsHydrated || !ticketHasContinuablePr(ticketId, railPrDecisions))) {
      toast.info(t('toasts.onReviewCannotMoveToRail'))
      return
    }
    if (targetRail.ticketIds.includes(ticketId)) {
      toast.info(t('toasts.alreadyOnRail', { rail: targetRail.label }))
      return
    }
    updateSpecOrder((prev) => (prev ?? specTickets.map((t) => t.id)).filter((id) => id !== ticketId))
    updateRails((prev) => prev.map((r) => {
      if (r.id === railId) {
        return { ...r, ticketIds: [...r.ticketIds.filter((id) => id !== ticketId), ticketId] }
      }
      if (r.ticketIds.includes(ticketId)) {
        return { ...r, ticketIds: r.ticketIds.filter((id) => id !== ticketId) }
      }
      return r
    }))
    toast.success(t('toasts.movedToRail', { rail: targetRail.label }))
  }, [rails, tickets, specTickets, updateRails, updateSpecOrder, t, railPrDecisions, railPrDecisionsHydrated])

  // Reverse of `handleMoveTicketToRail`: remove a ticket from whatever rail
  // currently owns it and push it back to the spec list (appended to the
  // current spec order). No-op when the ticket isn't on any rail.
  const handleRemoveTicketFromRail = useCallback((ticketId: number) => {
    const sourceRail = rails.find((r) => r.ticketIds.includes(ticketId))
    if (!sourceRail) return
    if (sourceRail.status === 'running') {
      toast.error(t('toasts.railRunningStopFirst', { rail: sourceRail.label }))
      return
    }
    updateRails((prev) => prev.map((r) =>
      r.id === sourceRail.id ? { ...r, ticketIds: r.ticketIds.filter((id) => id !== ticketId) } : r,
    ))
    updateSpecOrder((prev) => {
      const current = prev ?? specTickets.map((t) => t.id)
      return current.includes(ticketId) ? current : [...current, ticketId]
    })
    toast.success(t('toasts.removedFromRail', { rail: sourceRail.label }))
  }, [rails, specTickets, updateRails, updateSpecOrder, t])

  // ── DnD helpers ──────────────────────────────────────────────────────────────
  const findContainer = useCallback(
    (ticketId: number): string | null => {
      if (specTickets.some((t) => t.id === ticketId)) return 'specs'
      if (doneSpecTickets.some((t) => t.id === ticketId)) return 'done-specs'
      for (const rail of rails) {
        if (rail.ticketIds.includes(ticketId)) return rail.id
      }
      return null
    },
    [specTickets, doneSpecTickets, rails],
  )

  // ── DnD handlers ─────────────────────────────────────────────────────────────
  function handleDragStart({ active }: DragStartEvent) {
    if (isRailSortId(active.id)) {
      const railId = extractRailId(active.id as string)
      const rail = rails.find((r) => r.id === railId)
      setActiveRailDragLabel(rail?.label ?? railId)
      return
    }
    setActiveId(active.id as number)
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null)
    setActiveRailDragLabel(null)
    if (!over) return

    // ── Rail reorder ─────────────────────────────────────────────────────────
    if (isRailSortId(active.id)) {
      if (!isRailSortId(over.id)) return
      const fromId = extractRailId(active.id as string)
      const toId = extractRailId(over.id as string)
      if (fromId === toId) return
      updateRails((prev) => {
        const oldIdx = prev.findIndex((r) => r.id === fromId)
        const newIdx = prev.findIndex((r) => r.id === toId)
        if (oldIdx === -1 || newIdx === -1) return prev
        return arrayMove(prev, oldIdx, newIdx)
      })
      return
    }

    const draggedId = active.id as number
    const overId = over.id

    const sourceContainer = findContainer(draggedId)
    if (!sourceContainer) return

    const destContainer = resolveDestContainer(
      overId,
      containerIds,
      findContainer,
      isRailSortId,
      extractRailId,
    ) ?? sourceContainer
    if (!containerIds.has(destContainer)) return

    if (sourceContainer === destContainer) {
      // ── Reorder within same container ─────────────────────────────────────
      if (destContainer === 'specs') {
        const ids = specTickets.map((t) => t.id)
        const oldIdx = ids.indexOf(draggedId)
        const newIdx = ids.indexOf(overId as number)
        if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
          const nextIds = arrayMove(ids, oldIdx, newIdx)
          updateSpecOrder(() => nextIds)
          if (sortMode !== 'default') {
            setSortMode('default')
            saveSpecSort(activeProjectId, 'default', sortDir)
          }
        }
      } else {
        updateRails((prev) =>
          prev.map((r) => {
            if (r.id !== destContainer) return r
            const oldIdx = r.ticketIds.indexOf(draggedId)
            const newIdx = r.ticketIds.indexOf(overId as number)
            if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
              return { ...r, ticketIds: arrayMove(r.ticketIds, oldIdx, newIdx) }
            }
            return r
          }),
        )
      }
    } else {
      // ── Move between containers ───────────────────────────────────────────

      // Specs → Done (mark ticket as done)
      if (sourceContainer === 'specs' && destContainer === 'done-specs') {
        if (tickets.find((tk) => tk.id === draggedId)?.status === 'on_review') {
          toast.info(t('toasts.onReviewCannotMoveToRail'))
          return
        }
        updateSpecOrder((prev) => (prev ?? specTickets.map((t) => t.id)).filter((id) => id !== draggedId))
        updateTicket(draggedId, { status: 'done' })
      }
      // Done → Specs (revert ticket to todo)
      else if (sourceContainer === 'done-specs' && destContainer === 'specs') {
        updateTicket(draggedId, { status: 'todo' })
        updateSpecOrder((prev) => {
          const current = prev ?? specTickets.map((t) => t.id)
          return insertAt(current, draggedId, overId)
        })
      }
      // Specs → Rail
      else if (sourceContainer === 'specs') {
        // Belt-and-braces: keep blocked on-review specs off rails, but allow the
        // documented "continue an open PR" path.
        if (tickets.find((tk) => tk.id === draggedId)?.status === 'on_review' && (!railPrDecisionsHydrated || !ticketHasContinuablePr(draggedId, railPrDecisions))) {
          toast.info(t('toasts.onReviewCannotMoveToRail'))
          return
        }
        const targetRail = rails.find((r) => r.id === destContainer)
        updateSpecOrder((prev) => (prev ?? specTickets.map((t) => t.id)).filter((id) => id !== draggedId))
        updateRails((prev) =>
          prev.map((r) => {
            if (r.id !== destContainer) return r
            return { ...r, ticketIds: insertAt(r.ticketIds, draggedId, overId) }
          }),
        )
        if (targetRail) {
          if (targetRail.status === 'running') {
            toast.info(t('toasts.queuedOnRail', { rail: targetRail.label }), { description: t('toasts.queuedOnRailDescription') })
          } else {
            toast.success(t('toasts.movedToRail', { rail: targetRail.label }))
          }
        }
      }
      // Rail → Specs
      else if (destContainer === 'specs') {
        const sourceRail = rails.find((r) => r.id === sourceContainer)
        if (sourceRail?.status === 'running') {
          toast.error(t('toasts.railRunningStopFirst', { rail: sourceRail.label }))
          return
        }
        updateRails((prev) =>
          prev.map((r) => {
            if (r.id !== sourceContainer) return r
            return { ...r, ticketIds: r.ticketIds.filter((id) => id !== draggedId) }
          }),
        )
        updateSpecOrder((prev) => {
          const current = prev ?? specTickets.map((t) => t.id)
          return insertAt(current, draggedId, overId)
        })
        if (sourceRail) toast.success(t('toasts.removedFromRail', { rail: sourceRail.label }))
      }
      // Done → Rail (revert to todo then add to rail)
      else if (sourceContainer === 'done-specs') {
        updateTicket(draggedId, { status: 'todo' })
        updateRails((prev) =>
          prev.map((r) => {
            if (r.id !== destContainer) return r
            return { ...r, ticketIds: insertAt(r.ticketIds, draggedId, overId) }
          }),
        )
      }
      // Rail → Done (mark as done, remove from rail)
      else if (destContainer === 'done-specs') {
        updateRails((prev) =>
          prev.map((r) => {
            if (r.id !== sourceContainer) return r
            return { ...r, ticketIds: r.ticketIds.filter((id) => id !== draggedId) }
          }),
        )
        updateTicket(draggedId, { status: 'done' })
      }
      // Rail → Rail
      else {
        updateRails((prev) =>
          prev.map((r) => {
            if (r.id === sourceContainer) {
              return { ...r, ticketIds: r.ticketIds.filter((id) => id !== draggedId) }
            }
            if (r.id === destContainer) {
              return { ...r, ticketIds: insertAt(r.ticketIds, draggedId, overId) }
            }
            return r
          }),
        )
      }
    }
  }

  // ── Rail controls ─────────────────────────────────────────────────────────────
  function handleModeChange(railId: string, mode: RailMode) {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, mode } : r)))
  }

  /** Server railIndex for a rail id — identity mapping (`rail-N` → N-1), with a
   *  positional fallback for exotic ids. -1 when the rail doesn't exist. */
  function serverRailIndex(railId: string): number {
    const idx = railIndexFromId(railId)
    if (idx !== null) return idx
    return rails.findIndex((r) => r.id === railId)
  }

  async function handleProfileChange(railId: string, profileName: string | null) {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, profileName } : r)))
    const railIndex = serverRailIndex(railId)
    if (railIndex === -1) return
    try {
      await fetch(`${getApiBase()}/rails/${railIndex}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileName }),
      })
    } catch {
      // Silent — server persistence is best-effort; localStorage holds the truth
      // and the profile will be sent inline in the next launch either way.
    }
  }

  function handleFreestyleModelChange(railId: string, model: import('../components/agents/RailModelSelector').FreestyleModel) {
    // Model lives in localStorage (like mode) and is sent inline at launch —
    // no dedicated server endpoint needed.
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, freestyleModel: model } : r)))
  }

  function handleLoopChange(railId: string, loopId: string) {
    // rails-as-loops: the chosen Loop (factory or custom) drives the rail; derive
    // the legacy `mode` from it so launch + selector gating stay correct. Stored
    // in localStorage and sent inline at launch.
    const mode = deriveRailMode(loopId)
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, selectedLoopId: loopId, mode } : r)))
  }

  function handleLoopModelChange(railId: string, model: string) {
    updateRails((prev) => prev.map((r) => {
      if (r.id !== railId) return r
      const provider = r.aiEngine ?? railProviders[0] ?? 'claude'
      const efforts = reasoningEffortsForProvider(provider, model)
      return {
        ...r,
        loopModel: model,
        reasoningEffort: r.reasoningEffort && efforts.includes(r.reasoningEffort)
          ? r.reasoningEffort
          : defaultReasoningEffortForProvider(provider, model) ?? null,
      }
    }))
  }

  function handleEffortChange(railId: string, effort: import('../components/agents/RailEffortSelector').ReasoningEffort) {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, reasoningEffort: effort } : r)))
  }

  async function handleEngineChange(railId: string, aiEngine: string) {
    // Preserve provider-owned Freestyle for capable adapters (Claude and Kimi).
    // When switching to an adapter without it, fall back to Implement so launch
    // cannot fail validation. Provider-specific model and effort selections are
    // also reset if the previous value is not accepted by the new adapter.
    updateRails((prev) => prev.map((r) => {
      if (r.id !== railId) return r
      const onFreestyle = r.mode === 'freestyle' || r.selectedLoopId === 'factory:freestyle'
      const fallback = !providerSupportsFreestyle(aiEngine) && onFreestyle
      const validModels = modelsForProvider(aiEngine)
      const modelIsValid = (value: string | null | undefined) =>
        Boolean(
          value
          && (
            validModels.some((model) => model.value === value)
            || (
              providerSupportsCustomModelAliases(aiEngine)
              && isSafeCustomModelAlias(value)
            )
          ),
        )
      const nextLoopModel = modelIsValid(r.loopModel)
        ? r.loopModel
        : defaultModelForProvider(aiEngine)
      const efforts = reasoningEffortsForProvider(aiEngine, nextLoopModel)
      return {
        ...r,
        aiEngine,
        mode: fallback ? 'implement' : r.mode,
        selectedLoopId: fallback ? 'factory:implement' : r.selectedLoopId,
        profileName: null,
        freestyleModel: modelIsValid(r.freestyleModel)
          ? r.freestyleModel
          : defaultModelForProvider(aiEngine),
        loopModel: nextLoopModel,
        reasoningEffort: r.reasoningEffort && efforts.includes(r.reasoningEffort)
          ? r.reasoningEffort
          : defaultReasoningEffortForProvider(aiEngine, nextLoopModel) ?? null,
      }
    }))
    const railIndex = serverRailIndex(railId)
    if (railIndex === -1) return
    try {
      await fetch(`${getApiBase()}/rails/${railIndex}/engine`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiEngine }),
      })
    } catch {
      // Best-effort persistence; localStorage holds the truth and the engine is
      // sent inline on the next launch regardless.
    }
  }

  function handleTargetPrChange(railId: string, value: RailTargetPr | null) {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, targetPr: value } : r)))
  }

  async function handleToggle(railId: string) {
    const rail = rails.find((r) => r.id === railId)
    const railIndex = serverRailIndex(railId)
    if (!rail || railIndex === -1) return

    if (rail.status === 'running') {
      // Stop via rails API
      try {
        await fetch(`${getApiBase()}/rails/${railIndex}/stop`, { method: 'POST' })
        updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, status: 'idle', activeJobId: undefined } : r)))
        toast.info(t('toasts.railStopped', { rail: rail.label }))
      } catch {
        toast.error(t('toasts.stopFailed'))
      }
      return
    }

    if (rail.ticketIds.length === 0) return

    // Freestyle bypasses OpenSpec and has variable cost — confirm before launch.
    if (rail.mode === 'freestyle') {
      setFreestyleConfirm({ railId })
      return
    }

    // Deliver-into-existing-PR: name the exact PR before launching into it.
    if (rail.targetPr) {
      setTargetPrConfirm({ railId })
      return
    }

    await doLaunchRail(railId)
  }

  async function doLaunchRail(railId: string, opts?: { silent?: boolean }): Promise<LaunchOutcome> {
    const silent = opts?.silent ?? false
    const rail = rails.find((r) => r.id === railId)
    const railIndex = serverRailIndex(railId)
    if (!rail || railIndex === -1) return 'failed'
    if (rail.ticketIds.length === 0) return 'skipped'

    // On-review specs are frozen unless they already have a draft/published PR
    // head that this launch can continue.
    if (rail.ticketIds.some((id) => tickets.find((tk) => tk.id === id)?.status === 'on_review' && (!railPrDecisionsHydrated || !ticketHasContinuablePr(id, railPrDecisions)))) {
      if (!silent) toast.info(t('toasts.onReviewNotLaunchable'))
      return 'skipped'
    }

    // rails-as-loops: every rail launches a Loop. Factory modes resolve to their
    // built-in loop; a custom (loop) rail needs an explicit pick.
    const launchLoopId = effectiveLoopId(rail.selectedLoopId, rail.mode)
    if (!launchLoopId) {
      if (!silent) toast.error(t('railControls.pickLoop'))
      return 'failed'
    }
    const launchProvider = rail.aiEngine ?? railProviders[0] ?? 'claude'
    const launchLoopModel = rail.loopModel ?? defaultModelForProvider(launchProvider)
    const launchEfforts = reasoningEffortsForProvider(launchProvider, launchLoopModel)
    const launchEffort = rail.reasoningEffort && launchEfforts.includes(rail.reasoningEffort)
      ? rail.reasoningEffort
      : null

    // M24: capture the API base ONCE up front. getApiBase() is a module-level
    // store that flips on project switch; evaluating it on both sides of the
    // await below let a mid-flight switch (e.g. desktop.project_added auto-activation,
    // a minimized-chat restore) send the ticket sync to project A but the launch
    // POST to project B — spawning a --dangerously-skip-permissions pipeline on the
    // wrong repo. Pinning the base keeps both calls on the project the user aimed at.
    const base = getApiBase()

    // Sync ticket assignments to server before launching
    try {
      await fetch(`${base}/rails/${railIndex}/tickets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketIds: rail.ticketIds }),
      })
    } catch {
      if (!silent) toast.error(t('toasts.syncTicketsFailed'))
      return 'failed'
    }

    // Launch via rails API — server handles job tracking + rail.job_completed events
    try {
      const res = await fetch(`${base}/rails/${railIndex}/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: rail.mode,
          // rail.profileName can be a string (explicit), null (force legacy),
          // or undefined (let server fall back to stored rail profile or defaults).
          ...(rail.profileName !== undefined ? { profileName: rail.profileName } : {}),
          // rail.aiEngine: explicit per-rail engine override; undefined → server
          // falls back to the stored rail engine or the project primary.
          ...(rail.aiEngine != null ? { aiEngine: rail.aiEngine } : {}),
          // Freestyle model picker — only meaningful for freestyle launches.
          ...(rail.mode === 'freestyle' && rail.freestyleModel ? { model: rail.freestyleModel } : {}),
          // Loop model picker — only meaningful for custom loop launches.
          ...(rail.mode === 'loop' && rail.loopModel ? { model: rail.loopModel } : {}),
          // Interactive toggle — only meaningful for freestyle launches.
          // rails-as-loops: always send the chosen Loop. The server maps a
          // factory loop → its legacy mode; a custom loop runs the loop engine.
          loopId: launchLoopId,
          ...(rail.mode === 'loop' && launchEffort ? { reasoning_effort: launchEffort } : {}),
          // Explicit delivery target (deliver-rail-into-existing-pr): the run
          // continues this open PR's head branch; settle pushes into it.
          ...(rail.targetPr ? { targetPrNumber: rail.targetPr.number } : {}),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: '' }))
        // Launch collision: this rail still has an unresolved PR decision — the
        // user must Create PR / Approve / Discard it before relaunching.
        if (res.status === 409 && data.error === 'pr_decision_pending') {
          if (!silent) toast.info(t('railPr.decisionPending'))
          return 'pendingDecision'
        }
        // A ticket of this rail is already being worked by an active run
        // (concurrent-launch guard) — treat as skipped, not failed.
        if (res.status === 409 && data.error === 'tickets_in_flight') {
          if (!silent) toast.info(t('toasts.launchTicketsInFlight'))
          return 'skipped'
        }
        // Explicit-target validation failed server-side (fail-closed — no
        // fallback launch happened). Surface the exact reason; keep the
        // selection so the user can fix or clear it.
        const targetCodes = ['invalid_target_pr', 'target_pr_requires_pr_mode', 'target_pr_not_found', 'target_pr_not_open', 'target_pr_fork', 'target_pr_invalid', 'target_pr_unfetchable']
        if (typeof data.error === 'string' && targetCodes.includes(data.error)) {
          if (!silent) {
            toast.error(t(`targetPr.errors.${data.error}`), {
              description: (data as { detail?: string }).detail,
              duration: 10000,
            })
          }
          return 'failed'
        }
        if (!silent) toast.error(data.error || t('toasts.launchFailed'))
        return 'failed'
      }
      // Implement/freestyle return { jobId }; loop mode returns { loopRunIds }.
      // A loop run IS backed by a job (id === loopRunId), so set activeJobId to
      // the first run id → "View Log" → /jobs/:id streams the live session.
      const data = await res.json() as { jobId?: string; loopRunIds?: string[]; isolationUnavailable?: string; isolationUnavailableDetail?: string }
      // Suppressed in silent (batch) mode — a non-git repo would fire one toast
      // per rail; the launch itself still proceeds on the shared cwd.
      if (!silent && data.isolationUnavailable === 'no-git') {
        toast.info(t('toasts.railWorktreesNoGit'))
      } else if (!silent && data.isolationUnavailable === 'no-commits') {
        toast.info(t('toasts.railWorktreesNoCommits'))
      } else if (!silent && data.isolationUnavailable === 'error') {
        // Isolation THREW → the run proceeds on the shared cwd WITHOUT the
        // ask-first PR flow (no delivery row → no implementation card). Must be
        // loud + carry the server's reason, or the missing card is undebuggable.
        toast.warning(t('toasts.railWorktreesError'), {
          description: data.isolationUnavailableDetail,
          duration: 12000,
        })
      }
      const activeJobId = data.jobId ?? data.loopRunIds?.[0]
      // targetPr is a ONE-SHOT designation: consumed by this launch (the
      // delivery row now owns the PR link); the next launch defaults to New PR.
      updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, status: 'running', activeJobId, targetPr: null } : r)))
      if (!silent) {
        toast.success(t('toasts.railLaunched', { rail: rail.label }), {
          description: t('toasts.launchDescription', { mode: rail.mode, count: rail.ticketIds.length }),
        })
      }
      return 'launched'
    } catch {
      if (!silent) toast.error(t('toasts.launchNetworkError'))
      return 'failed'
    }
  }

  // ── Launch all: confirm → parallel fan-out → one summary toast ─────────────
  function handleLaunchAll() {
    if (launchAllPlan.eligible.length === 0) {
      toast.info(t('toasts.launchAllNoneEligible'))
      return
    }
    setLaunchAllConfirm(true)
  }

  async function runLaunchAll() {
    setLaunchAllConfirm(false)
    const { eligible, skipped } = launchAllPlan
    if (eligible.length === 0) {
      toast.info(t('toasts.launchAllNoneEligible'))
      return
    }
    // Parallel fan-out of the SAME per-rail launch path the Play button uses
    // (ticket sync → POST launch). Safe to run concurrently: each launch
    // isolates its work in per-ticket git worktrees server-side.
    const settled = await Promise.allSettled(
      eligible.map((r) => doLaunchRail(r.id, { silent: true })),
    )
    let launched = 0
    let failed = 0
    let pendingDecision = 0
    let skippedLate = 0
    for (const s of settled) {
      const v: LaunchOutcome = s.status === 'fulfilled' ? s.value : 'failed'
      if (v === 'launched') launched++
      else if (v === 'pendingDecision') pendingDecision++
      else if (v === 'skipped') skippedLate++
      else failed++
    }
    // One compact summary toast: launched count + per-reason skip breakdown.
    const counts = new Map<LaunchAllSkipReason, number>()
    for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1)
    if (pendingDecision > 0) counts.set('pendingDecision', (counts.get('pendingDecision') ?? 0) + pendingDecision)
    const reasonKey: Record<LaunchAllSkipReason, string> = {
      running: 'launchAll.skipRunning',
      empty: 'launchAll.skipEmpty',
      pendingDecision: 'launchAll.skipPendingDecision',
      onReview: 'launchAll.skipOnReview',
    }
    const parts: string[] = []
    for (const [reason, count] of counts) {
      if (count > 0) parts.push(t(reasonKey[reason], { count }))
    }
    if (skippedLate > 0) parts.push(t('launchAll.skipInFlight', { count: skippedLate }))
    if (failed > 0) parts.push(t('launchAll.failedCount', { count: failed }))
    const description = parts.length > 0 ? parts.join(' · ') : undefined
    if (launched > 0) {
      toast.success(t('toasts.launchAllSummary', { count: launched }), description ? { description } : undefined)
    } else {
      toast.error(t('toasts.launchAllFailed'), description ? { description } : undefined)
    }
  }

  const activeTicket = activeId !== null ? ticketMap.get(activeId) : undefined

  const dashboardContainerRef = useRef<HTMLDivElement | null>(null)
  const { leftWidth, enabled: splitterEnabled, beginDrag, resetToDefault } = useDashboardSplit(activeProjectId, dashboardContainerRef)
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200

  return (
    <JiraDiscardProvider>
    <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div ref={dashboardContainerRef} className="relative z-0 flex h-full overflow-hidden">
        {isGalaxy && <Starfield />}
        {/* Left panel: Specs board */}
        <div
          className="relative z-10 min-w-0 flex flex-col overflow-hidden"
          style={splitterEnabled && leftWidth !== null
            ? { width: `${leftWidth}px`, flex: '0 0 auto' }
            : { flex: '1 1 0%' }}
        >
          <SpecsBoard
            tickets={specTickets}
            allTickets={tickets}
            doneTickets={doneSpecTickets}
            isLoading={isLoading}
            error={ticketsError}
            onRetry={() => { void refetch() }}
            onTicketClick={setDetailTicket}
            onTicketCreated={(ticket) => { setDetailTicket(ticket); refetch() }}
            onTicketDelete={(id) => deleteTicket(id)}
            onTicketStatusChange={(id, status) => { void updateTicketStatus(id, status) }}
            onTicketPriorityChange={(id, priority) => { void updateTicketPriority(id, priority) }}
            contractRefiningIds={contractRefiningIds}
            sortMode={sortMode}
            sortDir={sortDir}
            onSortChange={handleSortChange}
            viewTier={viewTier}
            onViewTierChange={handleViewTierChange}
            rails={rails}
            onMoveToRail={handleMoveTicketToRail}
            continuableReviewTicketIds={continuableReviewTicketIds}
          />
        </div>

        {/* Splitter — only mounted when the viewport is wide enough. */}
        {splitterEnabled && leftWidth !== null && (
          <DashboardSplitter
            leftWidth={leftWidth}
            viewport={viewportWidth}
            onPointerDown={beginDrag}
            onReset={resetToDefault}
          />
        )}

        {/* Right panel: Rails board. The visual separator is rendered by
            `DashboardSplitter` (a centered 1px rule inside its 6px hit area);
            adding a `border-l` here would duplicate the line. */}
        <div className="relative z-10 flex-1 min-w-0 flex flex-col overflow-hidden">
          <RailsBoard
            rails={rails}
            ticketMap={ticketMap}
            railWorktrees={railWorktrees}
            railMetrics={railMetrics}
            railPrDecisions={railPrDecisions}
            onPrDecision={actRailPrDecision}
            onPrCheckout={checkoutRailPrBranch}
            providers={railProviders}
            onModeChange={handleModeChange}
            onProfileChange={handleProfileChange}
            onEngineChange={handleEngineChange}
            onFreestyleModelChange={handleFreestyleModelChange}
            onLoopModelChange={handleLoopModelChange}
            loopAvailable={FEATURE_LOOPS_SECTION}
            onLoopChange={handleLoopChange}
            onEffortChange={handleEffortChange}
            onToggle={handleToggle}
            onTargetPrChange={handleTargetPrChange}
            onTicketClick={setDetailTicket}
            onAddRail={() => { void handleAddRail() }}
            onDeleteRail={(railId) => { void handleDeleteRail(railId) }}
            onRenameRail={handleRenameRail}
            onTicketMoveToSpecs={handleRemoveTicketFromRail}
            onLaunchAll={handleLaunchAll}
            launchAllCount={launchAllPlan.eligible.length}
          />
        </div>
      </div>

      {/* Drag overlay — renders a floating ghost while dragging. Matches the
          active view tier so a postit dragged from the postit grid keeps
          looking like a postit instead of collapsing back to a compact row. */}
      <DragOverlay dropAnimation={{ duration: 180, easing: 'ease' }}>
        {activeTicket ? (
          viewTier === 'postit' ? (
            <div className="flex flex-col gap-2 rounded-xl border border-accent-info/40 bg-card/95 shadow-xl shadow-black/30 backdrop-blur-sm p-3 rotate-1 scale-[1.02] pointer-events-none w-[260px] min-h-[180px]">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[10px] font-mono text-muted-foreground/60">#{activeTicket.id}</span>
                {activeTicket.priority && (
                  <span className="h-4 px-1.5 rounded-full text-[9px] font-medium uppercase bg-muted/40 text-foreground">
                    {activeTicket.priority}
                  </span>
                )}
              </div>
              <h3 className="text-sm font-medium leading-snug line-clamp-2 text-foreground">
                {activeTicket.title}
              </h3>
              {activeTicket.short_summary && activeTicket.short_summary.trim().length > 0 && (
                <p className="text-xs text-muted-foreground/80 leading-relaxed line-clamp-3 italic">
                  {activeTicket.short_summary}
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-primary/40 bg-card/95 shadow-xl shadow-black/20 backdrop-blur-sm rotate-1 scale-[1.03] pointer-events-none">
              <span className="text-[10px] font-mono text-muted-foreground/50 shrink-0">#{activeTicket.id}</span>
              <span className="flex-1 text-sm truncate max-w-[240px]">{activeTicket.title}</span>
            </div>
          )
        ) : activeRailDragLabel ? (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-primary/40 bg-card/95 shadow-xl shadow-black/20 backdrop-blur-sm rotate-[0.5deg] scale-[1.02] pointer-events-none">
            <span className="text-xs font-medium">{activeRailDragLabel}</span>
          </div>
        ) : null}
      </DragOverlay>

      {/* Modals */}
      {detailTicket && (() => {
        // Keep the modal's ticket in sync with the latest version from the
        // tickets list (so WS updates — e.g. is_epic=true after SMASH —
        // propagate without closing/reopening the modal).
        const fresh = tickets.find((t) => t.id === detailTicket.id) ?? detailTicket
        return (
          // key={ticket.id} forces a fresh mount when navigating across the
          // SMASH family (Epic ↔ Sub-Spec) so the modal's internal state
          // (title/desc/priority) is re-initialised from the new ticket.
          <TicketDetailModal
            key={fresh.id}
            ticket={fresh}
            allLabels={allTicketLabels}
            allTickets={tickets}
            onClose={() => setDetailTicket(null)}
            onOpenTicket={(id) => {
              const next = tickets.find((t) => t.id === id)
              if (next) setDetailTicket(next)
            }}
            onSave={updateTicket}
            onDelete={deleteTicket}
            rails={rails}
            onMoveToRail={handleMoveTicketToRail}
            onRemoveFromRail={handleRemoveTicketFromRail}
          />
        )
      })()}
      <CreateTicketModal
        open={createTicketOpen}
        allLabels={allTicketLabels}
        onClose={() => setCreateTicketOpen(false)}
        onCreate={createTicket}
      />

      <LaunchAllDialog
        open={launchAllConfirm}
        railCount={launchAllPlan.eligible.length}
        specCount={launchAllPlan.eligible.reduce((sum, r) => sum + r.ticketIds.length, 0)}
        onCancel={() => setLaunchAllConfirm(false)}
        onConfirm={() => { void runLaunchAll() }}
      />

      {(() => {
        const r = targetPrConfirm ? rails.find((x) => x.id === targetPrConfirm.railId) : undefined
        return (
          <TargetPrLaunchDialog
            open={!!targetPrConfirm && !!r?.targetPr}
            target={r?.targetPr ?? null}
            onCancel={() => setTargetPrConfirm(null)}
            onConfirm={() => {
              const id = targetPrConfirm?.railId
              setTargetPrConfirm(null)
              if (id) void doLaunchRail(id)
            }}
          />
        )
      })()}

      {(() => {
        const r = freestyleConfirm ? rails.find((x) => x.id === freestyleConfirm.railId) : undefined
        const provider = r?.aiEngine ?? railProviders[0] ?? 'claude'
        return (
          <FreestyleLaunchDialog
            open={!!freestyleConfirm && !!r}
            railLabel={r?.label ?? ''}
            specCount={r?.ticketIds.length ?? 0}
            provider={provider}
            model={r?.freestyleModel ?? defaultModelForProvider(provider)}
            onCancel={() => setFreestyleConfirm(null)}
            onConfirm={() => {
              const id = freestyleConfirm?.railId
              setFreestyleConfirm(null)
              if (id) void doLaunchRail(id)
            }}
          />
        )
      })()}
    </DndContext>
    </JiraDiscardProvider>
  )
}
