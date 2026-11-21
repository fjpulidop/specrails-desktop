import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { toast, type ToastT } from 'sonner'
import { handOffSurfaceToasts, serializeToast, showForwardedToast, toastText, useTrackSurfaceToasts } from '../surface-toasts'

const invoke = vi.fn(async () => {})
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...(args as [])) }))

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
  it('shows a handed-off toast with no action button', () => {
    const error = vi.spyOn(toast, 'error')
    showForwardedToast('surface-b', { id: 2, type: 'error', title: 'Could not continue the run', action: 'Retry' })
    expect(error).toHaveBeenCalledWith('Could not continue the run', { id: 'surface:surface-b:2' })
  })
})

function Tracker() {
  useTrackSurfaceToasts()
  return null
}

describe('surface window side', () => {
  it('shows its own toasts (nothing is relayed while the window is open)', async () => {
    render(<Tracker />)
    act(() => { toast.error('Could not continue the run', { action: { label: 'Retry', onClick: () => {} } }) })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(invoke).not.toHaveBeenCalled()
  })

  it('hands the toasts still on screen to the opener as it closes: text only, no action, no spinner, nothing dismissed', async () => {
    render(<Tracker />)
    let failed: string | number = ''
    let gone: string | number = ''
    act(() => {
      toast.loading('Saving…')
      gone = toast.success('Saved')
      failed = toast.error('Could not continue the run', { description: 'The run has no step to continue from', action: { label: 'Retry', onClick: () => {} } })
    })
    act(() => { toast.dismiss(gone) })
    const handed = async () => { invoke.mockClear(); await handOffSurfaceToasts(); return invoke.mock.calls }
    await waitFor(async () => expect(await handed()).toEqual([['surface_window_toast', { toast: { id: failed, type: 'error', title: 'Could not continue the run', description: 'The run has no step to continue from' } }]]))
  })

  it('hands off nothing outside the desktop app', async () => {
    render(<Tracker />)
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    act(() => { toast.success('Saved') })
    await new Promise(resolve => setTimeout(resolve, 10))
    await handOffSurfaceToasts()
    expect(invoke).not.toHaveBeenCalled()
  })
})
