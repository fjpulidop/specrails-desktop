/**
 * Which docked sidebars the main window mounts for a given mode + route. The
 * App shell and the title bar's sidebar buttons share this so a button never
 * toggles a sidebar that is not on screen.
 */

/** A global (cross-project) route that takes over the centre. Docs is global
 *  in both modes; Loops and Plugins are board pages in Kanban mode but modal
 *  surfaces over the current mission in Agent Mode. */
export function isGlobalRoute(pathname: string, uiMode: string): boolean {
  if (pathname.startsWith('/docs')) return true
  return uiMode !== 'agent' && (pathname.startsWith('/loops') || pathname.startsWith('/plugins'))
}

/** Agent Mode shows the "On workspace" rail; Kanban shows the project sidebar
 *  only with an active project. Neither shows on a global route. */
export function hasRightSidebar(opts: { uiMode: string; pathname: string; hasActiveProject: boolean }): boolean {
  if (isGlobalRoute(opts.pathname, opts.uiMode)) return false
  return opts.uiMode === 'agent' || opts.hasActiveProject
}
