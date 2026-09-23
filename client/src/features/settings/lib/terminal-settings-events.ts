export const TERMINAL_SETTINGS_UPDATED_EVENT = 'specrails:terminal-settings-updated'

export interface TerminalSettingsUpdatedEventDetail {
  mode: 'desktop' | 'project'
  projectId: string | null
}

export function dispatchTerminalSettingsUpdated(detail: TerminalSettingsUpdatedEventDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(TERMINAL_SETTINGS_UPDATED_EVENT, { detail }))
}
