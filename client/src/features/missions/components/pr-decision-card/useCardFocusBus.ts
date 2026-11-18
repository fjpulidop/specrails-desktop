/**
 * Focus bus of a PR decision card: a failure marker or launch stub asks to
 * bring THIS card into view; the card scrolls, takes focus and flashes.
 */
import { useEffect, useRef, useState } from 'react'
import { FEATURE_MISSION_RAIL_CARDS } from '../../../../lib/feature-flags'
import { FOCUS_PR_CARD_EVENT, focusInConversation, focusMatchesCard, focusScrollBehavior, type FocusPrCardDetail } from '../agent-run-failure'
import type { AgentPrDecisionEnvelope } from '../../lib/agent-api'

export function useCardFocusBus(envelope: Pick<AgentPrDecisionEnvelope, 'prDeliveryId' | 'runIds'>, conversationId: string | null | undefined) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (!FEATURE_MISSION_RAIL_CARDS) return
    const onFocus = (event: Event): void => {
      const detail = (event as CustomEvent<FocusPrCardDetail>).detail
      if (!focusMatchesCard(detail, { prDeliveryId: envelope.prDeliveryId, runIds: envelope.runIds })) return
      if (conversationId && !focusInConversation(detail, conversationId)) return
      const card = cardRef.current
      // Hidden in the run strip's closed panel: the strip opens it and re-dispatches.
      if (card?.closest('[hidden]')) return
      card?.scrollIntoView?.({ behavior: focusScrollBehavior(), block: 'nearest' })
      // Keyboard focus follows the request (the region is labelled for screen readers).
      try { card?.focus({ preventScroll: true }) } catch { card?.focus() }
      setFlash(true)
      if (flashTimer) clearTimeout(flashTimer)
      flashTimer = setTimeout(() => setFlash(false), 1400)
    }
    let flashTimer: ReturnType<typeof setTimeout> | null = null
    window.addEventListener(FOCUS_PR_CARD_EVENT, onFocus)
    return () => {
      window.removeEventListener(FOCUS_PR_CARD_EVENT, onFocus)
      if (flashTimer) clearTimeout(flashTimer)
    }
  }, [envelope.prDeliveryId, envelope.runIds, conversationId])
  return { cardRef, flash }
}
