import { modalDialogStyle, modalOverlayStyle } from '../../lib/modal-safe-area'
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { DIALOG_LAYER_CLASS, nestedDialogLayer, type DialogLayer } from '../../lib/layers'
import { useMovableResizableModal } from '../../hooks/useMovableResizableModal'
import { ResizeGrips } from './ResizeGrips'

/*
 * Modal standard (docs/internals/modal-standard.md)
 * ─────────────────────────────────────────────────
 * Every modal surface is a Radix dialog: focus trap, initial focus, focus
 * return, Escape stacking, aria wiring and `hideOthers` come for free.
 *
 *   <Dialog open onOpenChange>
 *     <DialogContent size="form" layer?>      ← one of five sizes, one layer
 *       <DialogHeader icon? actions?>         ← sticky; owns the close button
 *         <DialogTitle/> <DialogDescription/>
 *       </DialogHeader>
 *       <DialogBody>…</DialogBody>            ← the only scrolling region
 *       <DialogFooter start?>                 ← sticky; Cancel (ghost) → Primary
 *     </DialogContent>
 *   </Dialog>
 */

function useMergedRef<T>(...refs: Array<React.Ref<T> | undefined>) {
  return React.useCallback((value: T | null) => {
    for (const ref of refs) {
      if (!ref) continue
      if (typeof ref === 'function') ref(value)
      else (ref as React.MutableRefObject<T | null>).current = value
    }
  }, refs) // eslint-disable-line react-hooks/exhaustive-deps
}

export type DialogSize = 'confirm' | 'form' | 'wide' | 'workspace' | 'fullscreen'

/** Width/height per size token. Below 640px every size fills the window minus a gutter. */
export const DIALOG_SIZE_CLASS: Record<DialogSize, string> = {
  confirm: 'w-[calc(100%-32px)] max-w-md',
  form: 'w-[calc(100%-32px)] max-w-lg',
  wide: 'w-[calc(100%-32px)] max-w-2xl',
  workspace: 'w-[92vw] max-w-5xl h-[82vh] max-sm:w-[calc(100vw-16px)] max-sm:h-[calc(100dvh-16px)]',
  fullscreen: 'w-[96vw] max-w-none h-[92vh] max-sm:w-[calc(100vw-16px)] max-sm:h-[calc(100dvh-16px)]',
}

/** Shared panel chrome (surface, border, radius, shadow, entrance motion). */
export const DIALOG_PANEL_CLASS =
  'modal-panel fixed left-[50%] top-[50%] flex flex-col overflow-hidden translate-x-[-50%] translate-y-[-50%] border border-border/30 bg-popover text-popover-foreground shadow-3 outline-none sm:rounded-panel'

/** Shared scrim (one token per theme, see `--color-scrim` in globals.css). */
export const DIALOG_SCRIM_CLASS = 'modal-scrim fixed inset-0 bg-scrim backdrop-blur-sm'

interface DialogChrome {
  layer: DialogLayer
  showCloseButton: boolean
  /** A `DialogHeader` claims the close button so it renders in the header row. */
  claimHeader: () => () => void
}

const DialogChromeContext = React.createContext<DialogChrome | null>(null)

/** The current dialog layer (null outside any dialog). */
export function useDialogLayer(): DialogLayer | null {
  return React.useContext(DialogChromeContext)?.layer ?? null
}

const noopClaim = () => () => {}

/**
 * Publishes a layer to nested dialogs for surfaces built on the raw Radix
 * primitives (e.g. full-screen shells), so a dialog opened inside them climbs
 * above their layer instead of hiding behind it.
 */
