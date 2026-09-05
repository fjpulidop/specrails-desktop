import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureResult } from '../../lib/browser-capture'

const browser = vi.hoisted(() => ({
  createBrowserSession: vi.fn(),
  openBrowserWs: vi.fn(),
  navigateBrowser: vi.fn(),
  captureBrowserRegion: vi.fn(),
  captureBrowserBreakpoints: vi.fn(),
  browserClipboard: vi.fn(),
  navigateBrowserElement: vi.fn(),
  killBrowserSession: vi.fn(),
  setBrowserPopupView: vi.fn(),
}))

vi.mock('../../lib/browser-capture', () => ({
  ...browser,
  BrowserSessionLimitError: class BrowserSessionLimitError extends Error {},
  BrowserLaunchFailedError: class BrowserLaunchFailedError extends Error {},
}))

vi.mock('../../lib/browser-frame-pipeline', () => ({
  createFramePipeline: () => ({ push: vi.fn(), dispose: vi.fn(), stats: () => ({}) }),
  isBrowserPerfDebugEnabled: () => false,
  startFrameStatsReporter: () => vi.fn(),
}))

import { useBrowserCaptureSession } from './useBrowserCaptureSession'

function fakeSocket(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    send: vi.fn(),
    onmessage: null,
    onopen: null,
    onerror: null,
    onclose: null,
  } as unknown as WebSocket
}

function control(socket: WebSocket, message: object) {
  act(() => { socket.onmessage?.call(socket, new MessageEvent('message', { data: JSON.stringify(message) })) })
}

function captureResult(): CaptureResult {
  return {
    screenshot: { id: 'a1' } as CaptureResult['screenshot'],
    domAttachment: { id: 'a2' } as CaptureResult['domAttachment'],
    dom: {
      url: 'https://example.test',
      title: 'Example',
      viewport: { width: 1280, height: 800 },
      rect: { x: 1, y: 1, width: 10, height: 10 },
      html: '<main />',
      htmlTruncated: false,
      css: '',
      cssTruncated: false,
      nodes: [],
      capturedAt: '2026-07-09T00:00:00.000Z',
    },
    screenshotDataUrl: 'data:image/png;base64,eA==',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  browser.createBrowserSession.mockImplementation(async (projectId: string) => ({
    id: `session-${projectId}`,
    projectId,
    url: null,
    title: null,
    viewportWidth: 1280,
    viewportHeight: 800,
    createdAt: 1,
  }))
  browser.openBrowserWs.mockImplementation(() => fakeSocket())
  browser.killBrowserSession.mockResolvedValue(undefined)
  browser.setBrowserPopupView.mockResolvedValue(undefined)
})

