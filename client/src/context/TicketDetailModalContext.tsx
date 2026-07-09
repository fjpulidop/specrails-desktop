import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { useTickets } from '../hooks/useTickets'
import { useDesktop } from '../hooks/useDesktop'
import { SplitViewShell } from '../components/SplitViewShell'
import { TicketDetailModal } from '../components/TicketDetailModal'
import { MODAL_FLOAT_VIEWPORT_MIN } from '../lib/viewport'

export type CompareSide = 'left' | 'right'

interface SplitState {
  /** Ticket id shown on the left panel (or in centered modal when not in split). */
  leftId: number | null
  /** Ticket id shown on the right panel; only set in split mode. */
  rightId: number | null
  /** Which side holds the originally-opened ticket. `null` ⇒ not in split mode (centered modal). */
  originSide: CompareSide | null
  /** Left-panel ratio of the viewport when in split mode. Range [0.25, 0.75]. */
  splitRatio: number
}

const INITIAL_RATIO = 0.5
const MIN_RATIO = 0.25
const MAX_RATIO = 0.75

const INITIAL_STATE: SplitState = {
  leftId: null,
  rightId: null,
  originSide: null,
  splitRatio: INITIAL_RATIO,
}

type Action =
  | { type: 'openCentered'; id: number }
  | { type: 'closeAll' }
  | { type: 'enterSplit'; side: CompareSide; ticketId?: number }
  | { type: 'setComparedTicket'; id: number | null; side: CompareSide }
  | { type: 'exitSplit' }
  | { type: 'setSplitRatio'; ratio: number }

function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return INITIAL_RATIO
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r))
}

export function reduceSplit(state: SplitState, action: Action): SplitState {
  switch (action.type) {
    case 'openCentered': {
      if (state.originSide !== null && state.leftId !== action.id && state.rightId !== action.id) {
        return { leftId: action.id, rightId: null, originSide: null, splitRatio: INITIAL_RATIO }
      }
      if (state.originSide !== null && (state.leftId === action.id || state.rightId === action.id)) {
        return state
      }
      return { ...INITIAL_STATE, leftId: action.id }
    }
    case 'closeAll':
      return INITIAL_STATE
    case 'enterSplit': {
      const baseId = action.ticketId ?? state.leftId
      if (baseId === null) return state
      if (state.originSide !== null) return state
      if (action.side === 'left') {
        return { leftId: baseId, rightId: null, originSide: 'left', splitRatio: INITIAL_RATIO }
      }
      return {
        leftId: null,
        rightId: baseId,
        originSide: 'right',
        splitRatio: INITIAL_RATIO,
      }
    }
    case 'setComparedTicket': {
      if (state.originSide === null) return state
      const oppositeSide: CompareSide = state.originSide === 'left' ? 'right' : 'left'
      if (action.side !== oppositeSide) return state
      if (action.side === 'left') return { ...state, leftId: action.id }
      return { ...state, rightId: action.id }
    }
    case 'exitSplit': {
      if (state.originSide === null) return state
      const keepId = state.originSide === 'left' ? state.leftId : state.rightId
      return { ...INITIAL_STATE, leftId: keepId }
    }
    case 'setSplitRatio':
      return { ...state, splitRatio: clampRatio(action.ratio) }
    default:
      return state
  }
}

interface TicketDetailModalContextValue {
  openTicketDetail: (ticketId: number) => void
  /** Open a ticket that may live in a NON-active project (agent-chat ref chips):
   *  when `projectId` differs from the active project, the provider switches the
   *  active project first (MinimizedChats-restore precedent) and completes the
   *  open once the switch lands — this provider and every board surface are
   *  active-project bound, so a true cross-project modal is not possible. */
  openTicketDetailInProject: (projectId: string, ticketId: number) => void
  closeTicketDetail: () => void
  enterSplit: (side: CompareSide, ticketId?: number) => void
  setComparedTicket: (ticketId: number | null, side: CompareSide) => void
  exitSplit: () => void
  setSplitRatio: (ratio: number) => void
  state: SplitState
}

const TicketDetailModalContext = createContext<TicketDetailModalContextValue | null>(null)

const COMPARE_VIEWPORT_MIN = MODAL_FLOAT_VIEWPORT_MIN

