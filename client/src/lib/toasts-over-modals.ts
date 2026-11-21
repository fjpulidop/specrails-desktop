import { useEffect } from 'react'

/**
 * A Radix modal makes the rest of the page inert to the pointer and closes on
 * any press outside its panel. Toasts sit outside every panel, so without this
 * a toast over a modal could not be clicked (or its press would close the
 * modal). `globals.css` gives toasts `pointer-events: auto`; this stops a press
 * on a toast before Radix's document-level outside-press listener sees it.
 * React (listening on the portal container, `<body>`) still gets it first, so
 * sonner's own handlers (swipe, close, action buttons) keep working.
 */
export function useToastsUsableOverModals() {
  useEffect(() => {
    const keepInside = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-sonner-toaster]')) event.stopPropagation()
    }
    document.body.addEventListener('pointerdown', keepInside)
    return () => document.body.removeEventListener('pointerdown', keepInside)
  }, [])
}
