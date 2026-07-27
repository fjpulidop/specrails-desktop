import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { AgentAttachment } from '../../../lib/agent-api'

const fetchAgentAttachmentBlob = vi.fn()
vi.mock('../../../lib/agent-api', () => ({
  fetchAgentAttachmentBlob: (...a: unknown[]) => fetchAgentAttachmentBlob(...a),
}))

import { AgentComposerAttachmentChip } from '../AgentComposerAttachmentChip'

const image = { id: 'att-1', filename: 'capture-1.png', mimeType: 'image/png', size: 10 } as AgentAttachment
const doc = { id: 'att-2', filename: 'notes.pdf', mimeType: 'application/pdf', size: 10 } as AgentAttachment

// jsdom's URL has no object-URL statics — install file-scoped fakes. They stay
// for the whole file so React-Testing-Library's auto-cleanup (which unmounts
// AFTER user afterEach hooks) can still run the revoke effect.
const createObjectURL = vi.fn(() => 'blob:preview-1')
const revokeObjectURL = vi.fn()
;(URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL = createObjectURL
;(URL as unknown as { revokeObjectURL: typeof revokeObjectURL }).revokeObjectURL = revokeObjectURL

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AgentComposerAttachmentChip', () => {
  it('renders an image attachment as a THUMBNAIL fetched through the authenticated API', async () => {
    fetchAgentAttachmentBlob.mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
    const onRemove = vi.fn()
    render(<AgentComposerAttachmentChip conversationId="c1" attachment={image} removeLabel="Remove" onRemove={onRemove} />)

    expect(screen.getByTestId('composer-attachment-thumb')).toBeInTheDocument()
    const img = await screen.findByAltText('capture-1.png')
    expect(img).toHaveAttribute('src', 'blob:preview-1')
    expect(fetchAgentAttachmentBlob).toHaveBeenCalledWith('c1', 'att-1')

    fireEvent.click(screen.getByLabelText('Remove'))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('revokes the object URL on unmount', async () => {
    fetchAgentAttachmentBlob.mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
    const { unmount } = render(
      <AgentComposerAttachmentChip conversationId="c1" attachment={image} removeLabel="Remove" onRemove={() => {}} />,
    )
    await screen.findByAltText('capture-1.png')
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
  })

  it('falls back to the paperclip pill for non-image attachments', () => {
    const onRemove = vi.fn()
    render(<AgentComposerAttachmentChip conversationId="c1" attachment={doc} removeLabel="Remove" onRemove={onRemove} />)
    expect(screen.getByTestId('composer-attachment-pill')).toBeInTheDocument()
    expect(screen.getByText('notes.pdf')).toBeInTheDocument()
    expect(fetchAgentAttachmentBlob).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Remove'))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('falls back to the pill when the preview fetch fails', async () => {
    fetchAgentAttachmentBlob.mockRejectedValue(new Error('gone'))
    render(<AgentComposerAttachmentChip conversationId="c1" attachment={image} removeLabel="Remove" onRemove={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('composer-attachment-pill')).toBeInTheDocument())
  })

  it('renders the pill when no conversation id is available (no fetchable preview)', () => {
    render(<AgentComposerAttachmentChip conversationId={null} attachment={image} removeLabel="Remove" onRemove={() => {}} />)
    expect(screen.getByTestId('composer-attachment-pill')).toBeInTheDocument()
    expect(fetchAgentAttachmentBlob).not.toHaveBeenCalled()
  })
})
