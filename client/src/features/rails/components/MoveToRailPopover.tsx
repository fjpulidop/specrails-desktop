import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRightCircle, Circle, Play } from 'lucide-react'
import type { RailState } from './RailsBoard'

interface MoveToRailPopoverProps {
  rails: RailState[]
  onMoveToRail: (railId: string) => void
  /** Triggered when the popover is dismissed by an outside click / Esc / selection. */
  onClose: () => void
  /** Absolute screen position to anchor the popover near (e.g. button bounding-rect). */
  anchorRect: DOMRect
}

const POPOVER_WIDTH = 224 // w-56 in tailwind
const GUTTER = 8
const VERTICAL_GAP = 8

/**
 * Compact popover listing the project's rails. Anchored directly below the
 * trigger (centred horizontally on the anchor) with a small connecting
 * caret. Falls back to a clamped position when the centred placement would
 * overflow the viewport.
 *
 * Status dot mirrors each rail's current state (idle / running) so the user
 * doesn't push work into a busy rail.
 */
export function MoveToRailPopover({ rails, onMoveToRail, onClose, anchorRect }: MoveToRailPopoverProps) {
  const { t } = useTranslation('tickets')
  const popoverRef = useRef<HTMLDivElement>(null)
  const [entered, setEntered] = useState(false)

  // Trigger the fade-in/translate-in on next paint so the initial state can
  // be applied to the DOM before transitioning.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (!popoverRef.current) return
      if (popoverRef.current.contains(e.target as Node)) return
      onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const { top, left, caretLeft } = useMemo(() => {
    // Preferred placement: centre the popover horizontally on the anchor so
    // the connecting caret sits right under the trigger's centre.
    const anchorCentreX = anchorRect.left + anchorRect.width / 2
    const idealLeft = anchorCentreX - POPOVER_WIDTH / 2
    const maxLeft = window.innerWidth - POPOVER_WIDTH - GUTTER
    const clampedLeft = Math.max(GUTTER, Math.min(maxLeft, idealLeft))
    // Caret aligns with the trigger's actual centre regardless of clamping.
    const caretXAbs = anchorCentreX - clampedLeft
    const caret = Math.max(12, Math.min(POPOVER_WIDTH - 12, caretXAbs))
    return {
      top: anchorRect.bottom + VERTICAL_GAP,
      left: clampedLeft,
      caretLeft: caret,
    }
  }, [anchorRect])

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={t('rail.popoverTitle')}
      data-testid="move-to-rail-popover"
      style={{
        top,
        left,
        width: POPOVER_WIDTH,
        opacity: entered ? 1 : 0,
        transform: entered ? 'translateY(0) scale(1)' : 'translateY(-4px) scale(0.97)',
        transformOrigin: `${caretLeft}px top`,
        transition: 'opacity 140ms ease-out, transform 160ms cubic-bezier(0.2, 0.9, 0.3, 1)',
      }}
      className="fixed z-50 rounded-xl border border-border/60 bg-card/95 backdrop-blur shadow-xl shadow-black/40 p-1"
    >
      {/* Connecting caret — a small rotated square poking up toward the trigger. */}
      <div
        aria-hidden
        className="absolute w-2 h-2 rotate-45 bg-card/95 border-l border-t border-border/60"
        style={{ top: -5, left: caretLeft - 4 }}
      />

      <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium">
        {t('rail.popoverTitle')}
      </div>
      {rails.length === 0 ? (
        <div className="px-2 py-2 text-xs text-muted-foreground">{t('rail.noRails')}</div>
      ) : (
        <ul className="flex flex-col">
          {rails.map((rail) => {
            const running = rail.status === 'running'
            return (
              <li key={rail.id}>
                <button
                  type="button"
                  onClick={() => { onMoveToRail(rail.id); onClose() }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm hover:bg-accent-info/10 hover:text-accent-info transition-colors"
                >
                  {running ? (
                    <Play className="w-3 h-3 text-accent-success animate-pulse shrink-0" aria-hidden />
                  ) : (
                    <Circle className="w-3 h-3 text-muted-foreground/60 shrink-0" aria-hidden />
                  )}
                  <span className="flex-1 truncate">{rail.label}</span>
                  <ArrowRightCircle className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
