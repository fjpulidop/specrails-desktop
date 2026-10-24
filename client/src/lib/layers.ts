/**
 * Named stacking layers for every overlay surface (modal standard, see
 * docs/internals/modal-standard.md). One file owns the z-index scale so a new
 * surface picks a layer by intent instead of inventing `z-[NN]`.
 *
 *   base-modal     50   ordinary dialogs (Radix `DialogContent` default)
 *   floating-chat  60   the floating agent panel (61 = its resize grips)
 *   entity-modal   65   entity surfaces: Spec detail, Job detail, compare,
 *                       agent activity log, loop/blueprint previews
 *   stacked-modal  70   anything opened from inside an entity modal or a
 *                       floating panel: Flow prompts, SMASH, nested confirms
 *   dock           75   minimized chats dock (stays clickable over modals)
 *   capture        80   browser capture / web view / native browser pane,
 *                       background-process logs (opened over capture)
 *   media          100  lightboxes (full-bleed media viewer)
 *   toast          110  sonner toasts — above every modal
 *
 * The Tailwind classes below are literal strings so the v4 scanner emits them.
 * Resize grips render inside the panel (see `ResizeGrips` with
 * `placement="inset"`), so they always paint above that panel's own scrim.
 */
export const LAYERS = {
  baseModal: 50,
  floatingChat: 60,
  entityModal: 65,
  stackedModal: 70,
  dock: 75,
  capture: 80,
  media: 100,
  toast: 110,
} as const

/** Layers a dialog surface can sit on (`DialogContent layer=…`). */
export type DialogLayer = 'base' | 'entity' | 'stacked' | 'capture' | 'media'

export const DIALOG_LAYER_Z: Record<DialogLayer, number> = {
  base: LAYERS.baseModal,
  entity: LAYERS.entityModal,
  stacked: LAYERS.stackedModal,
  capture: LAYERS.capture,
  media: LAYERS.media,
}

/** Tailwind z-index class per dialog layer (overlay and panel share it). */
export const DIALOG_LAYER_CLASS: Record<DialogLayer, string> = {
  base: 'z-50',
  entity: 'z-[65]',
  stacked: 'z-[70]',
  capture: 'z-[80]',
  media: 'z-[100]',
}

/** Tailwind classes for the non-dialog layers. */
export const LAYER_CLASS = {
  floatingChat: 'z-[60]',
  floatingChatGrips: 'z-[61]',
  dock: 'z-[75]',
  capture: 'z-[80]',
  media: 'z-[100]',
  toast: 'z-[110]',
} as const

/**
 * Default layer for a dialog rendered inside another dialog's React tree.
 * Same-layer nesting relies on portal order (the later portal paints on top);
 * a dialog opened from an entity modal must climb to `stacked` because base
 * dialogs (50) sit below entity modals (65).
 */
export function nestedDialogLayer(parent: DialogLayer | null): DialogLayer {
  if (parent === null) return 'base'
  if (parent === 'entity') return 'stacked'
  return parent
}
