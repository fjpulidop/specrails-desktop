/**
 * The project Board: the specs column (left) and the rails board (right) in
 * one drag-and-drop context. This page composes the board hooks — local rails
 * projection and its server reconcile, live rail events, drag and drop, rail
 * configuration and launch — and renders the panels, overlay and dialogs.
 */
import { useMemo, useRef } from 'react'
import { DndContext } from '@dnd-kit/core'
import { useTranslation } from 'react-i18next'
import { notifyError } from '../../../lib/notify-error'
import { useTickets } from '../../specs/hooks/useTickets'
import { SpecsBoard } from '../../specs/components/SpecsBoard'
import { JiraDiscardProvider } from '../../integrations/context/JiraDiscardContext'
import { RailsBoard } from '../../rails/components/RailsBoard'
import { useRailMetrics } from '../../rails/context/RailMetricsContext'
import { useRailPrDecisions } from '../../delivery/context/RailPrDecisionContext'
import { DashboardSplitter } from '../components/DashboardSplitter'
import { BoardDragOverlay } from '../components/BoardDragOverlay'
import { BoardSpecDetailModal } from '../components/BoardSpecDetailModal'
import { RailLaunchDialogs } from '../components/RailLaunchDialogs'
import { useDashboardSplit } from '../hooks/useDashboardSplit'
import { useSpecBulkActions } from '../hooks/useSpecBulkActions'
import { useSpecDetailPlace } from '../hooks/useSpecDetailPlace'
import { useBoardViewPrefs } from '../hooks/useBoardViewPrefs'
import { useBoardRails, useStripFinishedRailTickets } from '../hooks/useBoardRails'
import { useRailServerSync } from '../hooks/useRailServerSync'
import { useRailCrud } from '../hooks/useRailCrud'
import { useRailWsEvents } from '../hooks/useRailWsEvents'
import { useBoardSpecColumns } from '../hooks/useBoardSpecColumns'
import { useRailTicketMoves } from '../hooks/useRailTicketMoves'
import { useBoardDnd } from '../hooks/useBoardDnd'
import { useRailConfigHandlers } from '../hooks/useRailConfigHandlers'
import { useRailLaunch } from '../hooks/useRailLaunch'
import { useBoardPalette } from '../hooks/useBoardPalette'
import { FEATURE_LOOPS_SECTION } from '../../../lib/feature-flags'
import { effectiveLoopId } from '../../rails/lib/rail-loops'
import { isRolesEngine } from '../../providers/lib/provider-capabilities'
import { railIndexFromId } from '../../rails/lib/rail-id'
import { useDesktop, projectProviders } from '../../../hooks/useDesktop'
import { useJiraConnection } from '../../integrations/hooks/useJiraConnection'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { useActiveTheme } from '../../settings/context/ThemeContext'
import { Starfield } from '../../settings/components/theme-effects/Starfield'
import { railProviderOf } from '../lib/board-rails'
import { pendingReviewFromDecisions, railLaunchAddsReviewWip, reviewWipCapacity, useReviewWipLimit } from '../../../lib/review-wip'

