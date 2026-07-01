import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import type { GripPosition } from '../../lib/modal-geometry'
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

interface ResizeGripsProps {
  handles: ResizeHandleProps[]
}

/**
 * Renders the eight resize grips produced by `useMovableResizableModal` as a
 * viewport-fixed overlay mirroring the panel edges (independent of the modal's
 * internal layout/scroll). Renders nothing when the feature is disabled.
 */
export function ResizeGrips({ handles }: ResizeGripsProps) {
  const { t } = useTranslation('common')
  if (handles.length === 0) return null
  return (
    <>
      {handles.map((handle) => (
        <div
          key={handle.position}
          data-testid={`modal-resize-${handle.position}`}
          role={handle.role}
          aria-orientation={handle['aria-orientation']}
          aria-label={t(`modal.resize.${handle.position}`)}
          tabIndex={handle.tabIndex}
          style={handle.style}
          onPointerDown={handle.onPointerDown}
          onKeyDown={handle.onKeyDown}
          className={cn(
            // Rounded, subtle highlight — a soft beveled hint on hover/focus,
            // never a harsh rectangular bar poking past the panel's rounded edge.
            'z-[51] rounded-full bg-transparent transition-colors duration-150',
            'hover:bg-accent-primary/20 focus:outline-none focus-visible:bg-accent-primary/30',
            GRIP_CURSOR[handle.position],
          )}
        />
      ))}
    </>
  )
}
