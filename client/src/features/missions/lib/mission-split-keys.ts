// ─── Keyboard shortcuts of the mission split layout ──────────────────────────
//   ⌥⌘] / ⌥⌘[   focus the next / previous pane (reading order)
//   ⌘⇧↵         maximize the focused pane, or restore the layout
//   ⌥⌘=         share the space evenly between all panes
//   ⌥⌘W         close the focused pane
// Windows/Linux use Ctrl+Alt for ⌥⌘ and Ctrl+Shift+Enter for ⌘⇧↵.
//
// Conflicts checked: ⌘[ / ⌘] (Back/Forward) and ⌥[ / ⌥] (run strip) never carry
// both modifiers; ⌥⌘B, ⌥⌘1–9 and ⌘1–6 use other keys; none of these is a
// DevTools chord in WebView2, Chromium or WebKit. Matching uses
// `KeyboardEvent.code`, so layouts and Option-layer characters do not change
// the binding. Off macOS, Ctrl+Alt is AltGr on many layouts, so those chords
// are ignored while typing in a text field.

export type MissionSplitCommand = 'focus-next' | 'focus-previous' | 'maximize' | 'equalize' | 'close'

/** Display strings (macOS glyphs; keyboardLabel() adapts them elsewhere). */
export const MISSION_SPLIT_KEYS = Object.freeze({
  focusNext: '⌥⌘]',
  focusPrevious: '⌥⌘[',
  maximize: '⌘⇧↵',
  equalize: '⌥⌘=',
  close: '⌥⌘W',
})

type KeyInput = Pick<KeyboardEvent, 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'code' | 'key'>

export function missionSplitCommand(event: KeyInput, mac: boolean, typing = false): MissionSplitCommand | null {
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!primary) return null
  if (event.shiftKey && !event.altKey) return event.key === 'Enter' ? 'maximize' : null
  if (!event.altKey || event.shiftKey || (!mac && typing)) return null
  switch (event.code) {
    case 'BracketRight': return 'focus-next'
    case 'BracketLeft': return 'focus-previous'
    case 'Equal': return 'equalize'
    case 'KeyW': return 'close'
    default: return null
  }
}
