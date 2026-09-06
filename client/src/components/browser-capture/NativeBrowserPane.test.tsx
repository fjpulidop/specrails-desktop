import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeBrowserCapture, NativeBrowserEvent } from '../../lib/native-browser'

const native = vi.hoisted(() => ({
  open: vi.fn(), close: vi.fn(), navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn(),
  setBounds: vi.fn(), show: vi.fn(), hide: vi.fn(), devtools: vi.fn(), zoom: vi.fn(),
  setSelectMode: vi.fn(), selection: vi.fn(), capture: vi.fn(), onEvent: vi.fn(),
}))
vi.mock('../../lib/native-browser', async (original) => ({
  ...await original<typeof import('../../lib/native-browser')>(), nativeBrowser: native,
}))
vi.mock('../../lib/tauri-shell', () => ({ openExternalUrl: vi.fn(), isTauri: () => false }))

import { NativeBrowserModal } from './NativeBrowserPane'

let rect: { left: number; top: number; width: number; height: number }
let resize: ResizeObserverCallback
let events: Map<string, (event: NativeBrowserEvent) => void>
const snapshot: NativeBrowserCapture = {
  screenshotDataUrl: 'data:image/png;base64,c25hcHNob3Q=', url: 'https://example.test/', title: 'Example',
  viewport: { width: 1200, height: 700, deviceScaleFactor: 2 },
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const mock of Object.values(native)) mock.mockResolvedValue(undefined)
  native.selection.mockResolvedValue(null)
  native.capture.mockResolvedValue(snapshot)
  events = new Map()
  native.onEvent.mockImplementation(async (owner: string, handler: (event: NativeBrowserEvent) => void) => {
    events.set(owner, handler)
    return () => { events.delete(owner) }
  })
  rect = { left: 30, top: 70, width: 1200, height: 700 }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect as DOMRect)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
})

afterEach(() => { vi.unstubAllGlobals() })

function openProps() {
  return { url: 'https://example.test/', onClose: vi.fn(), onFallback: vi.fn() }
}

async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled())
  return native.open.mock.calls.at(-1)![0] as string
}

