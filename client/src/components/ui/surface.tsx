import * as React from 'react'
import {
  closeSurfaceWindow,
  listenSurfaceWindowEvents,
  nativeSurfaceEnabled,
  newSurfaceRequestId,
  openSurfaceWindow,
  type NativeSurfaceId,
  type SurfaceParams,
} from '../../lib/native-surfaces'

/*
 * One modal surface, two presentations (docs/internals/native-window-surfaces.md):
 *
 *   <Surface id="app-settings" open={open} params={{ section }} onClose={close} onResult={handle}>
 *     <SettingsDialog open={open} onClose={close} … />   ← web build, opt-out, or open failure
 *   </Surface>
 *
 * In Tauri an opted-in surface opens as an owned OS window and renders nothing
 * here; the children (the existing Radix modal) are the fallback everywhere else.
 * Props cross windows only as string `params`; anything the surface reports back
 * arrives through `onResult`, and every closure (Escape, close button, ⌘W) through
 * `onClose`.
 */

export interface NativeSurfaceOptions {
  id: NativeSurfaceId
  open: boolean
  /** Serializable window inputs (the surface window's query string). Empty values are dropped. */
  params?: Record<string, string | null | undefined>
  onClose: () => void
  /** A result the surface window reported (e.g. "open onboarding"). */
  onResult?: (result: unknown) => void
}

function cleanParams(params: NativeSurfaceOptions['params']): SurfaceParams {
  const clean: SurfaceParams = {}
  for (const [key, value] of Object.entries(params ?? {})) if (value) clean[key] = value
  return clean
}

/**
 * Opens the surface as a native window while `open` is true. Returns whether the
 * native window is presenting it; when false the caller renders its modal.
 * A failed open (an older host, a refused caller) falls back to the modal.
 */
export function useNativeSurface({ id, open, params, onClose, onResult }: NativeSurfaceOptions): boolean {
  const [enabled] = React.useState(() => nativeSurfaceEnabled(id))
  const [failed, setFailed] = React.useState(false)
  const native = enabled && !failed
  const paramsKey = JSON.stringify(cleanParams(params))
  const callbacks = React.useRef({ onClose, onResult })
  callbacks.current = { onClose, onResult }
  const openRef = React.useRef(open)
  openRef.current = open
  const live = React.useRef<{ windowLabel: string | null; requestId: string; closed: boolean } | null>(null)

  React.useEffect(() => {
    if (!native || !open) return
    let disposed = false
    let unlisten: (() => void) | null = null
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    const request = { windowLabel: null as string | null, requestId: newSurfaceRequestId(), closed: false }
    live.current = request

    void (async () => {
      try {
        unlisten = await listenSurfaceWindowEvents((event) => {
          if (event.requestId !== request.requestId || request.closed) return
          if (event.kind === 'result') callbacks.current.onResult?.(event.result)
          if (event.kind === 'closed') {
            request.closed = true
            if (opener?.isConnected) opener.focus()
            callbacks.current.onClose()
          }
        })
        if (disposed) { unlisten(); return }
        const opened = await openSurfaceWindow(id, JSON.parse(paramsKey) as SurfaceParams, request.requestId)
        // A reused window keeps its original request: follow that one instead.
        request.requestId = opened.requestId
        request.windowLabel = opened.windowLabel
      } catch (error) {
        console.warn(`[surface] ${id} could not open natively; using the in-page modal`, error)
        unlisten?.()
        unlisten = null
        if (!disposed) setFailed(true)
      }
    })()

    return () => {
      disposed = true
      unlisten?.()
      // The opener closed the surface (not the window itself): close the window.
      // An unmounted opener leaves the window open; it is independent from here on.
      if (!request.closed && request.windowLabel && live.current === request && !openRef.current) {
        void closeSurfaceWindow(request.windowLabel).catch(() => {})
      }
    }
  }, [native, open, id, paramsKey])

  return native
}

export interface SurfaceProps extends NativeSurfaceOptions {
  /** The in-page modal: rendered in the web build or when the native window is unavailable. */
  children: React.ReactNode
}

/** Declarative form of `useNativeSurface`: renders `children` only when the surface is not native. */
export function Surface({ children, ...options }: SurfaceProps) {
  const native = useNativeSurface(options)
  return native ? null : <>{children}</>
}
