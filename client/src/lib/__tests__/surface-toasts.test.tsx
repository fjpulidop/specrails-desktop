import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, act, cleanup, waitFor } from '@testing-library/react'
import { toast, type ToastT } from 'sonner'
import { serializeToast, showForwardedToast, toastText, useForwardSurfaceToasts } from '../surface-toasts'

const invoke = vi.fn(async () => {})
let actionListener: ((event: { payload: { id: string | number } }) => void) | null = null
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...(args as [])) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, callback: typeof actionListener) => { actionListener = callback; return () => { actionListener = null } }),
  emitTo: vi.fn(async () => {}),
}))

beforeEach(() => {
  invoke.mockClear()
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
})
afterEach(() => {
  cleanup()
  toast.dismiss()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('surface toast serialization', () => {
  it('reduces titles and descriptions to plain text', () => {
    expect(toastText('Saved')).toBe('Saved')
    expect(toastText(createElement('span', null, 'Saved ', createElement('b', null, 3)))).toBe('Saved 3')
    expect(toastText(() => 'lazy')).toBe('lazy')
    expect(toastText(null)).toBe('')
  })

  it('keeps type, text, duration and the action label; drops empty toasts', () => {
    const item = { id: 7, type: 'error', title: 'Failed', description: createElement('span', null, 'disk full'), duration: 5000, action: { label: 'Retry', onClick: () => {} } } as unknown as ToastT
    expect(serializeToast(item)).toEqual({ id: 7, type: 'error', title: 'Failed', description: 'disk full', duration: 5000, action: 'Retry' })
    expect(serializeToast({ id: 8, type: 'custom' as never, title: 'x' } as ToastT)).toMatchObject({ type: 'default' })
    expect(serializeToast({ id: 9, jsx: createElement('div') } as ToastT)).toBeNull()
  })
})

describe('opener side', () => {
  it('shows a forwarded toast under a per-window id, and applies dismissals', () => {
    const success = vi.spyOn(toast, 'success')
    const dismiss = vi.spyOn(toast, 'dismiss')
    const onAction = vi.fn()
    showForwardedToast('surface-a', { id: 1, type: 'success', title: 'Saved', description: 'All good', action: 'Undo' }, onAction)
    expect(success).toHaveBeenCalledWith('Saved', expect.objectContaining({ id: 'surface:surface-a:1', description: 'All good', action: expect.objectContaining({ label: 'Undo' }) }))
    const options = success.mock.calls[0][1] as { action: { onClick: () => void } }
    options.action.onClick()
    expect(onAction).toHaveBeenCalled()
    showForwardedToast('surface-a', { id: 1, dismissed: true }, onAction)
    expect(dismiss).toHaveBeenCalledWith('surface:surface-a:1')
  })
})

function Forwarder() {
  useForwardSurfaceToasts()
  return null
}

describe('surface window side', () => {
  it('relays new toasts, updates and dismissals, and runs relayed action clicks', async () => {
    const retry = vi.fn()
    render(<Forwarder />)
    let id: string | number = ''
    act(() => { id = toast.loading('Saving…') })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('surface_window_toast', { toast: expect.objectContaining({ id, type: 'loading', title: 'Saving…' }) }))
    act(() => { toast.error('Save failed', { id, action: { label: 'Retry', onClick: retry } }) })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('surface_window_toast', { toast: expect.objectContaining({ id, type: 'error', title: 'Save failed', action: 'Retry' }) }))
    const calls = invoke.mock.calls.length
    act(() => { actionListener?.({ payload: { id } }) })
    expect(retry).toHaveBeenCalledTimes(1)
    act(() => { toast.dismiss(id) })
    await waitFor(() => expect(invoke.mock.calls.length).toBeGreaterThan(calls))
    expect(invoke).toHaveBeenLastCalledWith('surface_window_toast', { toast: { id, dismissed: true } })
  })
})