describe('NativeBrowserModal lifecycle', () => {
  it('disposes a listener that resolves after unmount without opening a pane', async () => {
    const unlisten = vi.fn()
    let resolve!: (unlisten: () => void) => void
    native.onEvent.mockReturnValue(new Promise<() => void>((done) => { resolve = done }))
    const { unmount } = render(<NativeBrowserModal {...openProps()} />)
    const owner = native.onEvent.mock.calls[0][0]
    unmount()
    await act(async () => { resolve(unlisten) })
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(native.open).not.toHaveBeenCalled()
    expect(native.close).toHaveBeenCalledWith(owner)
  })

  it('uses distinct owners during StrictMode replay so stale cleanup cannot close the live pane', async () => {
    const { unmount } = render(<StrictMode><NativeBrowserModal {...openProps()} /></StrictMode>)
    const liveOwner = await ready()
    expect(native.onEvent).toHaveBeenCalledTimes(2)
    const [oldOwner, newOwner] = native.onEvent.mock.calls.map(call => call[0])
    expect(oldOwner).not.toBe(newOwner)
    expect(liveOwner).toBe(newOwner)
    expect(native.close).toHaveBeenCalledWith(oldOwner)
    expect(native.close).not.toHaveBeenCalledWith(liveOwner)
    unmount()
    await waitFor(() => expect(native.close).toHaveBeenCalledWith(liveOwner))
  })

  it('adopts the transferred owner through StrictMode without closing its live lease', async () => {
    const { unmount } = render(<StrictMode><NativeBrowserModal {...openProps()} ownerId="transferred-pane" /></StrictMode>)
    expect(await ready()).toBe('transferred-pane')
    expect(native.open).toHaveBeenCalledTimes(1)
    expect(native.close).not.toHaveBeenCalledWith('transferred-pane')
    unmount()
    await waitFor(() => expect(native.close).toHaveBeenCalledExactlyOnceWith('transferred-pane'))
  })

  it('readopts a rolled-back session without closing it on revision cleanup', async () => {
    const props = openProps()
    const { rerender } = render(<NativeBrowserModal {...props} ownerId="rollback-pane" leaseRevision={1} />)
    await ready()
    rerender(<NativeBrowserModal {...props} ownerId="rollback-pane" leaseRevision={2} />)
    await waitFor(() => expect(native.open).toHaveBeenCalledTimes(2))
    expect(native.close).not.toHaveBeenCalledWith('rollback-pane')
  })

  it('only resumes a parked pane while its matching UI lease remains mounted', async () => {
    const { unmount } = render(<NativeBrowserModal {...openProps()} ownerId="parked-pane" />)
    const owner = await ready()
    const handler = events.get(owner)!
    act(() => { handler({ ownerId: owner, kind: 'resume', url: 'https://retained.test/' }) })
    await waitFor(() => expect(native.open).toHaveBeenCalledTimes(2))
    unmount()
    act(() => { handler({ ownerId: owner, kind: 'resume', url: 'https://retained.test/' }) })
    await act(async () => {})
    expect(native.open).toHaveBeenCalledTimes(2)
  })

  it('serializes re-adoption behind an older pending opening of the same owner', async () => {
    let finish!: () => void
    native.open.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    const first = render(<NativeBrowserModal {...openProps()} ownerId="same-pane" />)
    await waitFor(() => expect(native.open).toHaveBeenCalledTimes(1))
    first.unmount()
    render(<NativeBrowserModal {...openProps()} ownerId="same-pane" />)
    await act(async () => { finish() })
    await ready()
    expect(native.open).toHaveBeenCalledTimes(2)
    expect(native.close).not.toHaveBeenCalledWith('same-pane')
  })

  it('closes only the old owner when an earlier open resolves after a new modal is ready', async () => {
    let finishOld!: () => void
    native.open.mockReturnValueOnce(new Promise<void>((resolve) => { finishOld = resolve }))
    const first = render(<NativeBrowserModal {...openProps()} />)
    await waitFor(() => expect(native.open).toHaveBeenCalledTimes(1))
    const oldOwner = native.open.mock.calls[0][0]
    first.unmount()
    render(<NativeBrowserModal {...openProps()} />)
    const newOwner = await ready()
    expect(newOwner).not.toBe(oldOwner)
    await act(async () => { finishOld() })
    expect(native.close.mock.calls.every(call => call[0] === oldOwner)).toBe(true)
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled()
  })

  it('navigates a new URL without recreating the page, including a change during initial open', async () => {
    let finishOpen!: () => void
    native.open.mockReturnValueOnce(new Promise<void>((resolve) => { finishOpen = resolve }))
    const props = openProps()
    const { rerender } = render(<NativeBrowserModal {...props} />)
    await waitFor(() => expect(native.open).toHaveBeenCalledTimes(1))
    rerender(<NativeBrowserModal {...props} url="http://localhost:5173/second" />)
    await act(async () => { finishOpen() })
    const owner = await ready()
    await waitFor(() => expect(native.navigate).toHaveBeenCalledWith(owner, 'http://localhost:5173/second'))
    rerender(<NativeBrowserModal {...props} url="https://third.test/" />)
    await waitFor(() => expect(native.navigate).toHaveBeenCalledWith(owner, 'https://third.test/'))
    expect(native.open).toHaveBeenCalledTimes(1)
    expect(native.close).not.toHaveBeenCalled()
  })

  it('deduplicates identical bounds and sends only the latest size in a resize burst', async () => {
    render(<NativeBrowserModal {...openProps()} />)
    const owner = await ready()
    act(() => { resize([], {} as ResizeObserver); resize([], {} as ResizeObserver) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(native.setBounds).not.toHaveBeenCalled()
    act(() => {
      rect.width = 1300
      resize([], {} as ResizeObserver)
      rect.width = 1400
      resize([], {} as ResizeObserver)
    })
    await waitFor(() => expect(native.setBounds).toHaveBeenCalledExactlyOnceWith(owner, { x: 30, y: 70, width: 1400, height: 700 }))
  })

  it('surfaces popup creation failures without discarding the original login page', async () => {
    const props = openProps()
    render(<NativeBrowserModal {...props} />)
    const owner = await ready()
    act(() => { events.get(owner)!({ ownerId: owner, kind: 'popup-error' }) })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not open the sign-in window. Try signing in again.')
    expect(props.onFallback).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(native.close).not.toHaveBeenCalled()
    expect(native.navigate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled()
    act(() => { events.get(owner)!({ ownerId: owner, kind: 'popup-opened' }) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(native.open).toHaveBeenCalledTimes(1)
  })
})

describe('NativeBrowserModal capture', () => {
  it('hides the same native page for annotation and shows it again without a reload or new session', async () => {
    render(<NativeBrowserModal {...openProps()} onCaptured={vi.fn()} />)
    const owner = await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Capture page' }))
    await screen.findByTestId('annotation-confirm')
    expect(native.capture).toHaveBeenCalledWith(owner, false)
    expect(native.hide).toHaveBeenCalledWith(owner)
    expect(native.capture.mock.invocationCallOrder[0]).toBeLessThan(native.hide.mock.invocationCallOrder[0])
    fireEvent.click(screen.getByRole('button', { name: 'Reselect' }))
    await waitFor(() => expect(native.show).toHaveBeenCalledWith(owner))
    expect(screen.queryByTestId('annotation-confirm')).not.toBeInTheDocument()
    expect(native.open).toHaveBeenCalledTimes(1)
    expect(native.close).not.toHaveBeenCalled()
    expect(native.reload).not.toHaveBeenCalled()
    expect(native.navigate).not.toHaveBeenCalled()
  })

  it('opens annotation immediately after picking the native element without delivering until confirmation', async () => {
    const picked = { selector: 'main > button', tagName: 'BUTTON', text: 'Save', rect: { x: 10, y: 20, width: 100, height: 30 } }
    native.selection.mockResolvedValueOnce(picked)
    const onCaptured = vi.fn()
    render(<NativeBrowserModal {...openProps()} onCaptured={onCaptured} />)
    const owner = await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Select element' }))
    await screen.findByTestId('annotation-confirm')
    expect(native.setSelectMode).toHaveBeenCalledWith(owner, true)
    expect(native.setSelectMode).toHaveBeenCalledWith(owner, false)
    expect(native.capture).toHaveBeenCalledExactlyOnceWith(owner, true)
    expect(native.hide).toHaveBeenCalledWith(owner)
    expect(native.setSelectMode.mock.invocationCallOrder[1]).toBeLessThan(native.capture.mock.invocationCallOrder[0])
    expect(onCaptured).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    await waitFor(() => expect(onCaptured).toHaveBeenCalledExactlyOnceWith(snapshot))
  })

  it('retains the picked element for retry when automatic native capture fails', async () => {
    native.selection.mockResolvedValueOnce({ selector: '#picked', tagName: 'DIV', text: '', rect: { x: 10, y: 20, width: 100, height: 30 } })
    native.capture.mockRejectedValueOnce(new Error('Snapshot failed')).mockResolvedValueOnce(snapshot)
    render(<NativeBrowserModal {...openProps()} onCaptured={vi.fn()} />)
    const owner = await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Select element' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Snapshot failed')
    expect(native.hide).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Capture selection' }))
    await screen.findByTestId('annotation-confirm')
    expect(native.capture.mock.calls).toEqual([[owner, true], [owner, true]])
  })

  it('waits for the native pane to be hidden and ignores resume while entering annotation', async () => {
    let hidden!: () => void
    native.hide.mockReturnValue(new Promise<void>(resolve => { hidden = resolve }))
    const props = openProps()
    render(<NativeBrowserModal {...props} onCaptured={vi.fn()} />)
    const owner = await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Capture page' }))
    await waitFor(() => expect(native.hide).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('annotation-confirm')).not.toBeInTheDocument()
    act(() => { events.get(owner)!({ ownerId: owner, kind: 'resume' }) })
    await act(async () => { hidden() })
    await screen.findByTestId('annotation-confirm')
    expect(native.open).toHaveBeenCalledTimes(1)
    expect(props.onFallback).not.toHaveBeenCalled()
  })

  it('keeps a failed native capture in the same browser instead of falling back to another profile', async () => {
    const props = openProps()
    native.capture.mockRejectedValueOnce(new Error('Snapshot failed'))
    render(<NativeBrowserModal {...props} onCaptured={vi.fn()} />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Capture page' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Snapshot failed')
    expect(props.onFallback).not.toHaveBeenCalled()
    expect(native.hide).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Capture page' })).toBeEnabled()
  })

  it('removes the native input shield when selection polling fails', async () => {
    native.selection.mockRejectedValueOnce(new Error('Selection timed out'))
    let finishDisable!: () => void
    native.setSelectMode.mockImplementation((_owner, enabled) => enabled
      ? Promise.resolve()
      : new Promise<void>(resolve => { finishDisable = resolve }))
    render(<NativeBrowserModal {...openProps()} onCaptured={vi.fn()} />)
    const owner = await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Select element' }))
    await waitFor(() => expect(native.setSelectMode).toHaveBeenCalledWith(owner, false))
    expect(screen.getByRole('button', { name: 'Select element' })).toHaveAttribute('aria-pressed', 'true')
    await act(async () => { finishDisable() })
    expect(screen.getByRole('button', { name: 'Select element' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('alert')).toHaveTextContent('Selection timed out')
  })

  it('keeps selection active and allows cancelling again when native cleanup fails', async () => {
    native.selection.mockResolvedValueOnce({ selector: '#button', tagName: 'button', text: 'Save', rect: { x: 0, y: 0, width: 100, height: 30 } })
    native.setSelectMode.mockImplementation((_owner, enabled) => enabled
      ? Promise.resolve()
      : Promise.reject(new Error('Cannot disable selector')))
    render(<NativeBrowserModal {...openProps()} onCaptured={vi.fn()} />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Select element' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot disable selector')
    expect(screen.getByRole('button', { name: 'Select element' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: 'Capture selection' })).not.toBeInTheDocument()
    native.setSelectMode.mockResolvedValue(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Select element' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select element' })).toHaveAttribute('aria-pressed', 'false'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('retains the snapshot preview when saving fails and retries through the same destination', async () => {
    const props = openProps()
    const onCaptured = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined)
    render(<NativeBrowserModal {...props} onCaptured={onCaptured} />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Capture page' }))
    fireEvent.click(await screen.findByTestId('annotation-confirm'))
    await screen.findByRole('alert')
    expect(screen.getByRole('img')).toHaveAttribute('src', snapshot.screenshotDataUrl)
    expect(props.onFallback).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    await waitFor(() => expect(onCaptured).toHaveBeenCalledTimes(2))
    expect(onCaptured).toHaveBeenLastCalledWith(snapshot)
    expect(native.capture).toHaveBeenCalledTimes(1)
  })
})
