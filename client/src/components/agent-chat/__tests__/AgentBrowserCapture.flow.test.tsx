import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  native: false, close: vi.fn(), queue: vi.fn(), upload: vi.fn(), capture: vi.fn(),
  uploadPending: vi.fn(), hide: vi.fn(), pick: vi.fn(), open: vi.fn(),
  canvasRef: { current: null as HTMLCanvasElement | null },
}))
vi.mock('../../../context/AgentWorkspaceContext', () => ({
  useAgentWorkspace: () => ({ closeBrowser: fixture.close, queueCapture: fixture.queue, setBrowserUrl: vi.fn(), browserOwnerId: 'owner', browserUrl: 'https://fixture.test' }),
}))
vi.mock('../../../context/AgentChatContext', () => ({ useAgentChat: () => ({ materializeDraftConversation: vi.fn() }) }))
vi.mock('../../../lib/agent-api', () => ({ uploadAgentAttachment: fixture.upload }))
vi.mock('../../../lib/browser-capture', async original => ({
  ...await original<typeof import('../../../lib/browser-capture')>(), uploadCaptureImage: fixture.uploadPending,
}))
vi.mock('../../../lib/native-browser', async original => ({
  ...await original<typeof import('../../../lib/native-browser')>(),
  isNativeBrowserCaptureAvailable: async () => fixture.native,
  nativeBrowser: {
    onEvent: async () => () => {}, open: fixture.open, close: async () => {},
    setBounds: async () => {}, setSelectMode: async () => {},
    selection: fixture.pick, capture: fixture.capture, hide: fixture.hide,
  },
}))
vi.mock('../../browser-capture/useBrowserCaptureSession', () => ({
  useBrowserCaptureSession: () => ({
    canvasRef: fixture.canvasRef, viewport: { width: 1000, height: 800 },
    status: 'ready', errorMsg: null, url: 'https://fixture.test', title: 'Fixture',
    hoverRect: null, hoverPath: null, popup: null, popupError: null,
    setViewport() {}, clearHover() {}, probe() {}, forwardInput() {},
    capture: fixture.capture, captureBreakpoints: fixture.capture,
  }),
}))

import { AgentBrowserCapture } from '../AgentBrowserCapture'

const original = 'data:image/png;base64,b3JpZ2luYWw='
const annotated = 'data:image/png;base64,YW5ub3RhdGVk'

beforeEach(() => {
  vi.clearAllMocks()
  fixture.native = false
  fixture.capture.mockResolvedValue({ screenshotDataUrl: original, screenshot: { id: 'raw' }, domAttachment: { id: 'dom' } })
  fixture.uploadPending.mockResolvedValue({ id: 'annotated-pending' })
  fixture.upload.mockResolvedValue({ id: 'mission-image', filename: 'annotated.png' })
  fixture.pick.mockResolvedValue({ selector: '#picked', tagName: 'DIV', rect: { x: 20, y: 30, width: 200, height: 100 } })
  fixture.open.mockResolvedValue(undefined)
  fixture.hide.mockResolvedValue(undefined)
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 800 } as DOMRect)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {}, fillRect() {}, fillStyle: '' } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(annotated)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('mission browser capture → annotation → attachment', () => {
  it.each(['region', 'all-sizes', 'native'] as const)('only queues the annotated image after confirmation (%s)', async (engine) => {
    fixture.native = engine === 'native'
    render(<AgentBrowserCapture projectId="fixture-project" conversationId="fixture-conversation" />)
    if (engine === 'native') {
      const select = await screen.findByRole('button', { name: 'Select to add to mission' })
      await waitFor(() => expect(select).toBeEnabled())
      fireEvent.click(select)
    } else {
      const select = await screen.findByTestId('browser-select-toggle')
      if (engine === 'all-sizes') fireEvent.click(screen.getByRole('button', { name: 'Capture at all screen sizes' }))
      fireEvent.click(select)
      const layer = fixture.canvasRef.current!.nextElementSibling!
      fireEvent.pointerDown(layer, { clientX: 30, clientY: 40, pointerId: 1 })
      fireEvent.pointerUp(layer, { clientX: 330, clientY: 240, pointerId: 1 })
    }
    await screen.findByTestId('annotation-confirm')
    expect(fixture.upload).not.toHaveBeenCalled()
    expect(fixture.queue).not.toHaveBeenCalled()
    expect(fixture.close).not.toHaveBeenCalled()
    const image = screen.getByRole('img') as HTMLImageElement
    Object.defineProperties(image, { naturalWidth: { value: 2000 }, naturalHeight: { value: 1600 } })
    fireEvent.load(image)
    fireEvent.click(screen.getByRole('button', { name: 'Redact (B)' }))
    const layer = image.parentElement!.querySelector('svg')!
    fireEvent.pointerDown(layer, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(layer, { clientX: 300, clientY: 250, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 300, clientY: 250, pointerId: 1 })
    fireEvent.click(screen.getByTestId('annotation-confirm'))
    await waitFor(() => expect(fixture.queue).toHaveBeenCalledExactlyOnceWith({ id: 'mission-image', filename: 'annotated.png' }))
    expect(fixture.upload).toHaveBeenCalledTimes(1)
    const [conversation, file] = fixture.upload.mock.calls[0] as [string, File]
    expect(conversation).toBe('fixture-conversation')
    expect(file.size).toBe(atob(annotated.split(',')[1]).length)
    expect(file.type).toBe('image/png')
    expect(fixture.close).toHaveBeenCalled()
    if (engine === 'native') expect(fixture.hide).toHaveBeenCalledWith('owner')
  })
})
