import { motion } from 'motion/react'
import { SIDE_PANE_FIT } from '../lib/mission-side-pane'
import { useReducedMotion } from '../../../hooks/useReducedMotion'
import { composerReferenceDrafts, useComposerDraftRevision } from '../lib/agent-composer-drafts'
import { ticketChip } from '../lib/agent-context-palette'
import { SPEC_DRAG_TYPE } from '../lib/agent-spec-drag'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ArrowUpRight, ChevronRight, ListChecks, Maximize2, Minimize2, X } from 'lucide-react'
import { useRailPrDecisions } from '../../delivery/context/RailPrDecisionContext'
import { deriveSpecActivity, type SpecActivity, type MissionFacts, type SpecActivityEntry } from '../lib/spec-activity'
import { specActivityRunState } from '../lib/mission-run-state'
import { RunStateDot } from '../../../components/ui/run-state/run-state-dot'
import { runStateLook } from '../../../components/ui/run-state/run-state'
import { focusPrCard, requestMissionOpenRun } from './agent-run-failure'
import { useAgentChat } from '../context/AgentChatContext'
import { useOpenMission } from '../hooks/useOpenMission'
import { RailTrack } from '../../../components/brand/RailTrack'
import { cn } from '../../../lib/utils'
import type { LocalTicket, TicketStatus } from '../../../types'
import { TicketStatusBadge } from '../../specs/components/TicketStatusIndicator'
import { useTicketDetailModal } from '../../specs/context/TicketDetailModalContext'
import { useTickets } from '../../specs/hooks/useTickets'
import { useAgentWorkspace } from '../context/AgentWorkspaceContext'

const MIN_PANE = 320
const DEFAULT_PANE = 420

/** Open work first, most advanced on top; closed specs fold away below. */
const OPEN_ORDER: TicketStatus[] = ['in_progress', 'on_review', 'todo', 'draft']
const CLOSED: ReadonlySet<TicketStatus> = new Set<TicketStatus>(['done', 'cancelled'])

export function groupSpecs(tickets: readonly LocalTicket[]): { open: LocalTicket[]; closed: LocalTicket[] } {
  const rank = (status: TicketStatus): number => {
    const index = OPEN_ORDER.indexOf(status)
    return index === -1 ? OPEN_ORDER.length : index
  }
  const open = tickets
    .filter((ticket) => !CLOSED.has(ticket.status))
    .sort((a, b) => rank(a.status) - rank(b.status) || b.id - a.id)
  const closed = tickets.filter((ticket) => CLOSED.has(ticket.status)).sort((a, b) => b.id - a.id)
  return { open, closed }
}

function activityLabel(t: TFunction<'agent'>, activity: SpecActivity): string {
  const rail = activity.railIndex === null ? null : activity.railIndex + 1
  if (rail === null) return t(activity.phase === 'paused' ? 'workspace.specActivity.intentPaused' : 'workspace.specActivity.intentRunning')
  return t(`workspace.specActivity.${activity.phase === 'paused' ? 'running' : activity.phase}`, { rail })
}

/** The row's shortcut target: another mission, this mission's run card, or (dashboard launch) the run log. */
type ActivityTarget = 'mission' | 'run-card' | 'run-log'

function activityTarget(activity: SpecActivity, currentConversationId: string | null): ActivityTarget | null {
  if (activity.conversationId && activity.conversationId !== currentConversationId) return 'mission'
  if (activity.conversationId && activity.prDeliveryId) return 'run-card'
  if (!activity.conversationId && activity.runIds.length > 0) return 'run-log'
  return null
}

