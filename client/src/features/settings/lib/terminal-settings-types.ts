/**
 * Mirror of server/modules/terminals/runtime/terminal-settings.ts shape. Kept duplicated (rather than
 * imported) because the client can't reach into server/ — server is CommonJS,
 * client is ESM, separate tsconfig.
 */
export type TerminalRenderMode = 'auto' | 'canvas' | 'webgl'

export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  renderMode: TerminalRenderMode
  copyOnSelect: boolean
  shellIntegrationEnabled: boolean
  notifyOnCompletion: boolean
  imageRendering: boolean
  longCommandThresholdMs: number
  browserShortcutUrl: string
  quickScript: string
}

export type PartialTerminalSettings = Partial<TerminalSettings>

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: "'DM Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace",
  fontSize: 12,
  renderMode: 'auto',
  copyOnSelect: false,
  shellIntegrationEnabled: true,
  notifyOnCompletion: true,
  imageRendering: true,
  longCommandThresholdMs: 60_000,
  browserShortcutUrl: 'https://specrails.dev',
  quickScript: 'echo "Hello World!"',
}

export const TERMINAL_FONT_SIZE_MIN = 8
export const TERMINAL_FONT_SIZE_MAX = 32

export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_SETTINGS.fontSize
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(n)))
}
