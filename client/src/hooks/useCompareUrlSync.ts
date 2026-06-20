import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTicketDetailModal } from '../context/TicketDetailModalContext'
import { useTickets } from './useTickets'

/**
 * Two-way sync between split-view state and the URL query string.
 *
 *   ?compare=<ticketId>&compareSide=left|right
 *
 * - `compareSide` denotes the **origin** side (where the user's first ticket sits).
 *   The compared ticket id sits on the opposite side.
 * - On mount, restores split-view from URL when the viewport is wide enough.
 * - On state change, writes/clears the params so refresh works and the URL is shareable.
 * - Non-split modal opens never write the params (centered modal stays URL-less).
 * - Unknown ticket id ⇒ params are silently cleared.
 */
export function useCompareUrlSync() {
  const { state, openTicketDetail, enterSplit, setComparedTicket } = useTicketDetailModal()
  const { tickets } = useTickets()
  const location = useLocation()
  const navigate = useNavigate()
  const didRestoreRef = useRef(false)

  // ─── Initial restoration on first mount ───────────────────────────────────
  useEffect(() => {
    if (didRestoreRef.current) return
    if (tickets.length === 0) return // wait for tickets to load

    // Viewport too narrow → keep the params for a later (wide) restore and do
    // NOT mark restored: marking it would let the write-effect below run, see
    // inSplit=false + hadCompare=true, and permanently STRIP the params (so a
    // rotate-back-to-wide could never restore the comparison).
    const compareRawEarly = new URLSearchParams(location.search).get('compare')
    if (compareRawEarly && typeof window !== 'undefined' && window.innerWidth < 900) {
      return
    }

    didRestoreRef.current = true

    const params = new URLSearchParams(location.search)
    const compareRaw = params.get('compare')
    const sideRaw = params.get('compareSide')
    if (!compareRaw) return

    const compareId = Number.parseInt(compareRaw, 10)
    const originSide = sideRaw === 'right' ? 'right' : 'left'

    const exists = tickets.some((t) => t.id === compareId)
    if (!exists) {
      // Strip stale param
      const next = new URLSearchParams(location.search)
      next.delete('compare')
      next.delete('compareSide')
      const qs = next.toString()
      navigate({ pathname: location.pathname, search: qs ? `?${qs}` : '' }, { replace: true })
      return
    }

    // Restore: We need an "origin" ticket too. The URL alone can't tell us
    // which ticket was on the origin side — we encode the *compared* id only.
    // Convention: the origin id is implicit (last centered modal) but on a
    // cold restore we have no such memory. Fallback: open the compared ticket
    // centered (single modal). User can re-trigger split. Document this in
    // CLAUDE.md follow-up: URL persistence is best-effort across cold reloads.
    // To make the round-trip lossless we'd also need ?origin=<id>.
    // We support ?origin=<id> as an optional param for completeness:
    const originRaw = params.get('compareOrigin')
    if (originRaw) {
      const originId = Number.parseInt(originRaw, 10)
      if (tickets.some((t) => t.id === originId)) {
        openTicketDetail(originId)
        enterSplit(originSide)
        setComparedTicket(compareId, originSide === 'left' ? 'right' : 'left')
        return
      }
    }
    // Lossy fallback: just open the compared ticket centered
    openTicketDetail(compareId)
  }, [tickets, location.search, location.pathname, navigate, openTicketDetail, enterSplit, setComparedTicket])

  // ─── Write URL params on state change ─────────────────────────────────────
  useEffect(() => {
    // B21: do not touch the params until the initial restore has had its chance.
    // On a cold load the restore-effect bails while tickets are still loading
    // (length 0); without this guard, this effect would run first, see split
    // state not-yet-hydrated, and strip ?compare/?compareOrigin — so refresh
    // could never restore a comparison. The restore-effect handles clearing
    // genuinely-stale params itself.
    if (!didRestoreRef.current) return

    const params = new URLSearchParams(location.search)
    const hadCompare = params.has('compare')
    const inSplit = state.originSide !== null

    if (!inSplit) {
      if (hadCompare) {
        params.delete('compare')
        params.delete('compareSide')
        params.delete('compareOrigin')
        const qs = params.toString()
        navigate({ pathname: location.pathname, search: qs ? `?${qs}` : '' }, { replace: true })
      }
      return
    }

    // In split — encode both origin and compared ids
    const originId = state.originSide === 'left' ? state.leftId : state.rightId
    const comparedId = state.originSide === 'left' ? state.rightId : state.leftId

    if (originId == null || state.originSide == null) return // not yet hydrated; ignore

    const next = new URLSearchParams(location.search)
    next.set('compareSide', state.originSide)
    next.set('compareOrigin', String(originId))
    if (comparedId != null) next.set('compare', String(comparedId))
    else next.delete('compare')

    const qsNext = next.toString()
    const qsCurr = location.search.startsWith('?') ? location.search.slice(1) : location.search
    if (qsNext !== qsCurr) {
      navigate({ pathname: location.pathname, search: qsNext ? `?${qsNext}` : '' }, { replace: true })
    }
  }, [state, location.search, location.pathname, navigate])
}