function SpecRow({ ticket, onOpen, projectId, draftKey, fresh, entry, currentConversationId, onOpenMission, onPrefetchMission }: {
  ticket: LocalTicket; onOpen: (id: number) => void; projectId: string; draftKey: string; fresh: boolean
  entry?: SpecActivityEntry; currentConversationId: string | null
  onOpenMission: (conversationId: string) => void; onPrefetchMission?: (conversationId: string) => void
}) {
  const { t } = useTranslation('agent')
  const reduceMotion = useReducedMotion()
  const dragged = useRef(false)
  const activity = entry?.shown
  const link = entry?.link
  const label = activity ? activityLabel(t, activity) : null
  const linkLabel = link ? activityLabel(t, link) : null
  const target = link ? activityTarget(link, currentConversationId) : null
  const goTo = () => {
    if (!link || !target) return
    if (target === 'mission' && link.conversationId) onOpenMission(link.conversationId)
    else if (target === 'run-card') focusPrCard({ prDeliveryId: link.prDeliveryId, runIds: link.runIds, conversationId: link.conversationId })
    else if (target === 'run-log') requestMissionOpenRun({ projectId, jobId: link.runIds[0] })
  }
  const goToLabel = target === 'mission' ? t('workspace.specActivity.openMission') : t('workspace.specActivity.openRun')
  return (
    <motion.li
      initial={false}
      data-spec-arriving={fresh || undefined}
      data-spec-activity={activity?.phase}
      className={cn(
        'relative flex items-center overflow-hidden rounded-lg border transition-colors',
        // A spec with live activity is outlined in its state's tone (status vocabulary).
        activity ? cn(runStateLook(specActivityRunState(activity.phase)).border, 'bg-surface/30') : 'border-border/50 bg-surface/30',
        'hover:border-accent-primary/40 hover:bg-surface/60',
      )}
      animate={fresh && !reduceMotion ? {
        opacity: [0, 1, 1], x: [16, 0, 0],
        boxShadow: ['0 0 0 1px var(--color-accent-primary)', '0 0 18px 2px var(--color-accent-primary)', '0 0 0 0 transparent'],
      } : { opacity: 1, x: 0, boxShadow: '0 0 0 0 transparent' }}
      transition={{ duration: reduceMotion ? 0 : 0.9, times: [0, 0.35, 1] }}
    >
      <button
        type="button"
        draggable
        onDragStart={(event) => {
          dragged.current = true
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(SPEC_DRAG_TYPE, JSON.stringify({ draftKey, chip: ticketChip(ticket, projectId, null) }))
        }}
        onPointerDown={() => { dragged.current = false }}
        onClick={(event) => { if (!dragged.current || event.detail === 0) onOpen(ticket.id) }}
        className="flex min-w-0 flex-1 cursor-grab items-center gap-2 px-2.5 py-2 text-left active:cursor-grabbing"
      >
        {activity && label && (
          <RunStateDot state={specActivityRunState(activity.phase)} title={label} />
        )}
        <span className="shrink-0 font-mono text-caption text-muted-foreground">#{ticket.id}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={ticket.title}>{ticket.title}</span>
        {label && <span className="sr-only">{label}</span>}
        <TicketStatusBadge status={ticket.status} className="shrink-0" />
      </button>
      {link && target && (
        <button
          type="button"
          onClick={goTo}
          onPointerEnter={() => { if (target === 'mission' && link.conversationId) onPrefetchMission?.(link.conversationId) }}
          aria-label={`${goToLabel} — ${linkLabel}`}
          title={`${goToLabel} · ${linkLabel}`}
          data-spec-activity-link={target}
          className="mr-1.5 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
      )}
      {activity?.phase === 'running' && (
        <RailTrack running className="pointer-events-none absolute inset-x-2 bottom-0 h-1.5 w-auto min-w-0" />
      )}
    </motion.li>
  )
}

/**
 * Agent-Mode inline Specs pane (same split chrome as `AgentModeJobsPane`): the
 * whole backlog of the mission's project with each spec's status, live beside
 * the conversation. Clicking opens its detail; dragging references it in the draft.
 * `useTickets` is bound to the active project (which follows the mission) and
 * applies ticket WS events, so the list never shows another project's specs.
 */
