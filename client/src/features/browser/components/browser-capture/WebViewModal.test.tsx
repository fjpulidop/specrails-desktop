import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const browser = vi.hoisted(() => ({ available: vi.fn(), setViewport: vi.fn(), session: vi.fn() }))
vi.mock('../../lib/native-browser', () => ({ isNativeBrowserAvailable: browser.available }))
vi.mock('./NativeBrowserPane', async (importOriginal) => ({
  // The shared Radix capture shell is real; only the native pane is faked.
  ...(await importOriginal<typeof import('./NativeBrowserPane')>()),
  NativeBrowserModal: ({ url, onFallback }: { url: string; onFallback: () => void }) => (
    <div data-testid="native-test"><span>{url}</span><button onClick={onFallback}>Fallback</button></div>
  ),
}))
vi.mock('./useBrowserCaptureSession', () => ({ useBrowserCaptureSession: browser.session }))

import { WebViewModal } from './WebViewModal'

beforeEach(() => {
  vi.clearAllMocks()
  browser.available.mockResolvedValue(false)
  browser.session.mockReturnValue({
    canvasRef: { current: null }, viewport: { width: 1280, height: 800 }, status: 'ready', errorMsg: null,
    url: 'https://example.test', title: 'Example', popup: null, popupError: null, setViewport: browser.setViewport,
    forwardInput: vi.fn(), navigate: vi.fn(), clipboard: vi.fn(), setPopupView: vi.fn(),
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1400, height: 900 } as DOMRect)
})

describe('WebViewModal engine and surface sizing', () => {
  it('shows the login address during popup navigation and restores the opener after self-close', async () => {
    const session = browser.session()
    session.popup = { count: 1, active: true, url: 'https://login.test/authorize' }
    const props = { open: true, url: 'https://example.test', projectId: 'p1', onClose: vi.fn() }
    const { rerender } = render(<WebViewModal {...props} />)
    const address = await screen.findByRole('textbox', { name: 'Address bar' })
    await waitFor(() => expect(address).toHaveValue('https://login.test/authorize'))
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(session.navigate).toHaveBeenCalledWith('reload')
    fireEvent.change(address, { target: { value: 'https://login.test/retry' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(session.navigate).toHaveBeenCalledWith('goto', 'https://login.test/retry')
    session.popup = null
    rerender(<WebViewModal {...props} />)
    expect(address).toHaveValue('https://example.test')
  })

  it('resets an unsent address when switching between pages at the same URL', async () => {
    const session = browser.session()
    session.popup = { count: 1, active: true, url: 'https://example.test' }
    const props = { open: true, url: 'https://example.test', projectId: 'p1', onClose: vi.fn() }
    const { rerender } = render(<WebViewModal {...props} />)
    const address = await screen.findByRole('textbox', { name: 'Address bar' })
    fireEvent.change(address, { target: { value: 'https://unsent.test' } })
    session.popup = { ...session.popup, active: false }
    rerender(<WebViewModal {...props} />)
    expect(address).toHaveValue('https://example.test')
    fireEvent.click(screen.getByRole('button', { name: 'Show login window' }))
    expect(session.setPopupView).toHaveBeenCalledWith('popup')
  })

  it('keeps browsing available and reports a failed view switch inside the modal', async () => {
    const session = browser.session()
    session.popup = { count: 1, active: true, url: 'https://login.test' }
    session.popupError = 'Connection error'
    render(<WebViewModal open url="https://example.test" projectId="p1" onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection error')
    expect(screen.getByTestId('webview-modal').querySelector('canvas')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to page' }))
    expect(session.setPopupView).toHaveBeenCalledWith('root')
  })

  it('fits the fallback page to the visible surface instead of leaving the default viewport', async () => {
    render(<WebViewModal open url="https://example.test" projectId="p1" onClose={vi.fn()} />)
    await waitFor(() => expect(browser.setViewport).toHaveBeenCalledWith(1400, 900, window.devicePixelRatio))
    expect(screen.getByTestId('webview-modal').querySelector('canvas')).toHaveStyle({ maxWidth: 'min(100%, 1280px)', maxHeight: 'min(100%, 800px)' })
  })

  it('opens native without creating a screencast session and updates its URL without probing again', async () => {
    browser.available.mockResolvedValue(true)
    const { rerender } = render(<WebViewModal open url="https://first.test" projectId="p1" onClose={vi.fn()} />)
    await screen.findByTestId('native-test')
    rerender(<WebViewModal open url="https://second.test" projectId="p1" onClose={vi.fn()} />)
    expect(screen.getByTestId('native-test')).toHaveTextContent('https://second.test')
    expect(browser.available).toHaveBeenCalledTimes(1)
    expect(browser.session).not.toHaveBeenCalled()
  })

  it('keeps the selected fallback when the same modal is closed and reopened', async () => {
    browser.available.mockResolvedValue(true)
    const { rerender } = render(<WebViewModal open url="https://example.test" projectId="p1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fallback' }))
    expect(screen.getByTestId('webview-modal')).toBeInTheDocument()
    rerender(<WebViewModal open={false} url="https://example.test" projectId="p1" onClose={vi.fn()} />)
    rerender(<WebViewModal open url="https://example.test" projectId="p1" onClose={vi.fn()} />)
    expect(screen.getByTestId('webview-modal')).toBeInTheDocument()
    expect(screen.queryByTestId('native-test')).not.toBeInTheDocument()
    expect(browser.available).toHaveBeenCalledTimes(1)
  })
})

describe('WebViewModal dialog standard (capture layer)', () => {
  function Harness() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open link</button>
        <WebViewModal open={open} url="https://example.test" projectId="p1" onClose={() => setOpen(false)} />
      </>
    )
  }

  it('traps focus, keeps Tab on the page viewport, closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open link' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Browser capture' })
    expect(dialog).toHaveClass('z-[80]')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    for (let i = 0; i < 12; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }

    const session = browser.session()
    const viewport = dialog.querySelector('canvas')!.parentElement!
    viewport.focus()
    await user.keyboard('{Tab}')
    expect(session.forwardInput).toHaveBeenCalledWith(expect.objectContaining({ type: 'key', key: 'Tab' }))
    expect(document.activeElement).toBe(viewport)
    await user.keyboard('{ArrowLeft}')
    expect(session.forwardInput).toHaveBeenCalledWith(expect.objectContaining({ key: 'ArrowLeft' }))
    expect(document.activeElement).toBe(viewport)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Browser capture' })).toBeNull())
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})
