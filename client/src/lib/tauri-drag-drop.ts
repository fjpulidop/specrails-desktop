import { toast } from 'sonner'
import i18n from './i18n'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from './tauri-shell'
import { quotePathList, windowsShellHint } from './shell-quote'

export interface DragDropController {
  dispose: () => void
}

interface ActiveDropTarget {
  shell?: string | null
  viewportEl: HTMLElement
  writeText: (text: string) => boolean
}

/**
 * Register a Tauri webview drag-drop listener. On drop, hit-test the drop
 * coordinates against the active viewport's bounding rect; if inside, pass the
 * shell-quoted paths to the active terminal's PTY writer. Outside Tauri, this
 * function is a silent no-op.
 *
 * `getActive` returns the active session's drop target or null when no session
 * is active.
 */
export async function registerTauriDragDrop(
  getActive: () => ActiveDropTarget | null,
): Promise<DragDropController> {
  if (!isTauri()) return { dispose: () => {} }
  const unlisteners: Array<() => void> = []
  try {
    let lastDropKey = ''
    let lastDropAt = 0
    const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || '')

    const cb = (ev: { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } }) => {
      const payload = ev.payload
      if (!payload || payload.type !== 'drop') return
      const paths = payload.paths
      if (!paths || paths.length === 0) return
      const pos = payload.position
      if (!pos) return
      const dropKey = `${paths.join('\0')}@${pos.x},${pos.y}`
      const now = Date.now()
      if (dropKey === lastDropKey && now - lastDropAt < 250) return
      lastDropKey = dropKey
      lastDropAt = now

      const active = getActive()
      if (!active) return
      const rect = active.viewportEl.getBoundingClientRect()
      if (!isDropPositionInsideRect(pos, rect, window.devicePixelRatio || 1)) return
      try { active.writeText(quotePathList(paths, isWindows, windowsShellHint(active.shell))) }
      catch { toast.error(i18n.t('terminal:errors.pathPasteUnsafe')) }
    }

    const webview = (() => { try { return getCurrentWebview() } catch { return null } })()
    const onWebviewDragDropEvent = getDragDropListener(webview)
    if (onWebviewDragDropEvent) unlisteners.push(await onWebviewDragDropEvent(cb))

    const appWindow = (() => { try { return getCurrentWindow() } catch { return null } })()
    const onWindowDragDropEvent = getDragDropListener(appWindow)
    if (onWindowDragDropEvent) unlisteners.push(await onWindowDragDropEvent(cb))

    if (unlisteners.length === 0) return { dispose: () => {} }
    return { dispose: () => { for (const unlisten of unlisteners) { try { unlisten() } catch { /* ignore */ } } } }
  } catch {
    for (const unlisten of unlisteners) { try { unlisten() } catch { /* already gone */ } }
    return { dispose: () => {} }
  }
}

function getDragDropListener(target: unknown):
  | ((cb: (ev: { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } }) => void) => Promise<() => void>)
  | null {
  const listener = (target as {
    onDragDropEvent?: (cb: (ev: { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } }) => void) => Promise<() => void>
  } | null)?.onDragDropEvent
  return typeof listener === 'function' ? listener.bind(target) : null
}

export function isDropPositionInsideRect(
  pos: { x: number; y: number },
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  scaleFactor: number,
): boolean {
  const factor = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
  return pointInsideRect(pos.x / factor, pos.y / factor, rect)
}

function pointInsideRect(
  x: number,
  y: number,
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}
