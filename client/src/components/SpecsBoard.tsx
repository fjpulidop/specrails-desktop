import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { FileText, Plus, CheckCircle2 } from 'lucide-react'
import { Button } from './ui/button'
import { SpecCard } from './SpecCard'
import { TicketPostitCard } from './TicketPostitCard'
import { TicketContextMenu } from './TicketContextMenu'
import type { TicketStatus, TicketPriority } from '../types'
import type { RailState } from './RailsBoard'
import { SpecLabelFilterDropdown } from './SpecLabelFilterDropdown'
import { SpecEpicFilterDropdown } from './SpecEpicFilterDropdown'
import { SpecSprintFilterDropdown } from './SpecSprintFilterDropdown'
import { SpecStatusFilter } from './SpecStatusFilter'
import { SpecJiraStatusFilterDropdown } from './SpecJiraStatusFilterDropdown'
import {
  isSpecStatusFilterValue,
  loadSpecStatusFilter,
  saveSpecStatusFilter,
  statusMatchesFilter,
  type SpecStatusFilterValue,
} from '../lib/spec-status-filter'
import { SpecSortControl } from './SpecSortControl'
import { SpecsViewTierToggle } from './SpecsViewTierToggle'
import type { SpecsViewTier } from '../lib/specs-view-tier'
import { applySpecSort } from '../lib/spec-sort'
import { loadSpecFilters, saveSpecFilters } from '../lib/spec-filters'
import type { SpecSortMode, SpecSortDir } from '../types/spec-sort'
import { ProposeSpecModal, type ExploreLaunchPayload } from './ProposeSpecModal'
import { ExploreSpecShell } from './explore-spec/ExploreSpecShell'
import { ShellErrorBoundary } from './ShellErrorBoundary'
import { useMinimizedChats, usePendingRestore } from '../context/MinimizedChatsContext'
import { useDesktop } from '../hooks/useDesktop'
import i18n from '../lib/i18n'
import { deleteAllAttachments } from '../lib/attachments'
import {
  loadActiveExploreSpec,
  saveActiveExploreSpec,
  clearActiveExploreSpec,
} from '../lib/active-explore-spec'
import type { LocalTicket } from '../types'

interface SpecsBoardProps {
  /** Pre-ordered, pre-filtered active tickets (ordering + filtering owned by parent). */
  tickets: LocalTicket[]
  /** Full unfiltered ticket list (for new-ticket detection in ProposeSpec modal). */
  allTickets?: LocalTicket[]
  /** Tickets that have been implemented (status=done). */
  doneTickets?: LocalTicket[]
  isLoading: boolean
  onTicketClick: (ticket: LocalTicket) => void
  onTicketCreated?: (ticket: LocalTicket) => void
  /** Delete handler — when provided, long-press on cards enters jiggle mode
   *  and reveals a per-card delete button. */
  onTicketDelete?: (ticketId: number) => void
  contractRefiningIds?: Set<number>
  sortMode?: SpecSortMode
  sortDir?: SpecSortDir
  onSortChange?: (mode: SpecSortMode, dir: SpecSortDir) => void
  /**
   * Current view: `'postit'` renders a grid of square `TicketPostitCard`s;
   * `'row'` renders the compact list. User-controlled via the in-toolbar
   * toggle; persisted per project by the parent.
   */
  viewTier?: SpecsViewTier
  /** Called when the user clicks the row/post-it toggle in the toolbar. */
  onViewTierChange?: (tier: SpecsViewTier) => void
  /** Rails available in the project — required for the postit Move-to-Rail popover. */
  rails?: RailState[]
  /** Handler invoked when the user picks a rail from the Move-to-Rail popover. */
  onMoveToRail?: (ticketId: number, railId: string) => void
  /** Right-click context menu — status change. */
  onTicketStatusChange?: (ticketId: number, status: TicketStatus) => void
  /** Right-click context menu — priority change. */
  onTicketPriorityChange?: (ticketId: number, priority: TicketPriority) => void
}

interface DraftOverrides {
  title?: string
  description?: string
  priority?: 'low' | 'medium' | 'high' | 'critical'
  labels?: string[]
  acceptanceCriteria?: string[]
}

