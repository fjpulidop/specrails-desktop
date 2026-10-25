import { useCallback, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PLACE_PUSH_STATE } from '../lib/places'

export interface PlaceParam {
  /** Current value of the search param, or null. */
  value: string | null
  /**
   * Open the place: PUSHES a history entry (so Back closes it) unless
   * `replace` is set. A no-op when the param already has this value, so a
   * re-render or a duplicate click never adds a duplicate entry.
   */
  open: (value: string, options?: { replace?: boolean }) => void
  /**
   * Close the place. When this very entry was pushed by `open`, pops it
   * (back to where the user was); otherwise removes the param in place
   * (replace) so a deep link / restored entry never traps the user.
   */
  close: () => void
}

/**
 * One search param as a navigable place. Reads the live location through a ref
 * so handlers never act on a stale closure.
 */
export function usePlaceParam(name: string): PlaceParam {
  const location = useLocation()
  const navigate = useNavigate()
  const locationRef = useRef(location)
  locationRef.current = location
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  const open = useCallback((value: string, options?: { replace?: boolean }) => {
    const loc = locationRef.current
    const params = new URLSearchParams(loc.search)
    if (params.get(name) === value) return
    params.set(name, value)
    const search = params.toString()
    const prevState = (loc.state && typeof loc.state === 'object' ? loc.state : {}) as Record<string, unknown>
    navigateRef.current(
      { pathname: loc.pathname, search: search ? `?${search}` : '' },
      options?.replace ? { replace: true, state: prevState } : { state: { ...prevState, [PLACE_PUSH_STATE]: name } },
    )
  }, [name])

  const close = useCallback(() => {
    const loc = locationRef.current
    const params = new URLSearchParams(loc.search)
    if (!params.has(name)) return
    const state = (loc.state && typeof loc.state === 'object' ? loc.state : {}) as Record<string, unknown>
    if (state[PLACE_PUSH_STATE] === name) {
      navigateRef.current(-1)
      return
    }
    params.delete(name)
    const search = params.toString()
    navigateRef.current({ pathname: loc.pathname, search: search ? `?${search}` : '' }, { replace: true, state })
  }, [name])

  return { value: new URLSearchParams(location.search).get(name), open, close }
}
