/**
 * Dock (macOS) / launcher (Linux) badge of the desktop app: the number of
 * inbox items the person has not seen. Only a change reaches the host
 * (`desktop_set_badge`, main window only; Windows has no count badge and the
 * host ignores it). Outside the desktop app this is a no-op.
 */
import { isTauri } from '../tauri-shell'

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>

async function tauriInvoke(command: string, args: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

export interface DockBadge {
  /** `null` or 0 clears the badge. */
  set(count: number | null): void
}

export function createDockBadge(invoke: Invoke = tauriInvoke, available: () => boolean = isTauri): DockBadge {
  // undefined = never sent: the first value always reaches the host (it clears a badge a crash may have left).
  let last: number | null | undefined
  return {
    set(count) {
      if (!available()) return
      const value = count && count > 0 ? Math.min(Math.floor(count), 9_999) : null
      if (value === last) return
      last = value
      invoke('desktop_set_badge', { count: value }).catch(() => {
        // Let the next change retry instead of believing the host has it.
        if (last === value) last = undefined
      })
    },
  }
}
