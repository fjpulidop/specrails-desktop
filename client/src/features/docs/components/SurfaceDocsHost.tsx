import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { OPEN_DOCS_EVENT, type DocsTarget, type OpenDocsDetail } from '../../../lib/docs-events'

const DocsDialog = lazy(() => import('./DocsDialog'))

/**
 * The guide inside a native surface window (Settings, a run, the live board).
 *
 * `openDocs()` asks the app shell for the guide through a window event, but a
 * surface window is its own JS context with no app shell, so nothing heard it
 * and every "Learn more" there did nothing. Surfaces never nest windows and the
 * surface floats above its opener, so the guide opens here, as an in-window
 * modal over the surface (the same Docs dialog, at the same section).
 */
export function SurfaceDocsHost() {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<(DocsTarget & { nonce: number }) | null>(null)
  const nonceRef = useRef(0)
  useEffect(() => {
    const onOpenDocs = (event: Event) => {
      const requested = (event as CustomEvent<OpenDocsDetail>).detail?.target ?? null
      setTarget(requested ? { ...requested, nonce: ++nonceRef.current } : null)
      setOpen(true)
    }
    window.addEventListener(OPEN_DOCS_EVENT, onOpenDocs)
    return () => window.removeEventListener(OPEN_DOCS_EVENT, onOpenDocs)
  }, [])
  const close = useCallback(() => { setOpen(false); setTarget(null) }, [])
  if (!open && nonceRef.current === 0) return null
  return (
    <Suspense fallback={null}>
      <DocsDialog open={open} onClose={close} target={target} showReplayTour={false} />
    </Suspense>
  )
}