export function AgentModeSpecsPane({ projectId, draftKey }: { projectId: string; draftKey: string }) {
  const { t } = useTranslation('agent')
  const { closeSpecsPane } = useAgentWorkspace()
  const { tickets, isLoading, newTicketIds } = useTickets()
  const { openTicketDetail } = useTicketDetailModal()
  const [width, setWidth] = useState(DEFAULT_PANE)
  const [maximized, setMaximized] = useState(false)
  const resizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => { resizeCleanup.current?.() }, [maximized])
  const [closedExpanded, setClosedExpanded] = useState(false)
  useComposerDraftRevision(draftKey)
  const attachedIds = new Set((composerReferenceDrafts.get(draftKey) ?? [])
    .filter(ref => ref.chip.kind === 'spec' && ref.chip.projectId === projectId).map(ref => ref.chip.id))
  const grouped = groupSpecs(tickets)
  const open = grouped.open.filter(ticket => !attachedIds.has(String(ticket.id)))
  const closed = grouped.closed.filter(ticket => !attachedIds.has(String(ticket.id)))
  const { decisions } = useRailPrDecisions()
  const { active, prefetchConversation, conversations, archiveScope } = useAgentChat()
  const activity = useMemo(() => {
    const known = new Map<string, MissionFacts>()
    for (const mission of [...(conversations ?? []), ...(active ? [active] : [])]) {
      const at = Date.parse(mission.created_at)
      known.set(mission.id, { createdAt: Number.isFinite(at) ? at : null, archived: Boolean(mission.archivedAt) })
    }
    // The list holds only the scope the person picked: a mission missing from
    // the "active" list is archived; one missing from the "archived" list is not.
    const unlisted: MissionFacts = { createdAt: null, archived: archiveScope === 'active' }
    return deriveSpecActivity(tickets, decisions.values(), (id) => known.get(id) ?? unlisted)
  }, [tickets, decisions, conversations, active, archiveScope])
  const openMission = useOpenMission()
  const rowProps = (ticket: LocalTicket) => ({
    ticket, onOpen: openTicketDetail, projectId, draftKey, fresh: newTicketIds.has(ticket.id),
    entry: activity.get(ticket.id), currentConversationId: active?.id ?? null,
    onOpenMission: openMission, onPrefetchMission: prefetchConversation,
  })


  const beginResize = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    resizeCleanup.current?.()
    const startX = e.clientX
    const startWidth = width
    const maxWidth = window.innerWidth - 360
    const pointerId = e.pointerId
    const target = e.currentTarget
    const previousSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const preventSelection = (event: Event) => event.preventDefault()
    document.addEventListener('selectstart', preventSelection)
    try { target.setPointerCapture(pointerId) } catch { /* optional in webviews */ }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      setWidth(Math.min(Math.max(startWidth + startX - ev.clientX, MIN_PANE), maxWidth))
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', finish)
      target.removeEventListener('lostpointercapture', finish)
      document.removeEventListener('selectstart', preventSelection)
      document.body.style.userSelect = previousSelect
      document.body.style.cursor = previousCursor
      try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId) } catch { /* already released */ }
      resizeCleanup.current = null
    }
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish() }
    resizeCleanup.current = finish
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', finish)
    target.addEventListener('lostpointercapture', finish)
  }, [width])

  return (
    <div data-area="specs"
      data-agent-specs-pane
      className={cn(
        'area-surface flex h-full flex-col overflow-hidden border-l border-border bg-background',
        maximized ? 'absolute inset-0 z-30 border-l-0' : cn('relative', SIDE_PANE_FIT),
      )}
      style={maximized ? undefined : { width, flexShrink: 0 }}
    >
      {!maximized && (
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={beginResize}
          className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize select-none touch-none hover:bg-accent-primary/20"
          title={t('workspace.resizeSpecs')}
        />
      )}
      <div className="area-header flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface/40 px-3">
        <span className="text-label text-muted-foreground">{t('workspace.specs')}</span>
        {tickets.length > 0 && (
          <span className="text-caption text-muted-foreground">{grouped.open.length}/{tickets.length}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMaximized((m) => !m)}
            aria-label={maximized ? t('restore') : t('maximize')}
            title={maximized ? t('restore') : t('maximize')}
            className="rounded-md p-1 text-muted-foreground hover:bg-surface hover:text-foreground"
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={closeSpecsPane}
            aria-label={t('workspace.closeSpecs')}
            title={t('workspace.closeSpecs')}
            className="rounded-md p-1 text-muted-foreground hover:bg-surface hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tickets.length === 0 && isLoading ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <RailTrack running className="w-16 shrink-0" />
          </div>
        ) : tickets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <ListChecks className="h-6 w-6 opacity-40" />
            <p className="text-xs">{t('workspace.noSpecs')}</p>
          </div>
        ) : (
          <>
            {open.length > 0 && (
              <ul className="space-y-1">
                {open.map((ticket) => <SpecRow key={ticket.id} {...rowProps(ticket)} />)}
              </ul>
            )}
            {closed.length > 0 && (
              <div className={cn(open.length > 0 && 'mt-3')}>
                <button
                  type="button"
                  aria-expanded={closedExpanded}
                  onClick={() => setClosedExpanded((v) => !v)}
                  className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-caption text-muted-foreground hover:bg-surface hover:text-foreground"
                >
                  <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', closedExpanded && 'rotate-90')} />
                  {t('workspace.specsClosed')}
                  <span className="text-muted-foreground">{closed.length}</span>
                </button>
                {closedExpanded && (
                  <ul className="mt-1 space-y-1">
                    {closed.map((ticket) => <SpecRow key={ticket.id} {...rowProps(ticket)} />)}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