interface ExploreState {
  /** Project this session belongs to. Captured at open/restore time so that
   *  parking it (e.g. when the user switches to another minimized session in a
   *  different project) always tags the chip with the CORRECT project, never
   *  the live `activeProjectId` which may already have switched. */
  projectId: string
  idea: string
  pendingSpecId: string
  initialAttachmentIds: string[]
  /** Model picked at Add Spec — only carried for fresh sessions. Restored
   *  sessions read the model off the persisted conversation row. */
  initialModel?: string
  /** AI engine picked at Add Spec — only carried for fresh sessions. */
  initialProvider?: string
  resumeConversationId?: string
  /** Last-known draft title, surfaced as the shell's initial header label
   *  on restore so the title doesn't blank out across minimize/maximize
   *  cycles before WS catches up with a fresh `spec_draft.update`. */
  seedDraftTitle?: string
  /** Composer text the user was mid-typing before minimize. */
  seedComposerText?: string
  /** Manual draft field overrides (title/description/labels/etc) the user
   *  applied before minimize — replayed on remount so edits survive. */
  seedDraftOverrides?: DraftOverrides
  /** Edit-existing-ticket payload. When present the shell runs in edit mode
   *  (PATCH commit, ticket as Review baseline, edit-mode header). */
  editTicket?: {
    id: number
    title: string
    description: string
    labels: string[]
    priority: 'low' | 'medium' | 'high' | 'critical' | null
    acceptanceCriteria: string[]
    /** Current ticket status. `'draft'` makes the shell PUBLISH on commit
     *  (flip draft → real spec) instead of PATCHing in place. Optional for
     *  backward-compat; absent ⇒ treated as a real-spec edit. */
    status?: 'draft' | 'todo' | 'in_progress' | 'on_review' | 'done' | 'cancelled'
  }
  contextScope?: import('../types/context-scope').ContextScope
}

/** Returns true when at least one draft field carries a meaningful value. */
function hasOverrides(o: DraftOverrides): boolean {
  if (o.title?.trim()) return true
  if (o.description?.trim()) return true
  if (o.priority && o.priority !== 'medium') return true
  if (o.labels && o.labels.length > 0) return true
  if (o.acceptanceCriteria && o.acceptanceCriteria.some((c) => c.trim())) return true
  return false
}

/** Compose a stable, human-readable label for the chip from the most
 *  meaningful source available. The `Untitled spec` fallback is reserved
 *  for true empty cases (no idea, no draft yet). */
function deriveExploreLabel(
  draftTitle: string | undefined | null,
  seedDraftTitle: string | undefined | null,
  ideaText: string,
): string {
  const live = draftTitle?.trim()
  if (live) return live
  const seed = seedDraftTitle?.trim()
  if (seed) return seed
  const idea = ideaText.trim()
  if (idea) return idea.length > 60 ? idea.slice(0, 57) + '…' : idea
  return i18n.t('specs:board.untitledSpec')
}

