import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureResult } from '../../lib/browser-capture'

const session = vi.hoisted(() => ({
  canvasRef: { current: null as HTMLCanvasElement | null },
  viewport: { width: 1000, height: 800 }, status: 'ready', errorMsg: null,
  url: 'https://example.test', title: 'Example', popup: null as { count: number; active: boolean; url: string | null } | null,
  popupError: null as string | null,
  hoverRect: { x: 10, y: 10, width: 100, height: 100 }, hoverSelector: 'button', hoverPath: null,
  setViewport: vi.fn(), capture: vi.fn(), captureBreakpoints: vi.fn(), clearHover: vi.fn(),
  forwardInput: vi.fn(), navigate: vi.fn(), clipboard: vi.fn(), setPopupView: vi.fn(),
  probe: vi.fn(), navigateElement: vi.fn(),
}))
vi.mock('./useBrowserCaptureSession', () => ({ useBrowserCaptureSession: () => session }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BrowserCaptureModal } from './BrowserCaptureModal'

const result = {
  screenshotDataUrl: 'data:image/png;base64,c25hcHNob3Q=', screenshot: { id: 'screenshot' }, domAttachment: { id: 'dom' },
} as CaptureResult

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('PointerEvent', MouseEvent)
  session.capture.mockResolvedValue(result)
  session.captureBreakpoints.mockResolvedValue(result)
  session.popup = null
  session.popupError = null
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 1000, height: 800 } as DOMRect)
})

afterEach(() => { vi.unstubAllGlobals() })

function props() {
  return { open: true, projectId: 'project-a', pendingSpecId: 'pending-a', onClose: vi.fn(), onCaptured: vi.fn() }
}

function selectRegion() {
  fireEvent.click(screen.getByTestId('browser-select-toggle'))
  const layer = session.canvasRef.current!.nextElementSibling!
  fireEvent.pointerDown(layer, { clientX: 20, clientY: 20, pointerId: 1 })
  fireEvent.pointerUp(layer, { clientX: 20, clientY: 20, pointerId: 1 })
}

