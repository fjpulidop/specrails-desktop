import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { CaptureResult } from '../../../lib/browser-capture'

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}))

const closeBrowser = vi.fn()
const queueCapture = vi.fn()
vi.mock('../../../context/AgentWorkspaceContext', () => ({
  useAgentWorkspace: () => ({ closeBrowser, queueCapture }),
}))

const materializeDraftConversation = vi.fn()
vi.mock('../../../context/AgentChatContext', () => ({
  useAgentChat: () => ({ materializeDraftConversation }),
}))

const uploadAgentAttachment = vi.fn()
vi.mock('../../../lib/agent-api', () => ({
  uploadAgentAttachment: (...a: unknown[]) => uploadAgentAttachment(...a),
}))

const nativeAvailable = vi.fn()
vi.mock('../../../lib/native-browser', () => ({
  isNativeBrowserCaptureAvailable: () => nativeAvailable(),
  normalizeAddress: (value: string) => value || null,
}))

let nativeProps: {
  url: string
  onCaptured: (result: { screenshotDataUrl: string }) => Promise<void>
  onFallback: () => void
  onUrlChange: (url: string) => void
} | null = null
vi.mock('../../browser-capture/NativeBrowserPane', () => ({
  NativeBrowserModal: (props: NonNullable<typeof nativeProps>) => {
    nativeProps = props
    return <div data-testid="native-browser-fixture" />
  },
}))

// Capture the modal props so the test can drive onCaptured directly.
let modalProps: { onCaptured: (r: CaptureResult) => Promise<void> } | null = null
vi.mock('../../browser-capture/BrowserCaptureModal', () => ({
  BrowserCaptureModal: (props: { onCaptured: (r: CaptureResult) => Promise<void> }) => {
    modalProps = props
    return null
  },
}))

import { AgentBrowserCapture } from '../AgentBrowserCapture'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function captureResult(): CaptureResult {
  return { screenshotDataUrl: `data:image/png;base64,${PNG_B64}` } as CaptureResult
}

