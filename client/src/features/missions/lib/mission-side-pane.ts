/**
 * How a mission's workspace side pane (Jobs, Code, Analytics, Specs) fits its
 * surface, which may be one pane of a split layout. In flow it never squeezes
 * the conversation below its 360px minimum; when the surface is too narrow
 * for both (under 680px: 360 + the smallest side pane, 320), the side pane
 * overlays the conversation from the right edge, like a drawer, instead of
 * overflowing. Pure CSS container queries on the surface (`@container/surface`
 * in AgentModeSurface): no measuring, no render while a divider is dragged.
 * The Code pane sizes itself from its parent and keeps an inline
 * `max-width: 100%`, so only the narrow-surface overlay applies to it.
 */
export const SIDE_PANE_FIT = 'max-w-[calc(100cqw-360px)] @max-[680px]/surface:absolute @max-[680px]/surface:inset-y-0 @max-[680px]/surface:right-0 @max-[680px]/surface:z-30 @max-[680px]/surface:max-w-full @max-[680px]/surface:shadow-3'