export function SpecsBoard({
  tickets,
  allTickets,
  doneTickets = [],
  isLoading,
  onTicketClick,
  onTicketCreated,
  onTicketDelete,
  contractRefiningIds = new Set(),
  sortMode = 'default',
  sortDir = 'desc',
  onSortChange = () => {},
  viewTier = 'postit',
  onViewTierChange,
  rails = [],
  onMoveToRail,
  onTicketStatusChange,
  onTicketPriorityChange,
}: SpecsBoardProps) {
  const { t } = useTranslation('specs')
  const [jiggleMode, setJiggleMode] = useState(false)
  // Exit jiggle mode when clicking outside any card or pressing Escape.
  useEffect(() => {
    if (!jiggleMode) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setJiggleMode(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [jiggleMode])
  const handleBackgroundClick = useCallback(() => {
    if (jiggleMode) setJiggleMode(false)
  }, [jiggleMode])
  const enterJiggle = useCallback(() => setJiggleMode(true), [])
  const handleCardDelete = useCallback(
    (t: LocalTicket) => {
      if (onTicketDelete) onTicketDelete(t.id)
    },
    [onTicketDelete],
  )
  const [proposeOpen, setProposeOpen] = useState(false)
  const [explore, setExplore] = useState<ExploreState | null>(null)
  const { activeProjectId } = useDesktop()
  const [searchParams, setSearchParams] = useSearchParams()
  // Filters persist per-project (and across app restarts) — restored from
  // localStorage on mount and on every project switch (see the effect below).
  const [activeLabels, setActiveLabels] = useState<Set<string>>(() => loadSpecFilters(activeProjectId).labels)
  const [activeEpic, setActiveEpic] = useState<string | null>(() => loadSpecFilters(activeProjectId).epic)
  const [activeSprint, setActiveSprint] = useState<string | null>(() => loadSpecFilters(activeProjectId).sprint)
  // Status dimensions are URL-synced (`?status=…&jiraStatus=…`) so a refresh /
  // shared link restores the exact view. On mount the URL wins over the
  // per-project persisted selection; on project switch the persisted one wins
  // (any lingering params belonged to the previous project).
  const [statusFilter, setStatusFilter] = useState<SpecStatusFilterValue>(() => {
    const fromUrl = searchParams.get('status')
    return isSpecStatusFilterValue(fromUrl) ? fromUrl : loadSpecStatusFilter(activeProjectId)
  })
  const [activeJiraStatus, setActiveJiraStatus] = useState<string | null>(
    () => searchParams.get('jiraStatus') ?? loadSpecFilters(activeProjectId).jiraStatus,
  )
  const handleStatusFilterChange = useCallback((v: SpecStatusFilterValue) => {
    setStatusFilter(v)
    saveSpecStatusFilter(activeProjectId, v)
  }, [activeProjectId])

  // Mirror the two status dimensions into the URL. Default values are DELETED
  // (a pristine `/` stays pristine); foreign params (e.g. `?compare=…`) are
  // preserved via the functional form.
  useEffect(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (statusFilter === 'active') next.delete('status')
      else next.set('status', statusFilter)
      if (activeJiraStatus === null) next.delete('jiraStatus')
      else next.set('jiraStatus', activeJiraStatus)
      return next.toString() === prev.toString() ? prev : next
    }, { replace: true })
  }, [statusFilter, activeJiraStatus, setSearchParams])
  const { minimize } = useMinimizedChats()
  // SMASH: build lookup maps so each SpecCard renders the épica badge / child
  // pill without re-scanning the full ticket list per render.
  const epicChildCounts = useMemo(() => {
    const m = new Map<number, number>()
    for (const t of allTickets ?? []) {
      if (t.parent_epic_id != null) m.set(t.parent_epic_id, (m.get(t.parent_epic_id) ?? 0) + 1)
    }
    return m
  }, [allTickets])
  const epicTitles = useMemo(() => {
    const m = new Map<number, string>()
    for (const t of allTickets ?? []) if (t.is_epic) m.set(t.id, t.title)
    return m
  }, [allTickets])
  const ticketsById = useMemo(() => {
    const m = new Map<number, LocalTicket>()
    for (const t of allTickets ?? []) m.set(t.id, t)
    return m
  }, [allTickets])
  const handleOpenParentEpic = useCallback((parentEpicId: number) => {
    const parent = ticketsById.get(parentEpicId)
    if (parent) onTicketClick(parent)
  }, [ticketsById, onTicketClick])

  // On project switch, restore THIS project's saved filters (not a reset) so
  // the bug where switching projects wiped the filter bar is gone — and the
  // same restore runs on mount, so a close/reopen lands on the same filters.
  // The status dimensions are skipped on FIRST run only: their useState
  // initializers already applied URL-else-persisted, and a deep link
  // (`?status=done`) must not be clobbered by the persisted value.
  const didRestoreStatusRef = useRef(false)
  useEffect(() => {
    const f = loadSpecFilters(activeProjectId)
    setActiveLabels(f.labels)
    setActiveEpic(f.epic)
    setActiveSprint(f.sprint)
    if (didRestoreStatusRef.current) {
      setStatusFilter(loadSpecStatusFilter(activeProjectId))
      setActiveJiraStatus(f.jiraStatus)
    }
    didRestoreStatusRef.current = true
  }, [activeProjectId])

  const handleLabelsChange = useCallback((next: Set<string>) => {
    setActiveLabels(next)
    saveSpecFilters(activeProjectId, { labels: next, epic: activeEpic, sprint: activeSprint, jiraStatus: activeJiraStatus })
  }, [activeProjectId, activeEpic, activeSprint, activeJiraStatus])

  const handleEpicChange = useCallback((next: string | null) => {
    setActiveEpic(next)
    saveSpecFilters(activeProjectId, { labels: activeLabels, epic: next, sprint: activeSprint, jiraStatus: activeJiraStatus })
  }, [activeProjectId, activeLabels, activeSprint, activeJiraStatus])

  const handleSprintChange = useCallback((next: string | null) => {
    setActiveSprint(next)
    saveSpecFilters(activeProjectId, { labels: activeLabels, epic: activeEpic, sprint: next, jiraStatus: activeJiraStatus })
  }, [activeProjectId, activeLabels, activeEpic, activeJiraStatus])

  const handleJiraStatusChange = useCallback((next: string | null) => {
    setActiveJiraStatus(next)
    saveSpecFilters(activeProjectId, { labels: activeLabels, epic: activeEpic, sprint: activeSprint, jiraStatus: next })
  }, [activeProjectId, activeLabels, activeEpic, activeSprint])

  const matchesFilters = useCallback(
    (t: LocalTicket): boolean => {
      if (activeEpic !== null && t.jira_epic_key !== activeEpic) return false
      if (activeSprint !== null && t.jira_sprint_id !== activeSprint) return false
      if (activeLabels.size > 0 && !(t.labels ?? []).some((l) => activeLabels.has(l))) return false
      return true
    },
    [activeLabels, activeEpic, activeSprint],
  )

  const noFilters = activeLabels.size === 0 && activeEpic === null && activeSprint === null
  const filteredTickets = useMemo(() => {
    if (noFilters) return tickets
    return tickets.filter(matchesFilters)
  }, [tickets, noFilters, matchesFilters])

  const filteredDoneTickets = useMemo(() => {
    if (noFilters) return doneTickets
    return doneTickets.filter(matchesFilters)
  }, [doneTickets, noFilters, matchesFilters])

  // Epics / sprints are only present on Jira-backed specs → these filters are
  // implicitly Jira-only (hidden when no spec carries that data).
  const hasEpics = useMemo(
    () => tickets.some((t) => t.jira_epic_key) || doneTickets.some((t) => t.jira_epic_key),
    [tickets, doneTickets],
  )
  const hasSprints = useMemo(
    () => tickets.some((t) => t.jira_sprint_id) || doneTickets.some((t) => t.jira_sprint_id),
    [tickets, doneTickets],
  )
  // The "Jira Ticket #" sort is offered only when at least one spec carries a
  // Jira key (i.e. the project is Jira-connected and has synced issues).
  const hasJiraKeys = useMemo(
    () => tickets.some((t) => t.jira_key) || doneTickets.some((t) => t.jira_key),
    [tickets, doneTickets],
  )
  // The Jira-status dimension appears only when the inbound sync has
  // materialized at least one RAW workflow status name (implicitly Jira-only,
  // same as the epic/sprint filters).
  const hasJiraStatuses = useMemo(
    () => tickets.some((t) => t.jira_status) || doneTickets.some((t) => t.jira_status),
    [tickets, doneTickets],
  )

  // Live per-status counts for the selector — computed AFTER the label/epic/
  // sprint filters (they narrow what the board can show at all) but BEFORE the
  // status dimensions themselves (a chip must keep announcing what selecting
  // it would reveal). Recomputes on every ticket prop change, so WS
  // `ticket_updated` events keep the counts live.
  const statusCounts = useMemo(() => {
    const c: Record<TicketStatus, number> = {
      draft: 0, todo: 0, in_progress: 0, on_review: 0, done: 0, cancelled: 0,
    }
    for (const t of filteredTickets) c[t.status] += 1
    for (const t of filteredDoneTickets) c[t.status] += 1
    return c
  }, [filteredTickets, filteredDoneTickets])

  const matchesJiraStatus = useCallback(
    (t: LocalTicket): boolean => activeJiraStatus === null || t.jira_status === activeJiraStatus,
    [activeJiraStatus],
  )

  // The active (non-done) bucket after BOTH status dimensions. Order comes
  // from the parent (drag order / sort) — filtering preserves it.
  const visibleActiveTickets = useMemo(
    () => filteredTickets.filter((t) => statusMatchesFilter(t.status, statusFilter) && matchesJiraStatus(t)),
    [filteredTickets, statusFilter, matchesJiraStatus],
  )

  // Done specs follow the SAME general sort as the active board (the Done
  // bucket has no controls of its own — see the toolbar above).
  const visibleDoneTickets = useMemo(() => {
    const base = filteredDoneTickets.filter(matchesJiraStatus)
    return sortMode === 'default' ? base : applySpecSort(base, sortMode, sortDir)
  }, [filteredDoneTickets, matchesJiraStatus, sortMode, sortDir])

  // Snapshot of the live shell so we can auto-minimize the current session
  // before restoring another (mutual-exclusion: only one shell visible at
  // a time per project). ExploreSpecShell calls onStateChange to keep this
  // up to date with its conversationId, draft title, in-progress composer
  // text, and manual draft overrides. We mirror it as state too (not just
  // a ref) so the persistence effect can re-fire when these change.
  interface LiveShellSnapshot {
    conversationId: string | null
    draftTitle: string
    composerText: string
    draftOverrides: DraftOverrides
  }
  const [liveShell, setLiveShell] = useState<LiveShellSnapshot>({
    conversationId: null,
    draftTitle: '',
    composerText: '',
    draftOverrides: {},
  })
  const liveShellRef = useRef(liveShell)
  liveShellRef.current = liveShell
  const exploreRef = useRef(explore)
  exploreRef.current = explore

  const parkCurrentExplore = useCallback(() => {
    const cur = exploreRef.current
    if (!cur || !cur.projectId) return
    minimize({
      kind: 'explore-spec',
      projectId: cur.projectId,
      label: deriveExploreLabel(
        liveShellRef.current.draftTitle,
        cur.seedDraftTitle,
        cur.idea,
      ),
      restoreRoute: '/',
      params: {
        initialIdea: cur.idea,
        pendingSpecId: cur.pendingSpecId,
        initialAttachmentIds: cur.initialAttachmentIds,
        resumeConversationId:
          liveShellRef.current.conversationId ?? cur.resumeConversationId,
        composerText: liveShellRef.current.composerText || undefined,
        draftOverrides: hasOverrides(liveShellRef.current.draftOverrides)
          ? liveShellRef.current.draftOverrides
          : undefined,
        editTicket: cur.editTicket,
      },
    })
    // The chip's persistence takes over from here.
    clearActiveExploreSpec()
  }, [minimize])

  // Restore live session on mount if one was open at refresh time. Scoped
  // to the active project so refreshing while on a different project
  // doesn't bring back the wrong session.
  useEffect(() => {
    if (!activeProjectId) return
    const persisted = loadActiveExploreSpec()
    if (!persisted || persisted.projectId !== activeProjectId) return
    setLiveShell({
      conversationId: persisted.resumeConversationId ?? null,
      draftTitle: persisted.seedDraftTitle ?? '',
      composerText: persisted.composerText ?? '',
      draftOverrides: persisted.draftOverrides ?? {},
    })
    setExplore({
      projectId: persisted.projectId,
      idea: persisted.idea,
      pendingSpecId: persisted.pendingSpecId,
      initialAttachmentIds: persisted.initialAttachmentIds,
      resumeConversationId: persisted.resumeConversationId,
      seedDraftTitle: persisted.seedDraftTitle,
      seedComposerText: persisted.composerText,
      seedDraftOverrides: persisted.draftOverrides,
    })
    // Eslint: only run on activeProjectId change. We deliberately don't
    // depend on `explore` — this is a one-shot restore on (re)mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])

  // Mirror the live session to localStorage so a refresh-while-open lands
  // the user back in the same conversation, with composer + draft edits.
  useEffect(() => {
    if (!explore || !activeProjectId) return
    saveActiveExploreSpec({
      projectId: activeProjectId,
      idea: explore.idea,
      pendingSpecId: explore.pendingSpecId,
      initialAttachmentIds: explore.initialAttachmentIds,
      resumeConversationId:
        liveShell.conversationId ?? explore.resumeConversationId,
      seedDraftTitle:
        liveShell.draftTitle || explore.seedDraftTitle,
      composerText: liveShell.composerText || undefined,
      draftOverrides: hasOverrides(liveShell.draftOverrides)
        ? liveShell.draftOverrides
        : undefined,
    })
  }, [explore, activeProjectId, liveShell])

  const handleExploreLaunch = useCallback((payload: ExploreLaunchPayload) => {
    // Mutual exclusion — opening a new explore session parks any current one.
    parkCurrentExplore()
    setLiveShell({ conversationId: null, draftTitle: '', composerText: '', draftOverrides: {} })
    if (!activeProjectId) return
    setExplore({
      projectId: activeProjectId,
      idea: payload.idea,
      pendingSpecId: payload.pendingSpecId,
      initialAttachmentIds: payload.initialAttachmentIds,
      initialModel: payload.model,
      initialProvider: payload.provider,
      contextScope: payload.contextScope,
    })
  }, [parkCurrentExplore, activeProjectId])

  // Restore from a chip click → re-open the shell with the resumed
  // conversation. Carry forward the chip's label as `seedDraftTitle` so the
  // shell renders a meaningful header immediately, even before the
  // `spec_draft.update` WS event refreshes the draft. If a different
  // session is currently visible, park it as a chip first.
  usePendingRestore('explore-spec', activeProjectId, (chat) => {
    if (chat.kind !== 'explore-spec') return
    parkCurrentExplore()
    setLiveShell({
      conversationId: chat.params.resumeConversationId ?? null,
      draftTitle: chat.label,
      composerText: chat.params.composerText ?? '',
      draftOverrides: chat.params.draftOverrides ?? {},
    })
    setExplore({
      projectId: chat.projectId,
      idea: chat.params.initialIdea,
      pendingSpecId: chat.params.pendingSpecId,
      initialAttachmentIds: chat.params.initialAttachmentIds,
      resumeConversationId: chat.params.resumeConversationId,
      seedDraftTitle: chat.label,
      seedComposerText: chat.params.composerText,
      seedDraftOverrides: chat.params.draftOverrides,
      editTicket: chat.params.editTicket,
    })
  })

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
      e.preventDefault()
      setProposeOpen(true)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
  const { isOver, setNodeRef } = useDroppable({ id: 'specs' })
  const { isOver: isDoneOver, setNodeRef: setDoneNodeRef } = useDroppable({ id: 'done-specs' })

  // Status filter ⇒ which buckets render. In `all`, active specs first, done
  // pinned at the bottom (always). `done` shows only the Done bucket; every
  // other value filters within the active bucket.
  const showTodoBucket = statusFilter !== 'done'
  const showDoneBucket = statusFilter === 'all' || statusFilter === 'done'
  // Whether either status dimension is narrowing the view (drives the empty
  // states + header count pill).
  const statusNarrowed = statusFilter !== 'active' || activeJiraStatus !== null

  return (
    <div className="flex flex-col h-full" onClick={handleBackgroundClick}>
      {/* Header — a single row (aligns with the rails header): title + the
          premium status selector, a separator, then filters + sort + view + add. */}
      <div className="flex items-center px-4 h-12 border-b border-border/40 shrink-0 gap-2">
        <div className="flex items-center gap-2 shrink-0">
          <FileText className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-accent-primary">{t('board.title')}</h2>
          {tickets.length + doneTickets.length > 0 && (
            <span className="text-[10px] text-muted-foreground bg-muted/30 rounded-full px-1.5 py-0.5">
              {!noFilters || activeJiraStatus !== null
                ? `${filteredTickets.filter(matchesJiraStatus).length + filteredDoneTickets.filter(matchesJiraStatus).length}/${tickets.length + doneTickets.length}`
                : tickets.length + doneTickets.length}
            </span>
          )}
        </div>

        {/* Premium status selector — every state with a live count. Shrinks
            (and scrolls) before anything else in the row does. */}
        <SpecStatusFilter
          value={statusFilter}
          onChange={handleStatusFilterChange}
          counts={statusCounts}
        />

        {/* Jira dimension — the board's REAL workflow statuses (raw names),
            present only once the inbound sync materialized at least one. */}
        {hasJiraStatuses && (
          <SpecJiraStatusFilterDropdown
            tickets={[...filteredTickets, ...filteredDoneTickets]}
            active={activeJiraStatus}
            onChange={handleJiraStatusChange}
          />
        )}

        {/* Separator between the status selector and the filters */}
        <div className="h-5 w-px bg-border/60 shrink-0" aria-hidden />

        {/* Filters are direct children (NO overflow wrapper — an overflow
            ancestor clips their absolute dropdown panels). */}
        <SpecLabelFilterDropdown
          tickets={[...tickets, ...doneTickets]}
          active={activeLabels}
          onChange={handleLabelsChange}
        />
        {hasEpics && (
          <SpecEpicFilterDropdown
            tickets={[...tickets, ...doneTickets]}
            active={activeEpic}
            onChange={handleEpicChange}
          />
        )}
        {hasSprints && (
          <SpecSprintFilterDropdown
            tickets={[...tickets, ...doneTickets]}
            active={activeSprint}
            onChange={handleSprintChange}
          />
        )}

        {/* Separator between the Jira/label filters and the sort/view controls.
            `ml-auto` pushes the whole action cluster to the right edge. */}
        <div className="h-5 w-px bg-border/60 shrink-0 ml-auto" aria-hidden />

        <SpecSortControl
          mode={sortMode}
          dir={sortDir}
          onChange={onSortChange}
          showJiraSort={hasJiraKeys}
          className="shrink-0"
        />
        {onViewTierChange && (
          <div className="shrink-0">
            <SpecsViewTierToggle tier={viewTier} onChange={onViewTierChange} />
          </div>
        )}

        {/* Separator before the primary Add action */}
        <div className="h-5 w-px bg-border/60 shrink-0" aria-hidden />

        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1 shrink-0 border-accent-primary/50 text-accent-primary hover:bg-accent-primary/10 hover:text-accent-primary"
          onClick={() => setProposeOpen(true)}
          data-tour="add-spec-btn"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('common:actions.add')}
        </Button>
      </div>

      {/* Content area — single scrollable list. Status filter decides which
          buckets render; in `all` mode todo specs come first and the done
          bucket is always pinned to the bottom of the scroller. */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Active specs bucket (todo) — droppable zone */}
        {showTodoBucket && (
          <div
            ref={setNodeRef}
            data-tour="specs-list"
            className={`px-4 pt-3 pb-2 space-y-1.5 transition-colors duration-150 ${isOver ? 'bg-primary/[0.04]' : ''}`}
          >
            {isLoading ? (
              <div className="space-y-1.5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-10 rounded-lg border border-border/40 bg-card/50 animate-pulse" />
                ))}
              </div>
            ) : visibleActiveTickets.length === 0 ? (
              <div
                className={`flex flex-col items-center justify-center py-12 text-center transition-colors ${
                  isOver ? 'text-primary/50' : 'text-muted-foreground'
                }`}
              >
                <FileText className="w-8 h-8 mb-3 opacity-20" />
                <p className="text-sm">
                  {isOver
                    ? t('board.dropHere')
                    : tickets.length === 0
                      ? t('board.emptyNoSpecs')
                      : filteredTickets.length === 0 && activeLabels.size > 0
                        ? t('board.emptyNoLabelMatch')
                        : statusNarrowed
                          ? t('board.emptyNoStatusMatch')
                          : t('board.emptyNoActiveSpecs')}
                </p>
                {!isOver && tickets.length === 0 && (
                  <p className="text-xs mt-1 opacity-60">{t('board.emptyHint')}</p>
                )}
              </div>
            ) : viewTier === 'postit' && onMoveToRail ? (
              <SortableContext items={visibleActiveTickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <div
                  data-testid="specs-board-postit-grid"
                  className="grid gap-3"
                  style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
                >
                  {visibleActiveTickets.map((ticket) => (
                    <MaybeContextMenu
                      key={ticket.id}
                      ticket={ticket}
                      onTicketDelete={onTicketDelete}
                      onTicketStatusChange={onTicketStatusChange}
                      onTicketPriorityChange={onTicketPriorityChange}
                    >
                      <TicketPostitCard
                        ticket={ticket}
                        rails={rails}
                        onClick={onTicketClick}
                        onMoveToRail={onMoveToRail}
                        contractRefining={contractRefiningIds.has(ticket.id)}
                        epicChildrenCount={ticket.is_epic ? epicChildCounts.get(ticket.id) ?? 0 : undefined}
                        parentEpicTitle={ticket.parent_epic_id != null ? (epicTitles.get(ticket.parent_epic_id) ?? null) : null}
                        onOpenParentEpic={handleOpenParentEpic}
                        jiggleMode={jiggleMode}
                        onLongPress={onTicketDelete ? enterJiggle : undefined}
                        onDelete={onTicketDelete ? handleCardDelete : undefined}
                      />
                    </MaybeContextMenu>
                  ))}
                </div>
              </SortableContext>
            ) : (
              <SortableContext items={visibleActiveTickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <div
                  data-testid="specs-board-list"
                  data-tier="row"
                  className="space-y-1.5"
                >
                  {visibleActiveTickets.map((ticket) => (
                    <MaybeContextMenu
                      key={ticket.id}
                      ticket={ticket}
                      onTicketDelete={onTicketDelete}
                      onTicketStatusChange={onTicketStatusChange}
                      onTicketPriorityChange={onTicketPriorityChange}
                    >
                      <SpecCard
                        ticket={ticket}
                        onClick={onTicketClick}
                        contractRefining={contractRefiningIds.has(ticket.id)}
                        epicChildrenCount={ticket.is_epic ? epicChildCounts.get(ticket.id) ?? 0 : undefined}
                        parentEpicTitle={ticket.parent_epic_id != null ? (epicTitles.get(ticket.parent_epic_id) ?? null) : null}
                        onOpenParentEpic={handleOpenParentEpic}
                        jiggleMode={jiggleMode}
                        onLongPress={onTicketDelete ? enterJiggle : undefined}
                        onDelete={onTicketDelete ? handleCardDelete : undefined}
                      />
                    </MaybeContextMenu>
                  ))}
                </div>
              </SortableContext>
            )}
          </div>
        )}

        {/* Done bucket — droppable, always pinned to the bottom of the scroller. */}
        {showDoneBucket && (
          <div
            ref={setDoneNodeRef}
            data-testid="specs-board-done-bucket"
            className={`px-4 pt-2 pb-3 space-y-1.5 transition-colors duration-150 ${
              isDoneOver ? 'bg-emerald-500/[0.04] aurora-light:bg-accent-success/10' : ''
            } ${showTodoBucket ? 'border-t border-border/30 mt-1' : ''}`}
          >
            {/* No per-Done header: the Done CHIP labels this bucket and the board
                toolbar's sort + list/postit toggle now drive it too. */}
            {visibleDoneTickets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center text-muted-foreground">
                <CheckCircle2 className="w-6 h-6 mb-2 opacity-15" />
                <p className="text-xs opacity-60">
                  {isDoneOver
                    ? t('board.dropToMarkDone')
                    : activeLabels.size > 0 && doneTickets.length > 0
                      ? t('board.emptyNoDoneLabelMatch')
                      : activeJiraStatus !== null && filteredDoneTickets.length > 0
                        ? t('board.emptyNoStatusMatch')
                        : t('board.emptyNoCompleted')}
                </p>
              </div>
            ) : viewTier === 'postit' && onMoveToRail ? (
              <SortableContext items={visibleDoneTickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <div
                  data-testid="specs-board-done-postit-grid"
                  className="grid gap-3"
                  style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
                >
                  {visibleDoneTickets.map((ticket) => (
                    <MaybeContextMenu
                      key={ticket.id}
                      ticket={ticket}
                      onTicketDelete={onTicketDelete}
                      onTicketStatusChange={onTicketStatusChange}
                      onTicketPriorityChange={onTicketPriorityChange}
                    >
                      <TicketPostitCard
                        ticket={ticket}
                        rails={rails}
                        onClick={onTicketClick}
                        onMoveToRail={onMoveToRail}
                        contractRefining={contractRefiningIds.has(ticket.id)}
                        epicChildrenCount={ticket.is_epic ? epicChildCounts.get(ticket.id) ?? 0 : undefined}
                        parentEpicTitle={ticket.parent_epic_id != null ? (epicTitles.get(ticket.parent_epic_id) ?? null) : null}
                        onOpenParentEpic={handleOpenParentEpic}
                        jiggleMode={jiggleMode}
                        onLongPress={onTicketDelete ? enterJiggle : undefined}
                        onDelete={onTicketDelete ? handleCardDelete : undefined}
                      />
                    </MaybeContextMenu>
                  ))}
                </div>
              </SortableContext>
            ) : (
              <SortableContext items={visibleDoneTickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                {visibleDoneTickets.map((ticket) => (
                  <MaybeContextMenu
                    key={ticket.id}
                    ticket={ticket}
                    onTicketDelete={onTicketDelete}
                    onTicketStatusChange={onTicketStatusChange}
                    onTicketPriorityChange={onTicketPriorityChange}
                  >
                    <SpecCard
                      ticket={ticket}
                      onClick={onTicketClick}
                      contractRefining={contractRefiningIds.has(ticket.id)}
                      epicChildrenCount={ticket.is_epic ? epicChildCounts.get(ticket.id) ?? 0 : undefined}
                      parentEpicTitle={ticket.parent_epic_id != null ? (epicTitles.get(ticket.parent_epic_id) ?? null) : null}
                      onOpenParentEpic={handleOpenParentEpic}
                      jiggleMode={jiggleMode}
                      onLongPress={onTicketDelete ? enterJiggle : undefined}
                      onDelete={onTicketDelete ? handleCardDelete : undefined}
                    />
                  </MaybeContextMenu>
                ))}
              </SortableContext>
            )}
          </div>
        )}
      </div>

      <ProposeSpecModal
        open={proposeOpen}
        onClose={() => setProposeOpen(false)}
        tickets={allTickets ?? tickets}
        onExploreLaunch={handleExploreLaunch}
      />

      {explore && activeProjectId && (
        <ShellErrorBoundary onClose={() => setExplore(null)}>
        <ExploreSpecShell
          // Bind component identity to the session so restoring a different
          // chip remounts the shell from scratch — without this, internal
          // state (conversationId, useSpecDraftStream subscription, composer
          // refs) leaks across sessions.
          key={`${explore.pendingSpecId}:${explore.resumeConversationId ?? 'fresh'}`}
          initialIdea={explore.idea}
          pendingSpecId={explore.pendingSpecId}
          initialAttachmentIds={explore.initialAttachmentIds}
          initialModel={explore.initialModel}
          initialProvider={explore.initialProvider}
          resumeConversationId={explore.resumeConversationId}
          seedDraftTitle={explore.seedDraftTitle}
          seedComposerText={explore.seedComposerText}
          seedDraftOverrides={explore.seedDraftOverrides}
          editTicket={explore.editTicket}
          contextScope={explore.contextScope}
          onStateChange={(s) => setLiveShell(s)}
          onClose={() => {
            // Discarding the overlay → wipe any attachments uploaded during
            // the session (matches Quick path's close-without-submit behaviour).
            deleteAllAttachments(explore.pendingSpecId).catch(() => {})
            setExplore(null)
            clearActiveExploreSpec()
          }}
          onMinimize={(conversationId, draftTitle) => {
            const live = liveShellRef.current
            minimize({
              kind: 'explore-spec',
              projectId: explore.projectId,
              label: deriveExploreLabel(draftTitle, explore.seedDraftTitle, explore.idea),
              restoreRoute: '/',
              params: {
                initialIdea: explore.idea,
                pendingSpecId: explore.pendingSpecId,
                initialAttachmentIds: explore.initialAttachmentIds,
                resumeConversationId: conversationId ?? undefined,
                composerText: live.composerText || undefined,
                draftOverrides: hasOverrides(live.draftOverrides) ? live.draftOverrides : undefined,
              },
            })
            setExplore(null)
            // Chip persistence takes over from here.
            clearActiveExploreSpec()
          }}
          onTicketCreated={(ticket) => {
            setExplore(null)
            clearActiveExploreSpec()
            onTicketCreated?.(ticket)
          }}
        />
        </ShellErrorBoundary>
      )}
    </div>
  )
}

interface MaybeContextMenuProps {
  ticket: LocalTicket
  onTicketDelete?: (ticketId: number) => void
  onTicketStatusChange?: (ticketId: number, status: TicketStatus) => void
  onTicketPriorityChange?: (ticketId: number, priority: TicketPriority) => void
  children: React.ReactNode
}

function MaybeContextMenu({
  ticket,
  onTicketDelete,
  onTicketStatusChange,
  onTicketPriorityChange,
  children,
}: MaybeContextMenuProps) {
  if (!onTicketDelete || !onTicketStatusChange || !onTicketPriorityChange) {
    return <>{children}</>
  }
  return (
    <TicketContextMenu
      ticket={ticket}
      onDelete={onTicketDelete}
      onStatusChange={onTicketStatusChange}
      onPriorityChange={onTicketPriorityChange}
    >
      {children}
    </TicketContextMenu>
  )
}
