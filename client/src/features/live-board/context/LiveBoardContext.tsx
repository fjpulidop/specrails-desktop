import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useDesktop } from '../../../hooks/useDesktop'
import { usePlaceParam } from '../../../hooks/usePlaceParam'
import { useUiMode } from '../../../context/UiModeContext'
import { useNativeSurface } from '../../../components/ui/surface'
import { nativeSurfaceEnabled, newSurfaceRequestId, openSurfaceWindow } from '../../../lib/native-surfaces'
import { OPEN_LIVE_BOARD_EVENT } from '../../../lib/live-board-events'
import { LIVE_BOARD_PARAM, PLACE_PUSH_STATE } from '../../../lib/places'
import { useInbox } from '../../inbox/context/InboxContext'
import { inboxTarget, type InboxTarget } from '../../inbox/lib/inbox-model'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import { useOpenMission } from '../../missions/hooks/useOpenMission'
import { primaryOf, readLiveBoardWindowResult, type LiveCard } from '../lib/live-board-model'

/** What a card can do. The main window runs the app's existing handlers; a board window forwards to it. */
export interface LiveBoardActions {
  primary: (card: LiveCard) => void
  open: (card: LiveCard) => void
  /** The card's inbox action is in flight. */
  busy: (card: LiveCard) => boolean
}

export interface LiveBoardValue {
  isOpen: boolean
  openBoard: () => void
  closeBoard: () => void
  toggleBoard: () => void
  /** Moves the board to its own native window; null where that is not possible (browser, a secondary window). */
  openInWindow: (() => void) | null
  actions: LiveBoardActions
}

const LiveBoardContext = createContext<LiveBoardValue | null>(null)

/** The live board (null outside the main window). */
export function useLiveBoard(): LiveBoardValue | null {
  return useContext(LiveBoardContext)
}

/**
 * The live board's place (`?live=1`) and its card actions, in the main window.
 * In the desktop app the board is always its own native window (like Settings
 * and job detail): every way in (sidebar, palette, ⌘⇧B, a `?live=1` entry)
 * opens or focuses that window, and ⌘⇧B shows or hides it. The in-page dialog
 * is the browser's, and the fallback when the window cannot open.
 * Every action is an existing handler: the inbox's primary for an inbox item,
 * the review / job places the inbox opens, and the mission opener the command
 * palette uses. Opening something leaves the board the way the inbox does: the
 * `?live=1` entry is replaced by the place it leads to (Back returns to where
 * the person was before the board).
 */
