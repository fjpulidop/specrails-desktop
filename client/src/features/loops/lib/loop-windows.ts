import { isTauri } from '../../../lib/tauri-shell'

export function isLoopWindowRoute(): boolean {
  return new URLSearchParams(window.location.search).get('loopsWindow') === '1'
}

/** Open one editor per target; reopening focuses it without replacing its draft. */
export async function openLoopWindow(projectId: string | null, loopId?: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('loop_window_open', { projectId, loopId: loopId ?? null })
    return
  }
  const url = new URL('/', window.location.origin)
  url.searchParams.set('loopsWindow', '1')
  if (projectId) url.searchParams.set('projectId', projectId)
  if (loopId) url.searchParams.set('loopId', loopId)
  const name = `specrails-loops-${encodeURIComponent(JSON.stringify([projectId, loopId ?? null]))}`
  const existing = browserWindows.get(name)
  if (existing && !existing.closed) { existing.focus(); return }
  const opened = window.open(url.href, name, 'popup,width=1400,height=900,resizable=yes,scrollbars=yes')
  if (!opened) throw new Error('The loop window could not be opened. Allow pop-up windows and retry.')
  browserWindows.set(name, opened)
}
const browserWindows = new Map<string, Window>()
