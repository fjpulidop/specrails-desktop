/** Match displayed modifiers to the user's keyboard, including browser development. */
export function keyboardLabel(keys: string, platform = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  if (/Mac|iPhone|iPad/i.test(platform)) return keys
  return keys.replace(/⌥/g, 'Alt+').replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+').replace(/[⏎↵]/g, 'Enter')
}
