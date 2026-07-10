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
})

describe('useBrowserCaptureSession ownership and teardown', () => {
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
})
