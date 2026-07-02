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
import { DashboardSplitter } from '../components/DashboardSplitter'
import { useDashboardSplit } from '../hooks/useDashboardSplit'
import { TicketDetailModal } from '../components/TicketDetailModal'
import { CreateTicketModal } from '../components/CreateTicketModal'
import { UltracodeLaunchDialog } from '../components/UltracodeLaunchDialog'
import { getApiBase } from '../lib/api'
import { FEATURE_LOOPS_SECTION } from '../lib/feature-flags'
import { effectiveLoopId, deriveRailMode } from '../lib/rail-loops'
import { useDesktop, projectProviders } from '../hooks/useDesktop'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import { useSpecGenTracker } from '../hooks/useSpecGenTracker'
import type { LocalTicket } from '../types'
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
  ultracodeModel?: import('../components/agents/RailModelSelector').UltracodeModel | null
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
  const railProviders = (() => {
    const p = projects.find((pr) => pr.id === activeProjectId)
    return p ? projectProviders(p) : ['claude']
  })()
  const { tickets, isLoading, updateTicket, updateTicketStatus, updateTicketPriority, deleteTicket, createTicket, refetch, contractRefiningIds } = useTickets()
  const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()
  const { specToOpen, clearSpecToOpen } = useSpecGenTracker()
  const [detailTicket, setDetailTicket] = useState<LocalTicket | null>(null)
  const [createTicketOpen, setCreateTicketOpen] = useState(false)
  // Rail pending an ultracode-launch confirmation (variable-cost warning modal).
  const [ultracodeConfirm, setUltracodeConfirm] = useState<{ railId: string } | null>(null)

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

  // ── Reconcile stale 'running' rails on mount / project switch / WS reconnect ─
  // If the user navigates away while a rail is running, the WS handler is
  // unregistered and the rail.job_completed event is missed. Also, after a
  // server restart the WS reconnects but stale 'running' state persists in
  // localStorage. On re-mount or reconnect, check the server for active rail
  // jobs and reset any stale 'running' rails.
  useEffect(() => {
    if (connectionStatus !== 'connected') return
    const currentRails = loadRails(activeProjectId) ?? INITIAL_RAILS
    const hasRunning = currentRails.some((r) => r.status === 'running')
    if (!hasRunning || !activeProjectId) return

    let cancelled = false
    fetch(`${getApiBase()}/rails`)
      .then((res) => res.ok ? res.json() : null)
      .then((data: { activeJobs?: Record<string, { jobId: string }>; activeLoopRuns?: Record<string, { loopRunId: string }> } | null) => {
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
        setRails((prev) => {
          const next = prev.map((r, idx) => {
            if (r.status !== 'running') return r
            if (activeIndices.has(idx)) {
              // Still running — restore the active id (job or loop run) if lost.
              const serverJobId = activeJobs[String(idx)]?.jobId ?? activeLoopRuns[String(idx)]?.loopRunId
              if (serverJobId && !r.activeJobId) return { ...r, activeJobId: serverJobId }
              return r
            }
            // Rail was running but server has no active job → job finished while
            // we were away. Clear tickets so they reappear in Specs/Done based
            // on their current server-side status (useTickets re-fetches on mount).
            return { ...r, status: 'idle' as const, activeJobId: undefined, ticketIds: [] }
          })
          saveRails(activeProjectId, next)
          return next
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
          const next = prev.map((r) => {
            const n = parseInt(r.id.replace('rail-', ''), 10)
            if (n < 1 || n > 3) return r
            const name = nameByIndex.get(n - 1) ?? null
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

  // ── Auto-remove done tickets from rails ──────────────────────────────────────
  // When ticket status changes to 'done' (via WS ticket_updated, re-fetch, etc.),
  // strip those tickets from rails so they appear in Done Specs instead.
  useEffect(() => {
    const doneIds = new Set(tickets.filter((t) => t.status === 'done').map((t) => t.id))
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
  }, [tickets, activeProjectId])

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
  const handleAddRail = useCallback(() => {
    // Find next available rail number
    const existingNums = rails.map((r) => parseInt(r.id.replace('rail-', ''), 10))
    const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1
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

  const handleDeleteRail = useCallback((railId: string) => {
    const rail = rails.find((r) => r.id === railId)
    if (!rail || rail.status === 'running') return
    // Return tickets to specs
    if (rail.ticketIds.length > 0) {
      updateSpecOrder((prev) => {
        const current = prev ?? []
        return [...current, ...rail.ticketIds]
      })
    }
    updateRails((prev) => prev.filter((r) => r.id !== railId))
    toast.info(t('toasts.railRemoved', { rail: rail.label }))
  }, [rails, updateRails, updateSpecOrder, t])

  const handleRenameRail = useCallback((railId: string, newLabel: string) => {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, label: `Rail ${newLabel}` } : r)))
    // Sync the name to the server so the mobile companion (and any other
    // desktop client) reflects it live via rail.updated. Only the canonical
    // rails 0..2 exist server-side; locally-added rails (rail-4+) are skipped.
    const n = parseInt(railId.replace('rail-', ''), 10)
    if (n >= 1 && n <= 3) {
      fetch(`${getApiBase()}/rails/${n - 1}/name`, {
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
      jobId?: string; loopRunId?: string
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
      const railId = `rail-${m.railIndex + 1}`
      const startedJobId = m.jobId ?? m.loopRunId
      updateRails((prev) => prev.map((r) =>
        r.id === railId ? { ...r, status: 'running' as const, activeJobId: startedJobId ?? r.activeJobId } : r
      ))
      return
    }

    // A rail's config changed elsewhere (mobile companion / another desktop).
    // Adopt the name on every variant; adopt ticketIds ONLY on a tickets-change
    // so a remote rename never wipes this client's locally-dragged assignments.
    if (m.type === 'rail.updated') {
      const idx = m.railIndex ?? 0
      const railId = `rail-${idx + 1}`
      const serverTicketIds = m.ticketIds ?? []
      const label = m.name ? `Rail ${m.name}` : `Rail ${idx + 1}`
      updateRails((prev) => prev.map((r) => {
        if (r.id !== railId) return r
        // A running rail keeps its launched ticket set; still adopt the name.
        if (m.changed !== 'tickets' || r.status === 'running') return { ...r, label }
        return { ...r, label, ticketIds: serverTicketIds }
      }))
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

  // Shared assignment helper. Used both by the drag-and-drop ticket→rail
  // path (`handleDragEnd`) and by the `Move to Rail` popover on the
  // dashboard postit tier. Idempotent: re-assigning to the same rail is a
  // no-op; assigning to a different rail moves the ticket atomically.
  const handleMoveTicketToRail = useCallback((ticketId: number, railId: string) => {
    const targetRail = rails.find((r) => r.id === railId)
    if (!targetRail) return
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
  }, [rails, specTickets, updateRails, updateSpecOrder, t])

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

  async function handleProfileChange(railId: string, profileName: string | null) {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, profileName } : r)))
    const railIndex = rails.findIndex((r) => r.id === railId)
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

  function handleUltracodeModelChange(railId: string, model: import('../components/agents/RailModelSelector').UltracodeModel) {
    // Model lives in localStorage (like mode) and is sent inline at launch —
    // no dedicated server endpoint needed.
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, ultracodeModel: model } : r)))
  }

  function handleLoopChange(railId: string, loopId: string) {
    // rails-as-loops: the chosen Loop (factory or custom) drives the rail; derive
    // the legacy `mode` from it so launch + selector gating stay correct. Stored
    // in localStorage and sent inline at launch.
    const mode = deriveRailMode(loopId)
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, selectedLoopId: loopId, mode } : r)))
  }

  function handleLoopModelChange(railId: string, model: string) {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, loopModel: model } : r)))
  }

  function handleEffortChange(railId: string, effort: import('../components/agents/RailEffortSelector').ReasoningEffort) {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, reasoningEffort: effort } : r)))
  }

  async function handleEngineChange(railId: string, aiEngine: string) {
    // Ultracode is Claude-only — if the rail leaves Claude while on the Ultracode
    // loop, fall back to the Implement loop so the launch can't 400.
    updateRails((prev) => prev.map((r) => {
      if (r.id !== railId) return r
      const onUltra = r.mode === 'ultracode' || r.selectedLoopId === 'factory:ultracode'
      const fallback = aiEngine !== 'claude' && onUltra
      return {
        ...r,
        aiEngine,
        mode: fallback ? 'implement' : r.mode,
        selectedLoopId: fallback ? 'factory:implement' : r.selectedLoopId,
      }
    }))
    const railIndex = rails.findIndex((r) => r.id === railId)
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

  async function handleToggle(railId: string) {
    const railIndex = rails.findIndex((r) => r.id === railId)
    if (railIndex === -1) return
    const rail = rails[railIndex]

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

    // Ultracode bypasses OpenSpec and has variable cost — confirm before launch.
    if (rail.mode === 'ultracode') {
      setUltracodeConfirm({ railId })
      return
    }

    await doLaunchRail(railId)
  }

  async function doLaunchRail(railId: string) {
    const railIndex = rails.findIndex((r) => r.id === railId)
    if (railIndex === -1) return
    const rail = rails[railIndex]
    if (rail.ticketIds.length === 0) return

    // rails-as-loops: every rail launches a Loop. Factory modes resolve to their
    // built-in loop; a custom (loop) rail needs an explicit pick.
    const launchLoopId = effectiveLoopId(rail.selectedLoopId, rail.mode)
    if (!launchLoopId) {
      toast.error(t('railControls.pickLoop'))
      return
    }

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
      toast.error(t('toasts.syncTicketsFailed'))
      return
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
          // Ultracode model picker — only meaningful for ultracode launches.
          ...(rail.mode === 'ultracode' && rail.ultracodeModel ? { model: rail.ultracodeModel } : {}),
          // Loop model picker — only meaningful for custom loop launches.
          ...(rail.mode === 'loop' && rail.loopModel ? { model: rail.loopModel } : {}),
          // Interactive toggle — only meaningful for ultracode launches.
          // rails-as-loops: always send the chosen Loop. The server maps a
          // factory loop → its legacy mode; a custom loop runs the loop engine.
          loopId: launchLoopId,
          ...(rail.mode === 'loop' && rail.reasoningEffort ? { reasoning_effort: rail.reasoningEffort } : {}),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: '' }))
        toast.error(data.error || t('toasts.launchFailed'))
        return
      }
      // Implement/ultracode return { jobId }; loop mode returns { loopRunIds }.
      // A loop run IS backed by a job (id === loopRunId), so set activeJobId to
      // the first run id → "View Log" → /jobs/:id streams the live session.
      const data = await res.json() as { jobId?: string; loopRunIds?: string[]; isolationUnavailable?: string }
      if (data.isolationUnavailable === 'no-git') {
        toast.info(t('toasts.railWorktreesNoGit'))
      } else if (data.isolationUnavailable === 'no-commits') {
        toast.info(t('toasts.railWorktreesNoCommits'))
      }
      const activeJobId = data.jobId ?? data.loopRunIds?.[0]
      updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, status: 'running', activeJobId } : r)))
      toast.success(t('toasts.railLaunched', { rail: rail.label }), {
        description: t('toasts.launchDescription', { mode: rail.mode, count: rail.ticketIds.length }),
      })
    } catch {
      toast.error(t('toasts.launchNetworkError'))
    }
  }

  const activeTicket = activeId !== null ? ticketMap.get(activeId) : undefined

  const dashboardContainerRef = useRef<HTMLDivElement | null>(null)
  const { leftWidth, enabled: splitterEnabled, beginDrag, resetToDefault } = useDashboardSplit(activeProjectId, dashboardContainerRef)
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200

  return (
    <JiraDiscardProvider>
    <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div ref={dashboardContainerRef} className="flex h-full overflow-hidden">
        {/* Left panel: Specs board */}
        <div
          className="min-w-0 flex flex-col overflow-hidden"
          style={splitterEnabled && leftWidth !== null
            ? { width: `${leftWidth}px`, flex: '0 0 auto' }
            : { flex: '1 1 0%' }}
        >
          <SpecsBoard
            tickets={specTickets}
            allTickets={tickets}
            doneTickets={doneSpecTickets}
            isLoading={isLoading}
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
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <RailsBoard
            rails={rails}
            ticketMap={ticketMap}
            railWorktrees={railWorktrees}
            railMetrics={railMetrics}
            providers={railProviders}
            onModeChange={handleModeChange}
            onProfileChange={handleProfileChange}
            onEngineChange={handleEngineChange}
            onUltracodeModelChange={handleUltracodeModelChange}
            onLoopModelChange={handleLoopModelChange}
              loopAvailable={FEATURE_LOOPS_SECTION}
            onLoopChange={handleLoopChange}
            onEffortChange={handleEffortChange}
            onToggle={handleToggle}
            onTicketClick={setDetailTicket}
            onAddRail={handleAddRail}
            onDeleteRail={handleDeleteRail}
            onRenameRail={handleRenameRail}
            onTicketMoveToSpecs={handleRemoveTicketFromRail}
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
            onDelete={(id) => {
              deleteTicket(id)
              setDetailTicket(null)
            }}
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

      {(() => {
        const r = ultracodeConfirm ? rails.find((x) => x.id === ultracodeConfirm.railId) : undefined
        return (
          <UltracodeLaunchDialog
            open={!!ultracodeConfirm && !!r}
            railLabel={r?.label ?? ''}
            specCount={r?.ticketIds.length ?? 0}
            model={r?.ultracodeModel ?? 'sonnet'}
            onCancel={() => setUltracodeConfirm(null)}
            onConfirm={() => {
              const id = ultracodeConfirm?.railId
              setUltracodeConfirm(null)
              if (id) void doLaunchRail(id)
            }}
          />
        )
      })()}
    </DndContext>
    </JiraDiscardProvider>
  )
}
