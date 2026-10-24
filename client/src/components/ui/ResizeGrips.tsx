import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { GRIP_CORNER, GRIP_EDGE, GRIP_INSET, type GripPosition } from '../../lib/modal-geometry'
import type { ResizeHandleProps } from '../../hooks/useMovableResizableModal'

/** Cursor per grip. Position/size come from the hook's fixed-overlay style. */
const GRIP_CURSOR: Record<GripPosition, string> = {
  nw: 'cursor-nwse-resize',
  n: 'cursor-ns-resize',
  ne: 'cursor-nesw-resize',
  e: 'cursor-ew-resize',
  se: 'cursor-nwse-resize',
  s: 'cursor-ns-resize',
  sw: 'cursor-nesw-resize',
  w: 'cursor-ew-resize',
}

/**
 * Panel-relative placement (absolute, fully inside the panel edge). Used when
 * the grips render INSIDE the panel element, so they share its stacking
 * context (always above its own scrim) and its focus scope (keyboard resize
 * stays reachable inside a Radix focus trap).
 */
function insetStyle(position: GripPosition): CSSProperties {
  const c = GRIP_CORNER
  const e = GRIP_EDGE
  const i = GRIP_INSET
  switch (position) {
    case 'nw': return { position: 'absolute', left: 0, top: 0, width: c, height: c }
    case 'ne': return { position: 'absolute', right: 0, top: 0, width: c, height: c }
    case 'se': return { position: 'absolute', right: 0, bottom: 0, width: c, height: c }
    case 'sw': return { position: 'absolute', left: 0, bottom: 0, width: c, height: c }
    case 'n': return { position: 'absolute', left: i, right: i, top: 0, height: e }
    case 's': return { position: 'absolute', left: i, right: i, bottom: 0, height: e }
    case 'e': return { position: 'absolute', right: 0, top: i, bottom: i, width: e }
    case 'w': return { position: 'absolute', left: 0, top: i, bottom: i, width: e }
  }
}

interface ResizeGripsProps {
  handles: ResizeHandleProps[]
  /**
   * `fixed` (default): viewport-fixed overlay mirroring the panel edges — for
   * panels that are not a transformed containing block (the floating chat).
   * `inset`: absolute, inside the panel element — the modal standard. The
   * panel must be positioned (it is: `fixed`) and clip its own overflow.
   */
  placement?: 'fixed' | 'inset'
  /** Extra classes (e.g. a z-index layer for the `fixed` placement). */
  className?: string
}

/**
 * Renders the eight resize grips produced by `useMovableResizableModal`.
 * Renders nothing when the feature is disabled.
 */
export function ResizeGrips({ handles, placement = 'fixed', className }: ResizeGripsProps) {
  const { t } = useTranslation('common')
  if (handles.length === 0) return null
  return (
    <>
      {handles.map((handle) => (
        <div
          key={handle.position}
          data-testid={`modal-resize-${handle.position}`}
          data-resize-grip=""
          role={handle.role}
          aria-orientation={handle['aria-orientation']}
          aria-label={t(`modal.resize.${handle.position}`)}
          tabIndex={handle.tabIndex}
          style={placement === 'inset' ? insetStyle(handle.position) : handle.style}
          onPointerDown={handle.onPointerDown}
          onKeyDown={handle.onKeyDown}
          className={cn(
            // Rounded, subtle highlight — a soft beveled hint on hover/focus,
            // never a harsh rectangular bar poking past the panel's rounded edge.
            placement === 'inset' ? 'z-30' : 'z-[51]',
            'rounded-full bg-transparent transition-colors duration-150',
            'hover:bg-accent-primary/20 focus:outline-none focus-visible:bg-accent-primary/30',
            GRIP_CURSOR[handle.position],
            className,
          )}
        />
      ))}
    </>
  )
}