export function TicketDetailModalProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceSplit, INITIAL_STATE)
  const { tickets, updateTicket, deleteTicket } = useTickets()
  const { activeProjectId, setActiveProjectId } = useDesktop()

  // Cross-project open in flight (agent-chat ref chips): the ticket to open
  // once the active project lands on `projectId`. Completed (or dropped) by
  // the switch effect below.
  const pendingCrossProjectRef = useRef<{ projectId: string; ticketId: number } | null>(null)

  // M22: this provider sits ABOVE the project-keyed route boundary, so an open
  // modal / split-view survives a project switch. Ticket ids are per-project
  // sequential integers (they collide across projects), so `tickets.find(id ===
  // leftId)` would silently re-bind to a DIFFERENT project's ticket with the same
  // id — and Save would PATCH the wrong project. Close everything on switch,
  // THEN complete a pending cross-project open (both dispatches land in the
  // same effect run, so the reducer settles on the opened ticket).
  useEffect(() => {
    dispatch({ type: 'closeAll' })
    const pending = pendingCrossProjectRef.current
    if (pending) {
      pendingCrossProjectRef.current = null
      if (pending.projectId === activeProjectId) {
        dispatch({ type: 'openCentered', id: pending.ticketId })
      }
    }
  }, [activeProjectId])

  const openTicketDetail = useCallback((id: number) => dispatch({ type: 'openCentered', id }), [])

  const openTicketDetailInProject = useCallback(
    (projectId: string, ticketId: number) => {
      if (projectId === activeProjectId) {
        dispatch({ type: 'openCentered', id: ticketId })
        return
      }
      pendingCrossProjectRef.current = { projectId, ticketId }
      setActiveProjectId(projectId)
    },
    [activeProjectId, setActiveProjectId],
  )
  const closeTicketDetail = useCallback(() => dispatch({ type: 'closeAll' }), [])
  const enterSplit = useCallback(
    (side: CompareSide, ticketId?: number) => {
      // Authoritative boundary for every split entry point (button, drag, URL
      // sync, agent refs). Visibility alone cannot enforce this when a resize
      // and an action land in the same frame.
      if (typeof window !== 'undefined' && window.innerWidth < COMPARE_VIEWPORT_MIN) return
      dispatch({ type: 'enterSplit', side, ticketId })
    },
    [],
  )
  const setComparedTicket = useCallback(
    (id: number | null, side: CompareSide) => dispatch({ type: 'setComparedTicket', id, side }),
    [],
  )
  const exitSplit = useCallback(() => dispatch({ type: 'exitSplit' }), [])
  const setSplitRatio = useCallback((ratio: number) => dispatch({ type: 'setSplitRatio', ratio }), [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    function onResize() {
      if (window.innerWidth < COMPARE_VIEWPORT_MIN) {
        dispatch({ type: 'exitSplit' })
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const allLabels = useMemo(() => {
    const set = new Set<string>()
    for (const t of tickets) for (const l of t.labels ?? []) set.add(l)
    return Array.from(set).sort()
  }, [tickets])

  const leftTicket = state.leftId != null ? tickets.find((t) => t.id === state.leftId) ?? null : null
  const rightTicket = state.rightId != null ? tickets.find((t) => t.id === state.rightId) ?? null : null

  const value = useMemo<TicketDetailModalContextValue>(
    () => ({
      openTicketDetail,
      openTicketDetailInProject,
      closeTicketDetail,
      enterSplit,
      setComparedTicket,
      exitSplit,
      setSplitRatio,
      state,
    }),
    [openTicketDetail, openTicketDetailInProject, closeTicketDetail, enterSplit, setComparedTicket, exitSplit, setSplitRatio, state],
  )

  const inSplit = state.originSide !== null

  return (
    <TicketDetailModalContext.Provider value={value}>
      {children}
      {!inSplit && leftTicket && (
        <TicketDetailModal
          key={leftTicket.id}
          ticket={leftTicket}
          allLabels={allLabels}
          allTickets={tickets}
          onClose={closeTicketDetail}
          onOpenTicket={openTicketDetail}
          onSave={updateTicket}
          onDelete={(id) => {
            deleteTicket(id)
            closeTicketDetail()
          }}
        />
      )}
      {inSplit && (
        <SplitViewShell
          state={state}
          leftTicket={leftTicket}
          rightTicket={rightTicket}
          allTickets={tickets}
          allLabels={allLabels}
          onSave={updateTicket}
          onDelete={(id) => {
            deleteTicket(id)
            closeTicketDetail()
          }}
          onOpenTicket={openTicketDetail}
          onCloseAll={closeTicketDetail}
          onSetCompared={setComparedTicket}
          onSetRatio={setSplitRatio}
          onExitSplit={exitSplit}
        />
      )}
    </TicketDetailModalContext.Provider>
  )
}

export function useTicketDetailModal(): TicketDetailModalContextValue {
  const ctx = useContext(TicketDetailModalContext)
  if (!ctx) {
    return {
      openTicketDetail: () => {
        if (typeof console !== 'undefined') {
          console.warn('[TicketDetailModalContext] openTicketDetail called without provider')
        }
      },
      openTicketDetailInProject: () => {
        if (typeof console !== 'undefined') {
          console.warn('[TicketDetailModalContext] openTicketDetailInProject called without provider')
        }
      },
      closeTicketDetail: () => {},
      enterSplit: () => {},
      setComparedTicket: () => {},
      exitSplit: () => {},
      setSplitRatio: () => {},
      state: INITIAL_STATE,
    }
  }
  return ctx
}

export { INITIAL_STATE, INITIAL_RATIO, MIN_RATIO, MAX_RATIO }
export type { SplitState }
