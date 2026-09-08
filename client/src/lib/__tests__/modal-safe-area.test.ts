import { afterEach, describe, expect, it } from 'vitest'
import { modalDialogStyle, modalOverlayStyle, modalTitleBarInset } from '../modal-safe-area'

const original = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__')
afterEach(() => {
  if (original) Object.defineProperty(window, '__TAURI_INTERNALS__', original)
  else Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
})

describe('modal safe area', () => {
  it('reserves desktop chrome for overlays and centers dialogs below it', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    expect(modalTitleBarInset()).toBe(28)
    expect(modalOverlayStyle()).toEqual({ top: 28 })
    expect(modalDialogStyle().top).toBe('calc(50% + 14px)')
    expect(modalDialogStyle().maxHeight).toContain('100dvh - 28px - 32px')
  })

  it('does not reserve native chrome in the browser', () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    expect(modalOverlayStyle()).toEqual({ top: 0 })
    expect(modalDialogStyle().top).toBe('calc(50% + 0px)')
  })
})
