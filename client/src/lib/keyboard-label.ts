const INBOX_CHORD = '⌘⇧I'

/** Match displayed modifiers to the user's keyboard, including browser development. */
export function keyboardLabel(keys: string, platform = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  if (/Mac|iPhone|iPad/i.test(platform)) return keys
  // The inbox chord is not Ctrl+Shift+I off macOS: that opens DevTools in WebView2 and Chromium.
  if (keys === INBOX_CHORD) return 'Ctrl+Alt+I'
  return keys.replace(/⌥/g, 'Alt+').replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+').replace(/[⏎↵]/g, 'Enter')
}

/** True on Apple keyboards (⌘ shortcuts); false on Windows/Linux (Ctrl / Alt shortcuts). */
export function isMacKeyboard(platform = typeof navigator === 'undefined' ? '' : navigator.platform): boolean {
  return /Mac|iPhone|iPad/i.test(platform)
}

/**
 * The inbox chord: ⌘⇧I on macOS. Ctrl+Shift+I opens DevTools in WebView2 and Chromium
 * (development builds and the web view), so Windows/Linux use Ctrl+Alt+I instead.
 */
export function inboxShortcutLabel(platform?: string): string {
  return keyboardLabel(INBOX_CHORD, platform)
}

/** The same chord as an `aria-keyshortcuts` value. */
export function inboxAriaShortcut(platform?: string): string {
  return isMacKeyboard(platform) ? 'Meta+Shift+I' : 'Control+Alt+I'
}
