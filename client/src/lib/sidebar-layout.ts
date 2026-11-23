/**
 * Which docked sidebars the main window mounts for a given mode + route. The
 * App shell and the title bar's sidebar buttons share this so a button never
 * toggles a sidebar that is not on screen.
 */

function isProjectSettingsRoute(pathname: string): boolean {
  return pathname === '/settings' || pathname === '/settings/'
}

/** A route that takes over the centre. Docs is global
 *  in both modes; Loops and Plugins are board pages in Kanban mode but modal
 *  surfaces over the current mission in Agent Mode. */
export function isGlobalRoute(pathname: string, uiMode: string): boolean {
  if (pathname.startsWith('/docs')) return true
  // Project settings are a route; in Mission mode it replaces the mission surface (no modal twin).
  if (uiMode === 'agent' && isProjectSettingsRoute(pathname)) return true
  return uiMode !== 'agent' && (pathname.startsWith('/loops') || pathname.startsWith('/plugins'))
}

/** Project Settings keeps the current mode's sidebar while replacing the centre.
 *  Other routes that take over the centre hide the sidebar. */
export function hasRightSidebar(opts: { uiMode: string; pathname: string; hasActiveProject: boolean }): boolean {
  if (isProjectSettingsRoute(opts.pathname)) return opts.hasActiveProject
  if (isGlobalRoute(opts.pathname, opts.uiMode)) return false
  return opts.uiMode === 'agent' || opts.hasActiveProject
}
