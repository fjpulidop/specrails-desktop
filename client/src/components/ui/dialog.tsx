import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useMovableResizableModal } from '../../hooks/useMovableResizableModal'
import { ResizeGrips } from './ResizeGrips'

function useMergedRef<T>(...refs: Array<React.Ref<T> | undefined>) {
  return React.useCallback((value: T | null) => {
    for (const ref of refs) {
      if (!ref) continue
      if (typeof ref === 'function') ref(value)
      else (ref as React.MutableRefObject<T | null>).current = value
    }
  }, refs) // eslint-disable-line react-hooks/exhaustive-deps
}

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const CloseButton = () => {
  const { t } = useTranslation('common')
  return (
    <DialogPrimitive.Close className="absolute right-4 top-4 z-20 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
      <X className="h-4 w-4" />
      <span className="sr-only">{t('actions.close')}</span>
    </DialogPrimitive.Close>
  )
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean
    /** Opt-in: make this modal movable (drag the panel) + resizable (corner/edge grips). */
    movableResizable?: boolean
  }
>(({ className, children, showCloseButton = true, movableResizable = false, style, ...props }, ref) => {
  // Dialog-style modals are RESIZE-ONLY: there is no obvious drag handle, so a
  // whole-panel move makes body clicks accidentally reposition the modal. The
  // user resizes from the corner/edge grips; the modal stays centered.
  const { panelRef, panelStyle, resizeHandles } = useMovableResizableModal({
    enabled: movableResizable,
    allowMove: false,
  })
  const mergedRef = useMergedRef(ref, panelRef)

  if (!movableResizable) {
    // Default path — byte-identical to the original markup.
    return (
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={ref}
          style={style}
          className={cn(
            'fixed left-[50%] top-[50%] z-50 grid w-full max-w-2xl max-h-[85vh] translate-x-[-50%] translate-y-[-50%] gap-4 border border-border/30 bg-popover p-6 shadow-xl backdrop-blur-md duration-200 overflow-y-auto data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-xl',
            className
          )}
          {...props}
        >
          {children}
          {showCloseButton && <CloseButton />}
        </DialogPrimitive.Content>
      </DialogPortal>
    )
  }

  // Movable/resizable path — same markup as the default, plus the panel ref,
  // the floating geometry style, a whole-panel drag surface, and a grip overlay
  // rendered as a portal sibling (fixed-positioned, unaffected by Content's
  // overflow/transform — so it works regardless of the modal's inner layout).
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={mergedRef}
        style={{ ...style, ...panelStyle }}
        className={cn(
          'fixed left-[50%] top-[50%] z-50 grid w-full max-w-2xl max-h-[85vh] translate-x-[-50%] translate-y-[-50%] gap-4 border border-border/30 bg-popover p-6 shadow-xl backdrop-blur-md duration-200 overflow-y-auto data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-xl',
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && <CloseButton />}
      </DialogPrimitive.Content>
      <ResizeGrips handles={resizeHandles} />
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
)
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
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
    className={cn('text-xs text-muted-foreground', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