export default function DashboardPage() {
  const { t } = useTranslation('dashboard')
  const jira = useJiraConnection()
  const { activeProjectId, projects } = useDesktop()
  const isGalaxy = useActiveTheme().id === 'galaxy'
  const railProviders = (() => {
    const p = projects.find((pr) => pr.id === activeProjectId)
    return p ? projectProviders(p) : ['claude']
  })()
  const { tickets, isLoading, error: ticketsError, updateTicket, updateTicketStatus, updateTicketPriority, deleteTicket, refetch, contractRefiningIds, bulkDelete, bulkUpdateStatus, bulkUpdatePriority, bulkUpdateLabels } = useTickets()
  const { connectionStatus } = useSharedWebSocket()
  const { detailTicket, setDetailTicket } = useSpecDetailPlace(tickets, activeProjectId, refetch)

  // ── Board state ─────────────────────────────────────────────────────────────
  const { rails, setRails, railsRef, updateRails, syncRails, isTicketWritePending, specOrderIds, updateSpecOrder, railWorktrees, setRailWorktrees } = useBoardRails(activeProjectId)
  // Live per-rail execution metrics (elapsed/steps/lines) — app-level provider so
  // they survive Dashboard ⇄ Jobs navigation.
  const railMetrics = useRailMetrics()
  // Ask-first PR decisions per rail (safe-pr-review-flow) — app-level provider,
  // WS-hydrated snapshots + the single POST /rails/pr-decision caller.
  const { decisions: railPrDecisions, hydrated: railPrDecisionsHydrated, act: actRailPrDecision, checkout: checkoutRailPrBranch } = useRailPrDecisions()
  // Review WIP limit (review-wip-limit): live count from the per-rail delivery
  // snapshots; the server re-checks every launch and answers 409 at the limit.
  const reviewWipLimit = useReviewWipLimit(activeProjectId)
  const pendingReview = useMemo(() => pendingReviewFromDecisions(railPrDecisions), [railPrDecisions])
  const { sortMode, sortDir, viewTier, handleSortChange, handleViewTierChange, resetSortAfterManualReorder } = useBoardViewPrefs(activeProjectId)

  useRailServerSync(activeProjectId, connectionStatus, setRails, isTicketWritePending)
  useStripFinishedRailTickets({ tickets, activeProjectId, rails, setRails, railPrDecisions, railPrDecisionsHydrated })
  const { handleAddRail, handleDeleteRail, handleRenameRail } = useRailCrud(rails, updateRails, updateSpecOrder)
  useRailWsEvents({ activeProjectId, updateRails: syncRails, setRailWorktrees, railPrDecisions, isTicketWritePending })

  // ── Derived columns and ticket moves ────────────────────────────────────────
  const { ticketMap, allTicketLabels, specTickets, doneSpecTickets, continuableReviewTicketIds } = useBoardSpecColumns({
    tickets, isLoading, rails, specOrderIds, sortMode, sortDir, handleSortChange, railPrDecisions, railPrDecisionsHydrated,
  })
  const { handleMoveTicketToRail, handleRemoveTicketFromRail } = useRailTicketMoves({
    activeProjectId, rails, railsRef, tickets, specTickets, updateRails, updateSpecOrder, railPrDecisions, railPrDecisionsHydrated,
  })
  const dnd = useBoardDnd({
    rails, tickets, ticketMap, specTickets, doneSpecTickets, updateRails, updateSpecOrder, updateTicket,
    resetSortAfterManualReorder, railPrDecisions, railPrDecisionsHydrated,
  })

  // ── Rail controls and launch ────────────────────────────────────────────────
  const railConfig = useRailConfigHandlers(rails, updateRails, railProviders)
  const launch = useRailLaunch({
    activeProjectId, rails, tickets, ticketMap, updateRails, railProviders,
    railPrDecisions, railPrDecisionsHydrated, reviewWipLimit, pendingReview,
  })
  const { launchAllPlan, handleToggle, doLaunchRail, handleLaunchAll } = launch

  const dashboardContainerRef = useRef<HTMLDivElement | null>(null)
  const { paletteLaunchBlocker } = useBoardPalette({
    rails, tickets, jiraConnected: jira.connected, railPrDecisions, railPrDecisionsHydrated,
    handleToggle, handleMoveTicketToRail, updateTicketStatus,
  })

  // Board multi-select (CD4): bulk bar handlers + the launch confirmation they open.
  const railDecisionIndex = (railId: string) => railIndexFromId(railId) ?? rails.findIndex((r) => r.id === railId)
  const bulkActions = useSpecBulkActions({
    rails,
    jiraConnected: jira.connected,
    allLabels: allTicketLabels,
    store: { bulkDelete, bulkUpdateStatus, bulkUpdatePriority, bulkUpdateLabels },
    moveToRail: handleMoveTicketToRail,
    launchRail: (railId, rail) => doLaunchRail(railId, { silent: true, rail }),
    gates: {
      blockerOf: paletteLaunchBlocker,
      hasPendingDecision: (railId) => railPrDecisions.has(railDecisionIndex(railId)),
      takesReviewSlot: (railId) => railLaunchAddsReviewWip(railDecisionIndex(railId), railPrDecisions),
      reviewCapacity: reviewWipCapacity(reviewWipLimit, pendingReview.length),
    },
    forecastQueryOf: (rail) => (activeProjectId && !isRolesEngine(rail.aiEngine)
      ? { projectId: activeProjectId, loopId: effectiveLoopId(rail.selectedLoopId, rail.mode), provider: railProviderOf(rail, railProviders) }
      : null),
  })

  const { leftWidth, enabled: splitterEnabled, beginDrag, resetToDefault, nudge: nudgeSplit } = useDashboardSplit(activeProjectId, dashboardContainerRef)
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200

  return (
    <JiraDiscardProvider>
    <DndContext sensors={dnd.sensors} collisionDetection={dnd.collisionDetection} onDragStart={dnd.handleDragStart} onDragEnd={dnd.handleDragEnd}>
      <div ref={dashboardContainerRef} className="relative z-0 flex h-full overflow-hidden">
        {isGalaxy && <Starfield />}
        <h1 className="sr-only">{(() => {
          const projectName = projects.find((pr) => pr.id === activeProjectId)?.name
          return projectName ? t('board.pageTitle', { project: projectName }) : t('board.pageTitleBare')
        })()}</h1>
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
            onTicketDelete={(id) => {
              const attemptDelete = (): void => { void Promise.resolve(deleteTicket(id)).then((ok) => { if (!ok) notifyError(t('errors.deleteFailed'), { retry: attemptDelete }) }) }
              attemptDelete()
            }}
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
            bulk={bulkActions.handlers}
          />
        </div>

        {/* Splitter — only mounted when the viewport is wide enough. */}
        {splitterEnabled && leftWidth !== null && (
          <DashboardSplitter
            leftWidth={leftWidth}
            viewport={viewportWidth}
            onPointerDown={beginDrag}
            onReset={resetToDefault}
            onNudge={nudgeSplit}
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
            onModeChange={railConfig.handleModeChange}
            onProfileChange={railConfig.handleProfileChange}
            onEngineChange={railConfig.handleEngineChange}
            onLoopModelChange={railConfig.handleLoopModelChange}
            loopAvailable={FEATURE_LOOPS_SECTION}
            onLoopChange={railConfig.handleLoopChange}
            onEffortChange={railConfig.handleEffortChange}
            onToggle={handleToggle}
            onTargetPrChange={railConfig.handleTargetPrChange}
            onWorkspaceSelectionChange={railConfig.handleWorkspaceSelectionChange}
            onTicketClick={setDetailTicket}
            onAddRail={() => { void handleAddRail() }}
            onDeleteRail={(railId) => { void handleDeleteRail(railId) }}
            onRenameRail={handleRenameRail}
            onTicketMoveToSpecs={handleRemoveTicketFromRail}
            onLaunchAll={handleLaunchAll}
            launchAllCount={launchAllPlan.eligible.length}
            launchAllHeld={launchAllPlan.skipped.filter((s) => s.reason === 'reviewLimit').length}
            reviewWip={{ limit: reviewWipLimit, pending: pendingReview }}
          />
        </div>
      </div>

      {/* Drag overlay — renders a floating ghost while dragging. Matches the
          active view tier so a postit dragged from the postit grid keeps
          looking like a postit instead of collapsing back to a compact row. */}

      <BoardDragOverlay activeTicket={dnd.activeTicket} activeRailDragLabel={dnd.activeRailDragLabel} viewTier={viewTier} />

      {/* Modals */}
      {detailTicket && (
        <BoardSpecDetailModal
          detailTicket={detailTicket}
          setDetailTicket={setDetailTicket}
          tickets={tickets}
          allTicketLabels={allTicketLabels}
          updateTicket={updateTicket}
          deleteTicket={deleteTicket}
          rails={rails}
          handleMoveTicketToRail={handleMoveTicketToRail}
          handleRemoveTicketFromRail={handleRemoveTicketFromRail}
        />
      )}
      {bulkActions.dialogs}

      <RailLaunchDialogs launch={launch} rails={rails} reviewWipLimit={reviewWipLimit} pendingReviewCount={pendingReview.length} projectId={activeProjectId} />

    </DndContext>
    </JiraDiscardProvider>
  )
}
