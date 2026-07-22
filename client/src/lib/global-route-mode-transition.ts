export type UiSurfaceMode = 'kanban' | 'agent'
export type GlobalModalSurface = 'loops' | 'plugins'

export type GlobalRouteModeTransition =
  | { kind: 'modalize'; surface: GlobalModalSurface; backgroundPath: '/'; loopBuilderId?: string }
  | { kind: 'route'; surface: GlobalModalSurface; path: '/loops' | '/plugins' }

export function modalSurfaceForPath(pathname: string): GlobalModalSurface | null {
  if (pathname.startsWith('/loops')) return 'loops'
  if (pathname.startsWith('/plugins')) return 'plugins'
  return null
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
}: {
  uiMode: UiSurfaceMode
  pathname: string
  loopsOpen: boolean
  pluginsOpen: boolean
}): GlobalRouteModeTransition | null {
  if (uiMode === 'agent') {
    const surface = modalSurfaceForPath(pathname)
    if (!surface) return null
    const loopBuilderId = surface === 'loops' ? loopBuilderIdForPath(pathname) : null
    return loopBuilderId
      ? { kind: 'modalize', surface, backgroundPath: '/', loopBuilderId }
      : { kind: 'modalize', surface, backgroundPath: '/' }
  }

  if (loopsOpen) return { kind: 'route', surface: 'loops', path: '/loops' }
  if (pluginsOpen) return { kind: 'route', surface: 'plugins', path: '/plugins' }
  return null
}
