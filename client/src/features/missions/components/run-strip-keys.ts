// ─── Keyboard shortcuts of the mission's run strip ───────────────────────────
// Conversation-scoped: a shortcut acts on the run strip of ONE mission, the
// one the person is in. With several missions visible (split views) that is
// the surface containing the focused element, else the most recently focused
// one, else the most recently mounted.
//
//   ⌥R          jump to the run strip; pressed again inside it, show or hide
//               the shown run's details. Works from the composer too (it is
//               modifier-based; on macOS it replaces typing "®").
//   ⌥[ / ⌥]     previous / next run in the switcher. Outside text fields
//               only: on several keyboard layouts Option+[ or Option+] is how
//               a bracket is typed.
//   Esc         (strip focused, nothing open) back to where ⌥R came from.
//   ← / →       (on a switcher button) move between the switcher's runs.
//   letters     (strip focused) an extension's own row control can claim a
//               single letter with `data-strip-key` (Flow: P pause/resume,
//               H hand off). Never global: nothing destructive fires from
//               outside the strip.
//
// Matching uses `KeyboardEvent.code` (the physical key), so Option-layer
// characters (®, “, ‘) and non-Latin layouts never change the binding. Cmd and
// Ctrl combinations are left alone (the app's ⌘K, ⌘B, ⌘J, ⌥⌘… shortcuts).

/** Display strings (macOS glyphs; keyboardLabel() turns ⌥ into Alt+ elsewhere). */
export const RUN_STRIP_KEYS = Object.freeze({
  focus: '⌥R',
  previous: '⌥[',
  next: '⌥]',
  back: 'Esc',
})

/** aria-keyshortcuts values (WAI-ARIA syntax). */
export const RUN_STRIP_ARIA_KEYS = Object.freeze({
  focus: 'Alt+R',
  cycle: 'Alt+[ Alt+]',
})

export type RunStripCommand = 'focus' | 'previous' | 'next'

/** The strip command a key press asks for, or null. Option/Alt alone, by physical key. */
export function runStripCommand(event: Pick<KeyboardEvent, 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'code'>): RunStripCommand | null {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null
  if (event.code === 'KeyR') return 'focus'
  if (event.code === 'BracketLeft') return 'previous'
  if (event.code === 'BracketRight') return 'next'
  return null
}

/** A text field (input, textarea, select, contenteditable) has the key press. */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable === true) return true
  return typeof el.closest === 'function' && !!el.closest('[contenteditable]:not([contenteditable="false"])')
}

/** The single-letter key an element claims inside the strip (`data-strip-key="p"`), as a `code`. */
export function stripKeyCode(letter: string): string {
  return `Key${letter.toUpperCase()}`
}

/** What one mounted strip offers the shortcut layer. */
export interface RunStripHandle {
  /** The mission surface the strip lives in (null while detached). */
  surface: () => Element | null
  /** The strip shows a run (there is something to act on). */
  hasRuns: () => boolean
  /** Focus is inside the strip. */
  hasFocus: () => boolean
  /** Move focus to the strip; `from` is where Esc returns. */
  focus: (from: Element | null) => void
  togglePanel: () => void
  cycle: (direction: 1 | -1) => void
}

interface Registered {
  handle: RunStripHandle
  focusedAt: number
  mountedAt: number
}

const strips = new Set<Registered>()
let clock = 0

/** The strip a shortcut acts on: focus inside its surface › most recently focused › most recently mounted. */
export function resolveRunStrip<T extends { surface: () => Element | null }>(
  entries: ReadonlyArray<{ handle: T; focusedAt: number; mountedAt: number }>,
  active: Element | null,
): T | null {
  const attached = entries.filter((entry) => entry.handle.surface()?.isConnected)
  if (attached.length === 0) return null
  if (active) {
    const containing = attached.find((entry) => entry.handle.surface()?.contains(active))
    if (containing) return containing.handle
  }
  let best = attached[0]
  for (const entry of attached.slice(1)) {
    if (entry.focusedAt > best.focusedAt || (entry.focusedAt === best.focusedAt && entry.mountedAt > best.mountedAt)) best = entry
  }
  return best.handle
}

/** A dialog other than a mission's own (the floating mission panel is a non-modal dialog) owns the key. */
function insideForeignDialog(target: EventTarget | null): boolean {
  const el = target as Element | null
  if (!el || typeof el.closest !== 'function') return false
  const dialog = el.closest('[role="dialog"], [role="alertdialog"]')
  return !!dialog && !dialog.querySelector('[data-mission-surface]')
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.repeat) return
  const command = runStripCommand(event)
  if (!command) return
  // A modal owns the keyboard; text fields keep their brackets.
  if (insideForeignDialog(event.target)) return
  if (command !== 'focus' && isTextEntry(event.target)) return
  const active = typeof document === 'undefined' ? null : document.activeElement
  const strip = resolveRunStrip([...strips], active)
  if (!strip || !strip.hasRuns()) return
  event.preventDefault()
  if (command === 'focus') {
    if (strip.hasFocus()) strip.togglePanel()
    else strip.focus(active)
    return
  }
  strip.cycle(command === 'next' ? 1 : -1)
}

function onFocusIn(event: FocusEvent): void {
  const target = event.target as Element | null
  if (!target) return
  for (const entry of strips) {
    if (entry.handle.surface()?.contains(target)) entry.focusedAt = ++clock
  }
}

/** Register a mounted strip; the returned function unregisters it. One listener pair app-wide. */
export function registerRunStrip(handle: RunStripHandle): () => void {
  const entry: Registered = { handle, focusedAt: 0, mountedAt: ++clock }
  if (strips.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
  }
  strips.add(entry)
  return () => {
    strips.delete(entry)
    if (strips.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
    }
  }
}