describe('BrowserCaptureModal capture destination', () => {
  it('shows the popup address, keeps navigation on the visible page and restores the opener after close', () => {
    const callbacks = props()
    session.popup = { count: 1, active: true, url: 'https://login.test/authorize' }
    const { rerender } = render(<BrowserCaptureModal {...callbacks} />)
    const address = screen.getByRole('textbox', { name: 'Address bar' })
    expect(address).toHaveValue('https://login.test/authorize')
    expect(screen.getByTestId('browser-select-toggle')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(session.navigate).toHaveBeenCalledWith('reload')
    fireEvent.change(address, { target: { value: 'https://login.test/retry' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(session.navigate).toHaveBeenCalledWith('goto', 'https://login.test/retry')
    session.popup = null
    rerender(<BrowserCaptureModal {...callbacks} />)
    expect(address).toHaveValue('https://example.test')
    expect(screen.getByTestId('browser-select-toggle')).toBeEnabled()
  })

  it('resets address drafts on view switches even when the two pages have the same URL', () => {
    const callbacks = props()
    session.popup = { count: 1, active: true, url: 'https://example.test' }
    const { rerender } = render(<BrowserCaptureModal {...callbacks} />)
    const address = screen.getByRole('textbox', { name: 'Address bar' })
    fireEvent.change(address, { target: { value: 'https://unsent.test' } })
    session.popup = { ...session.popup, active: false }
    rerender(<BrowserCaptureModal {...callbacks} />)
    expect(address).toHaveValue('https://example.test')
  })

  it('shows a recoverable switch error without enabling capture or hiding the login', () => {
    session.popup = { count: 1, active: true, url: 'https://login.test' }
    session.popupError = 'Connection error'
    render(<BrowserCaptureModal {...props()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Connection error')
    expect(session.canvasRef.current).toBeInTheDocument()
    expect(screen.getByTestId('browser-select-toggle')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Back to page' }))
    expect(session.setPopupView).toHaveBeenCalledWith('root')
  })

  it('keeps the annotation editor when the destination rejects and only closes after a successful retry', async () => {
    const callbacks = props()
    callbacks.onCaptured.mockRejectedValueOnce(new Error('upload offline')).mockResolvedValueOnce(undefined)
    render(<BrowserCaptureModal {...callbacks} />)
    selectRegion()
    fireEvent.click(await screen.findByTestId('annotation-confirm'))
    await screen.findByRole('alert')
    expect(callbacks.onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('img')).toHaveAttribute('src', result.screenshotDataUrl)
    expect(callbacks.onCaptured).toHaveBeenCalledExactlyOnceWith(result)
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    await waitFor(() => expect(callbacks.onClose).toHaveBeenCalledTimes(1))
    expect(callbacks.onCaptured).toHaveBeenCalledTimes(2)
    expect(session.capture).toHaveBeenCalledTimes(1)
  })

  it('opens annotation for all-breakpoint captures and waits for explicit confirmation before uploading', async () => {
    const callbacks = props()
    let reject!: (cause: Error) => void
    callbacks.onCaptured.mockReturnValue(new Promise<void>((_, fail) => { reject = fail }))
    render(<BrowserCaptureModal {...callbacks} />)
    fireEvent.click(screen.getByRole('button', { name: 'Capture at all screen sizes' }))
    selectRegion()
    fireEvent.click(await screen.findByTestId('annotation-confirm'))
    await waitFor(() => expect(callbacks.onCaptured).toHaveBeenCalledExactlyOnceWith(result))
    expect(callbacks.onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('annotation-confirm')).toBeDisabled()
    await act(async () => { reject(new Error('upload offline')) })
    expect(screen.getByRole('alert')).toHaveTextContent('Capture failed')
    expect(callbacks.onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('annotation-confirm')).toBeEnabled()
    expect(session.captureBreakpoints).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('does not deliver a drag capture before annotation confirmation (all sizes: %s)', async (allSizes) => {
    const callbacks = props()
    render(<BrowserCaptureModal {...callbacks} />)
    if (allSizes) fireEvent.click(screen.getByRole('button', { name: 'Capture at all screen sizes' }))
    fireEvent.click(screen.getByTestId('browser-select-toggle'))
    const layer = session.canvasRef.current!.nextElementSibling!
    fireEvent.pointerDown(layer, { clientX: 30, clientY: 40, pointerId: 1 })
    fireEvent.pointerMove(layer, { clientX: 330, clientY: 240, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 330, clientY: 240, pointerId: 1 })
    await screen.findByTestId('annotation-confirm')
    expect(callbacks.onCaptured).not.toHaveBeenCalled()
    expect(callbacks.onClose).not.toHaveBeenCalled()
    expect((allSizes ? session.captureBreakpoints : session.capture).mock.calls[0][0]).toEqual({ x: 30, y: 40, width: 300, height: 200 })
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    await waitFor(() => expect(callbacks.onCaptured).toHaveBeenCalledExactlyOnceWith(result))
  })

  it('lets the dirty editor decide Escape and ignores backdrop clicks instead of discarding markup', async () => {
    const callbacks = props()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<BrowserCaptureModal {...callbacks} />)
    selectRegion()
    await screen.findByTestId('annotation-confirm')
    // Step badges do not require canvas flattening to create a dirty annotation.
    fireEvent.click(screen.getByRole('button', { name: /Step number/ }))
    fireEvent.pointerDown(screen.getByRole('img').parentElement!.querySelector('svg')!, { clientX: 50, clientY: 60, pointerId: 1 })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(window.confirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('dialog').parentElement!)
    expect(callbacks.onClose).not.toHaveBeenCalled()
    expect(callbacks.onCaptured).not.toHaveBeenCalled()
    expect(screen.getByTestId('annotation-confirm')).toBeInTheDocument()
  })

  it('does not close the parent on Escape while an attachment is being saved', async () => {
    const callbacks = props()
    let finish!: () => void
    callbacks.onCaptured.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    render(<BrowserCaptureModal {...callbacks} />)
    selectRegion()
    fireEvent.click(await screen.findByTestId('annotation-confirm'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(callbacks.onClose).not.toHaveBeenCalled()
    await act(async () => { finish() })
    expect(callbacks.onClose).toHaveBeenCalledTimes(1)
  })

  it('captures one selection only once under StrictMode', async () => {
    render(<StrictMode><BrowserCaptureModal {...props()} /></StrictMode>)
    selectRegion()
    await screen.findByTestId('annotation-confirm')
    expect(session.capture).toHaveBeenCalledTimes(1)
  })
})