export function DialogLayerProvider({ layer, children }: { layer: DialogLayer; children: React.ReactNode }) {
  const value = React.useMemo<DialogChrome>(() => ({ layer, showCloseButton: false, claimHeader: noopClaim }), [layer])
  return <DialogChromeContext.Provider value={value}>{children}</DialogChromeContext.Provider>
}

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> & { layer?: DialogLayer }
>(({ className, layer = 'base', ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    style={modalOverlayStyle()}
    className={cn(DIALOG_SCRIM_CLASS, DIALOG_LAYER_CLASS[layer], className)}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

/** 28×28 close affordance with a 16px icon. Rendered in the header row. */
const DialogCloseButton = React.forwardRef<
  HTMLButtonElement,
  { className?: string; 'data-testid'?: string; onClick?: React.MouseEventHandler<HTMLButtonElement> }
>(({ className, ...props }, ref) => {
  const { t } = useTranslation('common')
  return (
    <DialogPrimitive.Close
      ref={ref}
      className={cn(
        'grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none',
        className,
      )}
      aria-label={t('actions.close')}
      {...props}
    >
      <X className="h-4 w-4" aria-hidden />
    </DialogPrimitive.Close>
  )
})
DialogCloseButton.displayName = 'DialogCloseButton'

/** Stable identity for an element so a remounted trigger can be found again. */
function elementIdentity(el: HTMLElement): string | null {
  const esc = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/"/g, '\\"'))
  if (el.id) return `#${esc(el.id)}`
  const testId = el.getAttribute('data-testid')
  if (testId) return `[data-testid="${esc(testId)}"]`
  const label = el.getAttribute('aria-label')
  if (label) return `${el.tagName.toLowerCase()}[aria-label="${esc(label)}"]`
  return null
}

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  /** Size token (default `wide`). No arbitrary `max-w-*` at call sites. */
  size?: DialogSize
  /**
   * Stacking layer (default: `base`, or derived from the parent dialog — a
   * dialog opened inside an entity modal climbs to `stacked`).
   */
  layer?: DialogLayer
  showCloseButton?: boolean
  /** Extra classes for the scrim (e.g. the media scrim). */
  overlayClassName?: string
  /**
   * Resizable from corner/edge grips. Honoured only for the `workspace` size —
   * confirms, forms and previews keep a fixed, centered geometry.
   */
  movableResizable?: boolean
  /** localStorage key that persists the resized geometry per surface. */
  persistKey?: string
}

const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  (
    {
      className,
      overlayClassName,
      children,
      size = 'wide',
      layer: layerProp,
      showCloseButton = true,
      movableResizable = false,
      persistKey,
      style,
      onCloseAutoFocus,
      ...props
    },
    ref,
  ) => {
    const parent = React.useContext(DialogChromeContext)
    const layer = layerProp ?? nestedDialogLayer(parent?.layer ?? null)
    const resizable = movableResizable && size === 'workspace'
    // Dialog-style modals are RESIZE-ONLY: a whole-panel move makes body
    // clicks accidentally reposition the modal. The modal stays centered.
    const { panelRef, panelStyle, resizeHandles, guardBackdrop } = useMovableResizableModal({
      enabled: resizable,
      allowMove: false,
      persistKey,
    })

    // Focus return: a modal Radix dialog only refocuses its `DialogTrigger`;
    // controlled dialogs (opened from a sidebar button, a shortcut, a menu)
    // drop focus to <body>. Remember what was focused at open — and its
    // identity, because sidebar triggers re-render/remount while the modal is
    // open — and refocus it (or its live replacement) on close.
    const returnRef = React.useRef<{ el: HTMLElement; identity: string | null } | null>(null)
    const captureTrigger = React.useCallback((node: HTMLDivElement | null) => {
      if (!node) return
      const active = typeof document !== 'undefined' ? document.activeElement : null
      if (active instanceof HTMLElement && active !== document.body && !node.contains(active)) {
        returnRef.current = { el: active, identity: elementIdentity(active) }
      }
    }, [])
    const mergedRef = useMergedRef(ref, panelRef as React.Ref<HTMLDivElement>, captureTrigger)

    const handleCloseAutoFocus = React.useCallback(
      (event: Event) => {
        onCloseAutoFocus?.(event)
        const target = returnRef.current
        returnRef.current = null
        if (event.defaultPrevented || !target) return
        const next = target.el.isConnected
          ? target.el
          : target.identity
            ? document.querySelector<HTMLElement>(target.identity)
            : null
        if (next) {
          event.preventDefault()
          next.focus()
        }
      },
      [onCloseAutoFocus],
    )

    const [headerCount, setHeaderCount] = React.useState(0)
    const claimHeader = React.useCallback(() => {
      setHeaderCount((n) => n + 1)
      return () => setHeaderCount((n) => n - 1)
    }, [])
    const chrome = React.useMemo<DialogChrome>(
      () => ({ layer, showCloseButton, claimHeader }),
      [layer, showCloseButton, claimHeader],
    )

    const maxDvh = size === 'fullscreen' ? 92 : size === 'workspace' ? 88 : 85
    const { onPointerDownOutside, ...rest } = props

    return (
      <DialogPortal>
        <DialogOverlay layer={layer} className={overlayClassName} />
        <DialogChromeContext.Provider value={chrome}>
          <DialogPrimitive.Content
            ref={mergedRef}
            data-dialog-size={size}
            data-dialog-layer={layer}
            style={{ ...style, ...modalDialogStyle(maxDvh), ...panelStyle }}
            className={cn(DIALOG_PANEL_CLASS, DIALOG_LAYER_CLASS[layer], DIALOG_SIZE_CLASS[size], className)}
            onCloseAutoFocus={handleCloseAutoFocus}
            // Ignore the outside-press that ends a resize drag.
            onPointerDownOutside={resizable ? guardBackdrop((e: Parameters<NonNullable<typeof onPointerDownOutside>>[0]) => onPointerDownOutside?.(e)) : onPointerDownOutside}
            {...rest}
          >
            {children}
            {showCloseButton && headerCount === 0 && (
              <DialogCloseButton className="absolute right-3 top-3 z-20" />
            )}
            {resizable && <ResizeGrips handles={resizeHandles} placement="inset" />}
          </DialogPrimitive.Content>
        </DialogChromeContext.Provider>
      </DialogPortal>
    )
  },
)
DialogContent.displayName = DialogPrimitive.Content.displayName

interface DialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Optional 16px icon, rendered in the accent color before the title. */
  icon?: React.ReactNode
  /** Header actions, right-aligned before the close button. */
  actions?: React.ReactNode
}

