import type { Terminal } from '@xterm/xterm'
import { isTauri } from './tauri-shell'

export async function saveScrollbackToFile(term: Terminal, suggestedName = 'terminal-scrollback.txt'): Promise<void> {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (line) lines.push(line.translateToString(true))
  }
  const blob = lines.join('\n')

  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    // The host owns the save dialog and writes only the user-selected file. No
    // unrestricted filesystem capability is exposed to page JavaScript.
    await invoke('desktop_save_text', { suggestedName, text: blob })
    return
  }

  // Browser fallback: trigger an anchor download.
  try {
    const file = new Blob([blob], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = suggestedName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch { /* ignore */ }
}
