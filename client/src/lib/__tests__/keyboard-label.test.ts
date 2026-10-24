import { describe, it, expect } from 'vitest'
import { inboxAriaShortcut, inboxShortcutLabel, keyboardLabel } from '../keyboard-label'

describe('inbox chord labels', () => {
  it('is ⌘⇧I on macOS and Ctrl+Alt+I elsewhere (Ctrl+Shift+I opens DevTools)', () => {
    expect(inboxShortcutLabel('MacIntel')).toBe('⌘⇧I')
    expect(inboxShortcutLabel('Win32')).toBe('Ctrl+Alt+I')
    expect(keyboardLabel('⌘⇧I', 'Linux x86_64')).toBe('Ctrl+Alt+I')
    expect(keyboardLabel('⌘⇧A', 'Win32')).toBe('Ctrl+Shift+A')
  })
  it('declares the same chord for assistive tech', () => {
    expect(inboxAriaShortcut('MacIntel')).toBe('Meta+Shift+I')
    expect(inboxAriaShortcut('Win32')).toBe('Control+Alt+I')
  })
})