/** Sticky header row: icon · title/description · actions · close. */
const DialogHeader = ({ className, icon, actions, children, ...props }: DialogHeaderProps) => {
  const chrome = React.useContext(DialogChromeContext)
  const claimHeader = chrome?.claimHeader
  React.useLayoutEffect(() => claimHeader?.(), [claimHeader])
  return (
    <div
      data-dialog-header=""
      className={cn('flex shrink-0 items-start gap-3 border-b border-border/40 px-5 py-4 text-left', className)}
      {...props}
    >
      {icon ? <span className="mt-0.5 shrink-0 text-accent-primary [&>svg]:h-4 [&>svg]:w-4" aria-hidden>{icon}</span> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      {chrome?.showCloseButton ? <DialogCloseButton className="-mr-1.5 -mt-1" /> : null}
    </div>
  )
}
DialogHeader.displayName = 'DialogHeader'

/** The only scrolling region of a dialog. */
const DialogBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-dialog-body="" className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', className)} {...props} />
  ),
)
DialogBody.displayName = 'DialogBody'

interface DialogFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Left-aligned secondary info or a destructive action (e.g. Delete, cost estimate). */
  start?: React.ReactNode
}

/** Sticky footer: optional start slot, then Cancel (ghost) → Primary on the right. */
const DialogFooter = ({ className, start, children, ...props }: DialogFooterProps) => (
  <div
    data-dialog-footer=""
    className={cn(
      'flex shrink-0 flex-col-reverse gap-2 border-t border-border/40 px-5 py-3 sm:flex-row sm:items-center sm:justify-end',
      className,
    )}
    {...props}
  >
    {start ? <div className="flex min-w-0 items-center gap-2 sm:mr-auto">{start}</div> : null}
    {children}
  </div>
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-base font-semibold leading-snug tracking-tight text-foreground', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-body leading-relaxed text-muted-foreground', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogCloseButton,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
