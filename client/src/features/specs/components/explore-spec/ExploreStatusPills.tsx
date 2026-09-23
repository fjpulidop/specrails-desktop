import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

/**
 * Status pill area shown for Explore turns from user-submit through to the
 * first streamed text delta. Drives the perceived "electrizante" UX while
 * the underlying backend is rebuilding its first token.
 *
 * Stage sequence (each pill is visible for at least MIN_DISPLAY_MS):
 *   1. Connecting…   — pre-WS / pre-system event
 *   2. Thinking…     — after the first non-text WS frame is observed
 *   3. Reading code… — when a `tool_use` event is observed on this turn
 *
 * The pill area unmounts as soon as `hasText` is true (first streamed text
 * delta arrived). The component is fully self-contained — parents only feed
 * in coarse state flags. See change accelerate-spec-chat-first-token D8.
 */

export const PREMIUM_UX_ENABLED =
  ((typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_FEATURE_EXPLORE_PREMIUM_UX) ?? 'true') !== 'false'

const MIN_DISPLAY_MS = 150

export type ExploreStage = 'connecting' | 'thinking' | 'tool' | 'streaming'

interface ExploreStatusPillsProps {
  /** True from user-submit until first text delta arrives (or chat_error). */
  active: boolean
  /** True once a `system` (or any non-text) event has been observed. */
  hasSystemEvent: boolean
  /** True once a tool_use event has been observed in the current turn. */
  hasToolUse: boolean
  /** True once the first text delta has been observed. Triggers unmount. */
  hasText: boolean
  /** Optional test seam — overrides MIN_DISPLAY_MS. */
  minDisplayMs?: number
}

const STAGE_LABEL_KEY: Record<Exclude<ExploreStage, 'streaming'>, string> = {
  connecting: 'statusPills.connecting',
  thinking: 'statusPills.thinking',
  tool: 'statusPills.tool',
}

export function ExploreStatusPills({
  active,
  hasSystemEvent,
  hasToolUse,
  hasText,
  minDisplayMs = MIN_DISPLAY_MS,
}: ExploreStatusPillsProps) {
  const { t } = useTranslation('explore')
  const [displayedStage, setDisplayedStage] = useState<ExploreStage>('connecting')
  const lastChangeRef = useRef<number>(Date.now())
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Compute the target stage from inbound flags.
  const target: ExploreStage = hasText
    ? 'streaming'
    : hasToolUse
      ? 'tool'
      : hasSystemEvent
        ? 'thinking'
        : 'connecting'

  useEffect(() => {
    if (target === displayedStage) return
    const since = Date.now() - lastChangeRef.current
    const wait = Math.max(0, minDisplayMs - since)
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    pendingTimerRef.current = setTimeout(() => {
      setDisplayedStage(target)
      lastChangeRef.current = Date.now()
      pendingTimerRef.current = null
    }, wait)
    return () => {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    }
  }, [target, displayedStage, minDisplayMs])

  if (!PREMIUM_UX_ENABLED) return null
  if (!active) return null
  if (displayedStage === 'streaming') return null

  const label = t(STAGE_LABEL_KEY[displayedStage])
  return (
    <div
      className="inline-flex items-center gap-2 rounded-full bg-accent-info/10 text-accent-info px-3 py-1 text-[11px] font-medium"
      role="status"
      aria-live="polite"
      data-testid="explore-status-pill"
      data-stage={displayedStage}
    >
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}
