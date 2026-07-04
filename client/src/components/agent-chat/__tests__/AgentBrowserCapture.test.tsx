import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
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

const uploadAgentAttachment = vi.fn()
vi.mock('../../../lib/agent-api', () => ({
  uploadAgentAttachment: (...a: unknown[]) => uploadAgentAttachment(...a),
}))

// Capture the modal props so the test can drive onCaptured directly.
let modalProps: { onCaptured: (r: CaptureResult) => void } | null = null
vi.mock('../../browser-capture/BrowserCaptureModal', () => ({
  BrowserCaptureModal: (props: { onCaptured: (r: CaptureResult) => void }) => {
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
  })

  it('decodes the capture WITHOUT fetch() and uploads it as an agent attachment', async () => {
    // The regression this guards: fetch(dataUrl) is CSP-blocked in the packaged
    // app (connect-src has no data:), so the decode must never touch fetch.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const att = { id: 'att-1', filename: 'capture.png' }
    uploadAgentAttachment.mockResolvedValue(att)

    render(<AgentBrowserCapture projectId="p1" conversationId="c1" />)
    modalProps!.onCaptured(captureResult())

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

  it('shows an error and skips the upload when there is no conversation', async () => {
    render(<AgentBrowserCapture projectId="p1" conversationId={null} />)
    modalProps!.onCaptured(captureResult())
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(uploadAgentAttachment).not.toHaveBeenCalled()
    expect(closeBrowser).not.toHaveBeenCalled()
  })

  it('surfaces upload failures with the raw cause as description', async () => {
    uploadAgentAttachment.mockRejectedValue(new Error('boom'))
    render(<AgentBrowserCapture projectId="p1" conversationId="c1" />)
    modalProps!.onCaptured(captureResult())
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][1]).toMatchObject({ description: 'boom' })
    expect(queueCapture).not.toHaveBeenCalled()
    expect(closeBrowser).not.toHaveBeenCalled()
  })
})
