import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/agent-api')>()
  return {
    ...actual,
    fetchAgentAttachmentBlob: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'image/png' })),
  }
})

import { AgentReplyAttachments } from '../AgentMessage'

const EARTH = { id: 'img-1', filename: 'exec-1.png', mimeType: 'image/png', size: 2048 }
const REPORT = { id: 'f-1', filename: 'report.pdf', mimeType: 'application/pdf', size: 4096 }

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:earth') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})
afterEach(cleanup)

describe('AgentReplyAttachments (images the agent generated)', () => {
  it('shows generated images inline and opens them in the lightbox', async () => {
    const user = userEvent.setup()
    render(<AgentReplyAttachments conversationId="c1" attachments={[EARTH] as never} />)
    await waitFor(() => expect(screen.getByRole('img', { name: 'exec-1.png' }).getAttribute('src')).toBe('blob:earth'))
    await user.click(screen.getByRole('button', { name: /exec-1\.png/ }))
    expect((await screen.findByRole('dialog')).getAttribute('data-dialog-layer')).toBe('media')
  })

  it('keeps other files as chips and renders nothing without attachments', () => {
    const { container, rerender } = render(<AgentReplyAttachments conversationId="c1" attachments={[REPORT] as never} />)
    expect(screen.queryByTestId('agent-reply-images')).toBeNull()
    expect(screen.getByRole('button', { name: /report\.pdf/ })).toBeTruthy()
    rerender(<AgentReplyAttachments conversationId="c1" attachments={[]} />)
    expect(container.innerHTML).toBe('')
  })
})