describe('useBrowserCaptureSession ownership and teardown', () => {
  it('retains the latest viewport measured before creation and sends it once when the socket opens', async () => {
    let create!: (session: object) => void
    browser.createBrowserSession.mockReturnValue(new Promise((resolve) => { create = resolve }))
    const socket = fakeSocket()
    Object.defineProperty(socket, 'readyState', { value: WebSocket.CONNECTING, writable: true })
    browser.openBrowserWs.mockReturnValue(socket)
    const { result } = renderHook(() => useBrowserCaptureSession({ projectId: 'project-a', open: true }))
    act(() => {
      result.current.setViewport(1400, 820, 2)
      result.current.setViewport(1500, 900, 2)
    })
    await act(async () => {
      create({ id: 'session-a', projectId: 'project-a', viewportWidth: 1280, viewportHeight: 800, url: null, title: null })
    })
    expect(result.current.viewport).toMatchObject({ width: 1500, height: 900 })
    expect(socket.send).not.toHaveBeenCalled()
    act(() => {
      Object.defineProperty(socket, 'readyState', { value: WebSocket.OPEN })
      socket.onopen?.call(socket, new Event('open'))
      socket.onmessage?.call(socket, new MessageEvent('message', { data: JSON.stringify({ type: 'ready', viewport: { width: 1280, height: 800 } }) }))
    })
    expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'input', event: { type: 'resize', width: 1500, height: 900, deviceScaleFactor: 2 } }))
    expect(result.current.viewport).toMatchObject({ width: 1500, height: 900 })
  })

  it('deduplicates repeated viewport input and only updates density when the monitor changes', async () => {
    const socket = fakeSocket()
    browser.openBrowserWs.mockReturnValue(socket)
    const { result } = renderHook(() => useBrowserCaptureSession({ projectId: 'project-a', open: true }))
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalled())
    const resize = result.current.setViewport
    act(() => { resize(1280, 800, 2) })
    const viewport = result.current.viewport
    act(() => { resize(1280.2, 800.2, 2) })
    expect(result.current.viewport).toBe(viewport)
    expect(result.current.setViewport).toBe(resize)
    expect(socket.send).toHaveBeenCalledTimes(1)
    act(() => { resize(1280, 800, 1) })
    expect(socket.send).toHaveBeenCalledTimes(2)
    expect(result.current.viewport).toBe(viewport)
  })

  it('replays the desired viewport after close and reopen even without another resize notification', async () => {
    const first = fakeSocket()
    const second = fakeSocket()
    browser.openBrowserWs.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const { result, rerender } = renderHook(({ open }) => useBrowserCaptureSession({ projectId: 'project-a', open }), { initialProps: { open: true } })
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalledTimes(1))
    act(() => { result.current.setViewport(1000, 700, 2) })
    rerender({ open: false })
    expect(first.close).toHaveBeenCalled()
    rerender({ open: true })
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalledTimes(2))
    act(() => { second.onopen?.call(second, new Event('open')) })
    expect(second.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'input', event: { type: 'resize', width: 1000, height: 700, deviceScaleFactor: 2 } }))
  })

  it('rejects invalid dimensions and clamps density without sending malformed input', async () => {
    const socket = fakeSocket()
    browser.openBrowserWs.mockReturnValue(socket)
    const { result } = renderHook(() => useBrowserCaptureSession({ projectId: 'project-a', open: true }))
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalled())
    act(() => {
      result.current.setViewport(Number.NaN, 700)
      result.current.setViewport(1200, Number.POSITIVE_INFINITY)
      result.current.setViewport(-1, 700)
    })
    expect(socket.send).not.toHaveBeenCalled()
    act(() => { result.current.setViewport(1200, 700, 4) })
    expect(JSON.parse(vi.mocked(socket.send).mock.calls[0][0] as string).event.deviceScaleFactor).toBe(2)
  })

  it('reports a connection closed during startup instead of leaving a perpetual spinner', async () => {
    const socket = fakeSocket()
    browser.openBrowserWs.mockReturnValue(socket)
    const { result } = renderHook(() => useBrowserCaptureSession({ projectId: 'project-a', open: true }))
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalled())
    act(() => { socket.onclose?.call(socket, new CloseEvent('close')) })
    expect(result.current.status).toBe('error')
    expect(result.current.errorMsg).toBeTruthy()
  })

  it('deletes the old session from its owner project after a project switch', async () => {
    const { rerender } = renderHook(
      ({ projectId }) => useBrowserCaptureSession({ projectId, open: true }),
      { initialProps: { projectId: 'project-a' } },
    )
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalledWith('session-project-a', 'project-a'))

    rerender({ projectId: 'project-b' })

    await waitFor(() => {
      expect(browser.killBrowserSession).toHaveBeenCalledWith('project-a', 'session-project-a')
      expect(browser.openBrowserWs).toHaveBeenCalledWith('session-project-b', 'project-b')
    })
  })

  it('performs a deferred owner-scoped delete when an in-flight capture settles', async () => {
    let resolveCapture!: (result: CaptureResult) => void
    browser.captureBrowserRegion.mockReturnValue(new Promise<CaptureResult>((resolve) => {
      resolveCapture = resolve
    }))
    const { result, unmount } = renderHook(() => (
      useBrowserCaptureSession({ projectId: 'project-a', open: true })
    ))
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalled())

    let pending!: Promise<CaptureResult>
    act(() => {
      pending = result.current.capture({ x: 1, y: 1, width: 10, height: 10 }, 'pending-1')
    })
    unmount()
    expect(browser.killBrowserSession).not.toHaveBeenCalled()

    await act(async () => {
      resolveCapture(captureResult())
      await pending
    })
    expect(browser.killBrowserSession).toHaveBeenCalledWith('project-a', 'session-project-a')
  })

  it('ignores a navigation result from a session replaced by a project switch', async () => {
    let resolveNavigation!: (result: { url: string; title: string }) => void
    browser.navigateBrowser.mockReturnValue(new Promise((resolve) => {
      resolveNavigation = resolve
    }))
    const { result, rerender } = renderHook(
      ({ projectId }) => useBrowserCaptureSession({ projectId, open: true }),
      { initialProps: { projectId: 'project-a' } },
    )
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalledWith('session-project-a', 'project-a'))

    let pending!: Promise<void>
    act(() => {
      pending = result.current.navigate('reload')
    })
    rerender({ projectId: 'project-b' })
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalledWith('session-project-b', 'project-b'))

    await act(async () => {
      resolveNavigation({ url: 'https://stale-a.test', title: 'Stale A' })
      await pending
    })
    expect(result.current.url).not.toBe('https://stale-a.test')
    expect(result.current.title).not.toBe('Stale A')
  })

  it('keeps opener metadata separate and does not revive a popup from a late navigation response', async () => {
    let finish!: (value: object) => void
    browser.navigateBrowser.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const socket = fakeSocket()
    browser.openBrowserWs.mockReturnValue(socket)
    const { result } = renderHook(() => useBrowserCaptureSession({ projectId: 'p1', open: true }))
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalled())
    control(socket, { type: 'nav', url: 'https://app.test', title: 'Application' })
    control(socket, { type: 'popup', count: 1, active: true, url: 'https://login.test' })
    let pending!: Promise<void>
    act(() => { pending = result.current.navigate('reload') })
    control(socket, { type: 'popup', count: 0, active: false })
    await act(async () => { finish({ url: 'https://login.test/callback', title: 'Login', target: 'popup' }); await pending })
    expect(result.current).toMatchObject({ url: 'https://app.test', title: 'Application', popup: null })

    browser.navigateBrowser.mockResolvedValue({ url: 'https://app.test/signed-in', title: 'Signed in' })
    await act(async () => { await result.current.navigate('reload') })
    expect(result.current).toMatchObject({ url: 'https://app.test/signed-in', title: 'Signed in' })
  })

  it('waits for authoritative popup state even after a successful switch response', async () => {
    let finish!: () => void
    browser.setBrowserPopupView.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    const socket = fakeSocket()
    browser.openBrowserWs.mockReturnValue(socket)
    const { result } = renderHook(() => useBrowserCaptureSession({ projectId: 'p1', open: true }))
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalled())
    control(socket, { type: 'popup', count: 1, active: true, url: 'https://login.test' })
    let pending!: Promise<void>
    act(() => { pending = result.current.setPopupView('root') })
    expect(result.current.popup?.active).toBe(true)
    await act(async () => { finish(); await pending })
    expect(result.current.popup?.active).toBe(true)
    control(socket, { type: 'popup', count: 1, active: false, url: 'https://login.test' })
    expect(result.current.popup?.active).toBe(false)
  })

  it('keeps the login visible and usable when switching fails, then clears the recoverable error on retry', async () => {
    browser.setBrowserPopupView.mockRejectedValueOnce(new Error('Network failed'))
    const socket = fakeSocket()
    browser.openBrowserWs.mockReturnValue(socket)
    const { result } = renderHook(() => useBrowserCaptureSession({ projectId: 'p1', open: true }))
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalled())
    control(socket, { type: 'ready' })
    control(socket, { type: 'popup', count: 1, active: true, url: 'https://login.test' })
    await act(async () => { await result.current.setPopupView('root') })
    expect(result.current).toMatchObject({ status: 'ready', popup: { active: true }, popupError: 'Connection error' })
    await act(async () => { await result.current.setPopupView('root') })
    expect(result.current.popupError).toBeNull()
    expect(result.current.popup?.active).toBe(true)
    control(socket, { type: 'popup', count: 1, active: false, url: 'https://login.test' })
    expect(result.current.popup?.active).toBe(false)
  })

  it('ignores a late failed switch after the popup has self-closed', async () => {
    let fail!: (error: Error) => void
    browser.setBrowserPopupView.mockReturnValue(new Promise<void>((_, reject) => { fail = reject }))
    const socket = fakeSocket()
    browser.openBrowserWs.mockReturnValue(socket)
    const { result } = renderHook(() => useBrowserCaptureSession({ projectId: 'p1', open: true }))
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalled())
    control(socket, { type: 'popup', count: 1, active: true, url: 'https://login.test' })
    let pending!: Promise<void>
    act(() => { pending = result.current.setPopupView('root') })
    control(socket, { type: 'popup', count: 0, active: false })
    await act(async () => { fail(new Error('late failure')); await pending })
    expect(result.current).toMatchObject({ popup: null, popupError: null })
  })

  it('ignores a late failed switch after its owning session is replaced', async () => {
    let fail!: (error: Error) => void
    browser.setBrowserPopupView.mockReturnValue(new Promise<void>((_, reject) => { fail = reject }))
    const { result, rerender } = renderHook(({ projectId }) => useBrowserCaptureSession({ projectId, open: true }), { initialProps: { projectId: 'p1' } })
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalledTimes(1))
    let pending!: Promise<void>
    act(() => { pending = result.current.setPopupView('root') })
    rerender({ projectId: 'p2' })
    await waitFor(() => expect(browser.openBrowserWs).toHaveBeenCalledTimes(2))
    await act(async () => { fail(new Error('late failure')); await pending })
    expect(result.current.popupError).toBeNull()
  })
})
