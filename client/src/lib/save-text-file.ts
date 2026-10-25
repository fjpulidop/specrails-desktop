import { isTauri } from './tauri-shell'

export type SaveTextResult = 'saved' | 'cancelled' | 'failed'

/**
 * Save text as a file the person chooses. In the desktop shell the host owns the
 * save dialog and writes only the selected file (no filesystem capability is
 * exposed to page JavaScript); in a browser it falls back to an anchor download.
 * A dismissed save dialog is `cancelled`, not a failure.
 */
export async function saveTextFile(suggestedName: string, text: string, mimeType = 'text/plain;charset=utf-8'): Promise<SaveTextResult> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const written = await invoke<boolean>('desktop_save_text', { suggestedName, text })
      return written === false ? 'cancelled' : 'saved'
    } catch {
      return 'failed'
    }
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mimeType }))
    const a = document.createElement('a')
    a.href = url
    a.download = suggestedName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    return 'saved'
  } catch {
    return 'failed'
  }
}