export function LiveBoardProvider({ children }: { children: ReactNode }) {
  const place = usePlaceParam(LIVE_BOARD_PARAM)
  const isOpen = place.value === '1'
  const { open: openPlace, close: closePlace } = place
  // The native window (desktop app). `nativeRef` follows useNativeSurface below: false in
  // the browser, and once a window failed to open (the board then stays in-page).
  const [windowOpen, setWindowOpen] = useState(false)
  const windowOpenRef = useRef(windowOpen)
  windowOpenRef.current = windowOpen
  const nativeRef = useRef(nativeSurfaceEnabled('live-board'))
  const showWindow = useCallback(() => {
    // Already open: asking for the singleton again focuses it (surface_windows.rs reuses it).
    if (windowOpenRef.current) { void openSurfaceWindow('live-board', {}, newSurfaceRequestId()).catch(() => {}); return }
    setWindowOpen(true)
  }, [])
  const openBoard = useCallback(() => { if (nativeRef.current) showWindow(); else openPlace('1') }, [showWindow, openPlace])
  const closeBoard = useCallback(() => { if (windowOpenRef.current) setWindowOpen(false); closePlace() }, [closePlace])
  const toggleBoard = useCallback(() => {
    if (nativeRef.current) { if (windowOpenRef.current) setWindowOpen(false); else setWindowOpen(true); return }
    if (isOpen) closePlace(); else openPlace('1')
  }, [isOpen, openPlace, closePlace])
  useEffect(() => {
    window.addEventListener(OPEN_LIVE_BOARD_EVENT, openBoard)
    return () => window.removeEventListener(OPEN_LIVE_BOARD_EVENT, openBoard)
  }, [openBoard])

  const navigate = useNavigate()
  const location = useLocation()
  const locationRef = useRef(location)
  locationRef.current = location
  const { activeProjectId, setActiveProjectId } = useDesktop()
  const { uiMode } = useUiMode()
  const uiModeRef = useRef(uiMode)
  uiModeRef.current = uiMode
  const inbox = useInbox()
  const { selectConversation, open: openAgentPanel } = useAgentChat()
  const openMission = useOpenMission()

  /** Drop `?live=1` from the current entry in place, so the next place replaces the board in history. */
  const leaveBoard = useCallback(() => {
    const loc = locationRef.current
    const params = new URLSearchParams(loc.search)
    if (params.get(LIVE_BOARD_PARAM) !== '1') return
    params.delete(LIVE_BOARD_PARAM)
    const search = params.toString()
    const state = (loc.state && typeof loc.state === 'object' ? { ...(loc.state as Record<string, unknown>) } : {})
    if (state[PLACE_PUSH_STATE] === LIVE_BOARD_PARAM) delete state[PLACE_PUSH_STATE]
    navigate({ pathname: loc.pathname, search: search ? `?${search}` : '' }, { replace: true, state })
  }, [navigate])

  // Another project's run: switch first, navigate one frame after the switch (the route
  // memory restores the incoming project's page in the same commit, like the inbox).
  const pending = useRef<{ projectId: string; target: InboxTarget } | null>(null)
  const navigateTo = useCallback((target: InboxTarget) => {
    navigate({ pathname: target.pathname, search: target.search }, { state: { [PLACE_PUSH_STATE]: target.place } })
  }, [navigate])
  const navigateToRef = useRef(navigateTo)
  navigateToRef.current = navigateTo
  const goTo = useCallback((projectId: string, target: InboxTarget) => {
    leaveBoard()
    if (projectId !== activeProjectId) {
      pending.current = { projectId, target }
      setActiveProjectId(projectId)
      return
    }
    navigateTo(target)
  }, [activeProjectId, setActiveProjectId, leaveBoard, navigateTo])
  useEffect(() => {
    const next = pending.current
    if (!next || next.projectId !== activeProjectId) return
    pending.current = null
    const frame = requestAnimationFrame(() => navigateToRef.current(next.target))
    return () => cancelAnimationFrame(frame)
  }, [activeProjectId])

  const open = useCallback((card: LiveCard) => {
    if (card.conversationId) {
      leaveBoard()
      // The command palette's mission opener: Mission mode shows it (switching project when pinned elsewhere); the board shows the floating panel.
      if (uiModeRef.current === 'agent') openMission(card.conversationId)
      else { void selectConversation(card.conversationId); openAgentPanel() }
      return
    }
    if (card.jobId) goTo(card.projectId, inboxTarget({ action: 'open-run', subjectId: card.jobId, conversationId: null }, uiModeRef.current))
  }, [leaveBoard, openMission, selectConversation, openAgentPanel, goTo])

  const primary = useCallback((card: LiveCard) => {
    const action = primaryOf(card)
    if (action.kind === 'inbox') {
      if (!inbox) return
      // Resume and Retry act on the run and stay on the board; every other inbox action goes to its place.
      if (action.item.action !== 'resume-run' && action.item.action !== 'retry-jira') leaveBoard()
      void inbox.runPrimary(action.item)
      return
    }
    if (action.kind === 'review') {
      goTo(card.projectId, inboxTarget({ action: 'open-review', subjectId: action.deliveryId, conversationId: card.conversationId }, uiModeRef.current))
      return
    }
    if (action.kind === 'open') open(card)
  }, [inbox, leaveBoard, goTo, open])

  const busy = useCallback((card: LiveCard) => !!card.attention && !!inbox?.busy.has(card.attention.id), [inbox])
  const actions = useMemo<LiveBoardActions>(() => ({ primary, open, busy }), [primary, open, busy])

  // ── Its own native window (desktop app): the window forwards card actions here.
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const native = useNativeSurface({
    id: 'live-board',
    open: windowOpen,
    onClose: () => setWindowOpen(false),
    onResult: (value) => {
      const result = readLiveBoardWindowResult(value)
      if (!result) return
      if (result.action === 'primary') actionsRef.current.primary(result.card)
      else actionsRef.current.open(result.card)
    },
  })
  nativeRef.current = native
  // The window could not open (an older host): bring the board back here.
  useEffect(() => {
    if (windowOpen && !native) { setWindowOpen(false); openPlace('1') }
  }, [windowOpen, native, openPlace])
  // A `?live=1` entry (a deep link, Back, another caller of the place) in the desktop app:
  // the window shows the board, the main window keeps the page it was on.
  useEffect(() => {
    if (isOpen && native) { closePlace(); showWindow() }
  }, [isOpen, native, closePlace, showWindow])
  // The in-page board shows in the desktop app only when its window cannot open, so the
  // "open in window" button has nothing to offer there; it stays for hosts that can.
  const openInWindow = useMemo(() => (native ? () => { closePlace(); showWindow() } : null), [native, closePlace, showWindow])

  const value = useMemo<LiveBoardValue>(() => ({ isOpen, openBoard, closeBoard, toggleBoard, openInWindow, actions }), [isOpen, openBoard, closeBoard, toggleBoard, openInWindow, actions])
  return <LiveBoardContext.Provider value={value}>{children}</LiveBoardContext.Provider>
}
