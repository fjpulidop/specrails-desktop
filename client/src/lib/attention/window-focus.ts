/**
 * Where the person's keyboard focus is. In the desktop app several native
 * windows share one app (main, detached missions, settings…), and the main
 * webview's `document.hasFocus()` is false while another app window is in
 * front, so the host is asked (`desktop_focus_state`, main window only).
 */
import { isTauri } from '../tauri-shell'

export const MAIN_WINDOW_LABEL = 'main'

export interface WindowFocus {
  /** Some window of this app has the keyboard focus. */
  appFocused: boolean
  /** The label of that window (`main` for the main window and for a browser tab), else null. */
  label: string | null
}

function documentFocus(): WindowFocus {
  const focused = typeof document !== 'undefined' && document.hasFocus()
  return { appFocused: focused, label: focused ? MAIN_WINDOW_LABEL : null }
}

export async function readWindowFocus(): Promise<WindowFocus> {
  if (!isTauri()) return documentFocus()
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const label = await invoke<string | null>('desktop_focus_state')
    return { appFocused: typeof label === 'string', label: typeof label === 'string' ? label : null }
  } catch {
    return documentFocus()
  }
}

export function isMainFocused(focus: WindowFocus): boolean {
  return focus.label === MAIN_WINDOW_LABEL
}
