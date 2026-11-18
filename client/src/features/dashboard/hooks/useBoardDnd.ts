/**
 * Drag and drop of the board: sensors, the two-domain collision detection
 * (rail reorder vs ticket drag), the floating overlay's subject and the drop
 * rules between Specs, Done and rails.
 */
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
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
import { notifyError } from '../../../lib/notify-error'
import { isRailSortId, extractRailId, type RailState } from '../../rails/components/RailsBoard'
import type { LocalTicket, RailPrStateSnapshot } from '../../../types'
import { insertAt, resolveDestContainer } from '../lib/dashboard-dnd'
import { ticketHasContinuablePr } from '../lib/board-rails'
import type { useTickets } from '../../specs/hooks/useTickets'
import type { RailsUpdater, SpecOrderUpdater } from './useBoardRails'

export function useBoardDnd(args: {
  rails: RailState[]
  tickets: LocalTicket[]
  ticketMap: ReadonlyMap<number, LocalTicket>
  specTickets: LocalTicket[]
  doneSpecTickets: LocalTicket[]
  updateRails: RailsUpdater
  updateSpecOrder: SpecOrderUpdater
  updateTicket: ReturnType<typeof useTickets>['updateTicket']
  resetSortAfterManualReorder: () => void
  railPrDecisions: ReadonlyMap<number, RailPrStateSnapshot>
  railPrDecisionsHydrated: boolean
}) {
  const {
    rails, tickets, ticketMap, specTickets, doneSpecTickets, updateRails, updateSpecOrder, updateTicket,
    resetSortAfterManualReorder, railPrDecisions, railPrDecisionsHydrated,
  } = args
  const { t } = useTranslation('dashboard')
  const [activeId, setActiveId] = useState<number | null>(null)
  const [activeRailDragLabel, setActiveRailDragLabel] = useState<string | null>(null)

  // Dynamic container IDs for DnD (specs + all current rail IDs)
  const containerIds = useMemo(() => {
    const ids = new Set<string>(['specs', 'done-specs'])
    for (const r of rails) ids.add(r.id)
    return ids
  }, [rails])

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
          resetSortAfterManualReorder()
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
        if (tickets.find((tk) => tk.id === draggedId)?.status === 'on_review' && (!railPrDecisionsHydrated || !ticketHasContinuablePr(draggedId, railPrDecisions, tickets))) {
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
          notifyError(t('toasts.railRunningStopFirst', { rail: sourceRail.label }))
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

  const activeTicket = activeId !== null ? ticketMap.get(activeId) : undefined

  return { sensors, collisionDetection, handleDragStart, handleDragEnd, activeTicket, activeRailDragLabel }
}
