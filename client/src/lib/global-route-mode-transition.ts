export type UiSurfaceMode = 'kanban' | 'agent'
export type GlobalModalSurface = 'loops' | 'plugins'

export type GlobalRouteModeTransition =
  | { kind: 'modalize'; surface: GlobalModalSurface; backgroundPath: '/' }
  | { kind: 'route'; surface: GlobalModalSurface; path: '/loops' | '/plugins' }

export function modalSurfaceForPath(pathname: string): GlobalModalSurface | null {
  if (pathname.startsWith('/loops')) return 'loops'
  if (pathname.startsWith('/plugins')) return 'plugins'
  return null
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
    return surface ? { kind: 'modalize', surface, backgroundPath: '/' } : null
  }

  if (loopsOpen) return { kind: 'route', surface: 'loops', path: '/loops' }
  if (pluginsOpen) return { kind: 'route', surface: 'plugins', path: '/plugins' }
  return null
}
