export type UiSurfaceMode = 'kanban' | 'agent'
export type GlobalModalSurface = 'loops' | 'plugins' | 'review'

export type GlobalRouteModeTransition =
  | { kind: 'modalize'; surface: GlobalModalSurface; backgroundPath: '/'; loopBuilderId?: string; reviewDeliveryId?: string }
  | { kind: 'route'; surface: GlobalModalSurface; path: string }

export function modalSurfaceForPath(pathname: string): GlobalModalSurface | null {
  if (pathname.startsWith('/loops')) return 'loops'
  if (pathname.startsWith('/plugins')) return 'plugins'
  // The review packet is a project ROUTE in Board mode; Mission mode has no
  // routed dashboard, so it opens as a modal over the mission instead of
  // navigating to a URL nothing renders (Review "did nothing").
  if (reviewDeliveryIdForPath(pathname)) return 'review'
  return null
}

/** `/review/:prDeliveryId` → the delivery id, else null. */
export function reviewDeliveryIdForPath(pathname: string): string | null {
  const match = /^\/review\/([^/]+)\/?$/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : null
}

/** `/loops/:id/edit` → the loop id, else null. In Mission mode the builder has
 *  no route home, so the modalize transition carries the id and the loops
 *  dialog swaps its body to the embedded builder instead of the library. */
export function loopBuilderIdForPath(pathname: string): string | null {
  const match = /^\/loops\/([^/]+)\/edit\/?$/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : null
}

export function getGlobalRouteModeTransition({
  uiMode,
  pathname,
  loopsOpen,
  pluginsOpen,
  reviewOpen = null,
}: {
  uiMode: UiSurfaceMode
  pathname: string
  loopsOpen: boolean
  pluginsOpen: boolean
  /** The review packet open as a Mission modal (its delivery id), else null. */
  reviewOpen?: string | null
}): GlobalRouteModeTransition | null {
  if (uiMode === 'agent') {
    const surface = modalSurfaceForPath(pathname)
    if (!surface) return null
    if (surface === 'review') {
      return { kind: 'modalize', surface, backgroundPath: '/', reviewDeliveryId: reviewDeliveryIdForPath(pathname) ?? undefined }
    }
    const loopBuilderId = surface === 'loops' ? loopBuilderIdForPath(pathname) : null
    return loopBuilderId
      ? { kind: 'modalize', surface, backgroundPath: '/', loopBuilderId }
      : { kind: 'modalize', surface, backgroundPath: '/' }
  }

  if (loopsOpen) return { kind: 'route', surface: 'loops', path: '/loops' }
  if (pluginsOpen) return { kind: 'route', surface: 'plugins', path: '/plugins' }
  if (reviewOpen) return { kind: 'route', surface: 'review', path: `/review/${encodeURIComponent(reviewOpen)}` }
  return null
}
