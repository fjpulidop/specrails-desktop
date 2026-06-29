/**
 * Minimum viewport width (px) at which floating modal move/resize and the
 * ticket split-view comparison are enabled. Below this width modals stay
 * centered and the split gesture is disabled — small viewports (and the
 * mobile gateway) get the simple, non-floating behavior.
 *
 * Single source of truth: `TicketDetailModalContext`, `TicketDetailModal`,
 * `useCompareUrlSync`, and `useMovableResizableModal` all reference this.
 */
export const MODAL_FLOAT_VIEWPORT_MIN = 900
