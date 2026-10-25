import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAgentChat } from '../context/AgentChatContext'
import { useUiMode } from '../../../context/UiModeContext'
import { usePlaceHistory } from '../../../hooks/usePlaceHistory'
import { MISSION_PARAM, PLACE_PUSH_STATE, consumeUserPlaceIntent } from '../../../lib/places'

/**
 * Keeps the selected mission and `?mission=<id>` in step (Mission mode only).
 *
 * - A mission the person picks is a place: PUSH. Anything the app selects on
 *   its own (initial restore, the first send creating the conversation) is a
 *   REPLACE, so it never adds a Back stop.
 * - Back/Forward changes the URL: the matching mission is selected. Nothing is
 *   created or launched (no new-mission draft); a mission that no longer exists
 *   is reported so the history skips it.
 * - Starting a new mission (the empty compose screen) clears the param with a
 *   push, so Back returns to the mission you left; that compose entry is not
 *   restorable on Forward (see `placeKey`).
 */
/**
 * With the browser router the History API is updated at once while the router's
 * React state commits as a transition, so under load `location` can trail the
 * real URL. A revisit paints from cache instantly, which makes that window
 * reachable: act on the real URL, and never read a trailing router state as the
 * person's navigation (it would pull them back to the mission they just left).
 * Memory routers (tests, embedded) never touch window.history and read as in sync.
 */
function routerTrailsHistory(routerKey: string): boolean {
  if (typeof window === 'undefined') return false
  const state = window.history.state as { idx?: unknown; key?: unknown } | null
  return typeof state?.idx === 'number' && typeof state.key === 'string' && state.key !== routerKey
}
function liveSearch(routerSearch: string): string {
  if (typeof window === 'undefined') return routerSearch
  const state = window.history.state as { idx?: unknown } | null
  return typeof state?.idx === 'number' ? window.location.search : routerSearch
}

/** Same rule for the path: writing the mission param onto a trailing router path would navigate back to the old page. */
function livePathname(routerPathname: string): string {
  if (typeof window === 'undefined') return routerPathname
  const state = window.history.state as { idx?: unknown } | null
  return typeof state?.idx === 'number' ? window.location.pathname : routerPathname
}

export function useMissionPlaceSync(): void {
  const chat = useAgentChat()
  const { uiMode } = useUiMode()
  const places = usePlaceHistory()
  const location = useLocation()
  const navigate = useNavigate()

  const agent = uiMode === 'agent'
  const activeId = chat.active?.id ?? null
  const urlMission = new URLSearchParams(location.search).get(MISSION_PARAM)
  const onDocsRoute = location.pathname.startsWith('/docs')

  const chatRef = useRef(chat)
  chatRef.current = chat
  const placesRef = useRef(places)
  placesRef.current = places
  const locationRef = useRef(location)
  locationRef.current = location
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  // Mission titles label the history targets.
  const registerLabelResolver = places?.registerLabelResolver
  useEffect(() => {
    if (!registerLabelResolver) return
    return registerLabelResolver((kind, id) => {
      if (kind !== 'mission') return null
      const title = chatRef.current.conversations.find((c) => c.id === id)?.title
      return title && title.trim() ? title : null
    })
  }, [registerLabelResolver])

  // URL → mission (Back / Forward / deep link).
  const appliedRef = useRef<string | null>(null)
  const requestedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!agent) return
    if (routerTrailsHistory(locationRef.current.key)) return // the router is still catching up to the URL
    if (!urlMission) { appliedRef.current = null; requestedRef.current = null; return }
    if (urlMission === activeId) { appliedRef.current = urlMission; requestedRef.current = null; return }
    if (appliedRef.current === urlMission) return // already requested
    appliedRef.current = urlMission
    requestedRef.current = urlMission
    const wanted = urlMission
    chatRef.current.selectConversation(wanted, { placeRestore: true }).catch(() => {
      if (requestedRef.current === wanted) requestedRef.current = null
      // A transient failure (offline, server restarting) is not a deleted mission.
      if (chatRef.current.conversations.some((c) => c.id === wanted)) return
      placesRef.current?.reportMissing('mission')
    })
  }, [agent, urlMission, activeId, location.key])

  // Mission → URL.
  const prevActiveRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const prev = prevActiveRef.current
    prevActiveRef.current = activeId
    if (!agent || onDocsRoute) return
    const loc = locationRef.current
    const params = new URLSearchParams(liveSearch(loc.search))
    const current = params.get(MISSION_PARAM)
    if (current === activeId) return
    const changed = prev !== undefined && prev !== activeId
    // A restore is still loading the mission the URL names: leave the URL alone.
    if (activeId !== null && current && requestedRef.current === current) return
    // Nothing selected yet (first paint / list loading): do not erase a deep link.
    if (activeId === null && !changed) return
    if (activeId) params.set(MISSION_PARAM, activeId)
    else params.delete(MISSION_PARAM)
    const search = params.toString()
    const to = { pathname: livePathname(loc.pathname), search: search ? `?${search}` : '' }
    const prevState = (loc.state && typeof loc.state === 'object' ? loc.state : {}) as Record<string, unknown>
    if (changed && consumeUserPlaceIntent()) {
      navigateRef.current(to, { state: { ...prevState, [PLACE_PUSH_STATE]: MISSION_PARAM } })
    } else {
      navigateRef.current(to, { replace: true, state: prevState })
    }
  }, [agent, activeId, urlMission, onDocsRoute])
}