describe('AgentBrowserCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    modalProps = null
    nativeProps = null
    nativeAvailable.mockResolvedValue(false)
  })

  it('decodes the capture WITHOUT fetch() and uploads it as an agent attachment', async () => {
    // The regression this guards: fetch(dataUrl) is CSP-blocked in the packaged
    // app (connect-src has no data:), so the decode must never touch fetch.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const att = { id: 'att-1', filename: 'capture.png' }
    uploadAgentAttachment.mockResolvedValue(att)

    render(<AgentBrowserCapture projectId="p1" conversationId="c1" />)
    await waitFor(() => expect(modalProps).not.toBeNull())
    await modalProps!.onCaptured(captureResult())

    await waitFor(() => expect(uploadAgentAttachment).toHaveBeenCalledTimes(1))
    expect(fetchSpy).not.toHaveBeenCalled()
    const [convId, file] = uploadAgentAttachment.mock.calls[0] as [string, File]
    expect(convId).toBe('c1')
    expect(file).toBeInstanceOf(File)
    expect(file.type).toBe('image/png')
    expect(file.name).toMatch(/^capture-\d+\.png$/)
    expect(queueCapture).toHaveBeenCalledWith(att)
    expect(toastSuccess).toHaveBeenCalled()
    expect(closeBrowser).toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('materializes the draft mission when capturing with no conversation yet', async () => {
    // Empty compose screen: the capture itself starts the mission (same
    // contract as attaching a file there) — never an error toast.
    const att = { id: 'att-2', filename: 'capture.png' }
    uploadAgentAttachment.mockResolvedValue(att)
    materializeDraftConversation.mockResolvedValue({ id: 'c-new' })

    render(<AgentBrowserCapture projectId="p1" conversationId={null} />)
    await waitFor(() => expect(modalProps).not.toBeNull())
    await modalProps!.onCaptured(captureResult())

    await waitFor(() => expect(uploadAgentAttachment).toHaveBeenCalledTimes(1))
    expect(materializeDraftConversation).toHaveBeenCalledTimes(1)
    expect(uploadAgentAttachment.mock.calls[0][0]).toBe('c-new')
    expect(queueCapture).toHaveBeenCalledWith(att)
    expect(closeBrowser).toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('does not materialize when a conversation is already active', async () => {
    const att = { id: 'att-3', filename: 'capture.png' }
    uploadAgentAttachment.mockResolvedValue(att)
    render(<AgentBrowserCapture projectId="p1" conversationId="c1" />)
    await waitFor(() => expect(modalProps).not.toBeNull())
    await modalProps!.onCaptured(captureResult())
    await waitFor(() => expect(uploadAgentAttachment).toHaveBeenCalledTimes(1))
    expect(materializeDraftConversation).not.toHaveBeenCalled()
  })

  it('surfaces a materialization failure as an upload error', async () => {
    materializeDraftConversation.mockRejectedValue(new Error('offline'))
    render(<AgentBrowserCapture projectId="p1" conversationId={null} />)
    await waitFor(() => expect(modalProps).not.toBeNull())
    await expect(modalProps!.onCaptured(captureResult())).rejects.toThrow('offline')
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(uploadAgentAttachment).not.toHaveBeenCalled()
    expect(closeBrowser).not.toHaveBeenCalled()
  })

  it('surfaces upload failures with the raw cause as description', async () => {
    uploadAgentAttachment.mockRejectedValue(new Error('boom'))
    render(<AgentBrowserCapture projectId="p1" conversationId="c1" />)
    await waitFor(() => expect(modalProps).not.toBeNull())
    await expect(modalProps!.onCaptured(captureResult())).rejects.toThrow('boom')
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][1]).toMatchObject({ description: 'boom' })
    expect(queueCapture).not.toHaveBeenCalled()
    expect(closeBrowser).not.toHaveBeenCalled()

    const attachment = { id: 'retry-att', filename: 'capture.png' }
    uploadAgentAttachment.mockResolvedValue(attachment)
    await modalProps!.onCaptured(captureResult())
    expect(queueCapture).toHaveBeenCalledExactlyOnceWith(attachment)
    expect(closeBrowser).toHaveBeenCalledTimes(1)
  })

  it('uses native capture in missions without mounting the screencast session and remembers the project URL', async () => {
    nativeAvailable.mockResolvedValue(true)
    localStorage.setItem('specrails-desktop:agent-browser-url:p1', 'http://localhost:5173/')
    render(<AgentBrowserCapture projectId="p1" conversationId="c1" />)
    await screen.findByTestId('native-browser-fixture')
    expect(modalProps).toBeNull()
    expect(nativeProps!.url).toBe('http://localhost:5173/')
    nativeProps!.onUrlChange('http://localhost:5173/settings')
    expect(localStorage.getItem('specrails-desktop:agent-browser-url:p1')).toBe('http://localhost:5173/settings')
    nativeProps!.onUrlChange('about:blank')
    expect(localStorage.getItem('specrails-desktop:agent-browser-url:p1')).toBe('http://localhost:5173/settings')
  })

  it('uploads the native snapshot through the same mission attachment flow', async () => {
    nativeAvailable.mockResolvedValue(true)
    const attachment = { id: 'native-att', filename: 'capture.png' }
    uploadAgentAttachment.mockResolvedValue(attachment)
    render(<AgentBrowserCapture projectId="p1" conversationId="c1" />)
    await screen.findByTestId('native-browser-fixture')
    await act(async () => { await nativeProps!.onCaptured(captureResult()) })
    expect(uploadAgentAttachment).toHaveBeenCalledExactlyOnceWith('c1', expect.any(File))
    expect(queueCapture).toHaveBeenCalledWith(attachment)
    expect(closeBrowser).toHaveBeenCalledTimes(1)
    expect(modalProps).toBeNull()
  })

  it('propagates native upload errors so the annotation preview can retain the image for retry', async () => {
    nativeAvailable.mockResolvedValue(true)
    uploadAgentAttachment.mockRejectedValue(new Error('offline'))
    render(<AgentBrowserCapture projectId="p1" conversationId="c1" />)
    await screen.findByTestId('native-browser-fixture')
    await expect(nativeProps!.onCaptured(captureResult())).rejects.toThrow('offline')
    expect(screen.getByTestId('native-browser-fixture')).toBeInTheDocument()
    expect(modalProps).toBeNull()
    expect(closeBrowser).not.toHaveBeenCalled()
    expect(queueCapture).not.toHaveBeenCalled()
  })

  it('falls back only when native opening fails, keeping advanced capture available', async () => {
    nativeAvailable.mockResolvedValue(true)
    render(<AgentBrowserCapture projectId="p1" conversationId="c1" />)
    await screen.findByTestId('native-browser-fixture')
    act(() => { nativeProps!.onFallback() })
    await waitFor(() => expect(modalProps).not.toBeNull())
    expect(screen.queryByTestId('native-browser-fixture')).not.toBeInTheDocument()
  })
})
