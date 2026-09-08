import type { CSSProperties } from 'react'

/** Matches the desktop title bar; browser dialogs have no native chrome. */
export function modalTitleBarInset(): number { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? 28 : 0 }

/** Keep full-window modal backdrops and their flex layouts below window controls. */
export function modalOverlayStyle(): CSSProperties { return { top: modalTitleBarInset() } }

/** Center a dialog in the usable area, with proportional, bounded margins. */
export function modalDialogStyle(): CSSProperties {
  const top = modalTitleBarInset()
  return {
    top: `calc(50% + ${top / 2}px)`,
    maxHeight: `min(85dvh, calc(100dvh - ${top}px - 32px))`,
  }
}
