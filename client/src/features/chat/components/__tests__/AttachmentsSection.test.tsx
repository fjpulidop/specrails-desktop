import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../test-utils'
import { AttachmentsSection } from '../AttachmentsSection'
import type { Attachment } from '../../../../types'

vi.mock('../../lib/attachments', () => ({
  listAttachments: vi.fn(async () => []),
  deleteAttachment: vi.fn(async () => {}),
  attachmentFileUrl: vi.fn((_key: string, id: string) => `/files/${id}`),
}))

vi.mock('../AttachmentPreviewLightbox', () => ({
  AttachmentPreviewLightbox: ({ attachment, onClose }: { attachment: { filename: string } | null; onClose: () => void }) =>
    attachment ? (
      <div data-testid="lightbox">
        <span>{attachment.filename}</span>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null,
}))

import { listAttachments, deleteAttachment } from '../../lib/attachments'

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    filename: 'photo.png',
    storedName: 'uuid-photo.png',
    mimeType: 'image/png',
    size: 1024,
    addedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('AttachmentsSection', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(listAttachments).mockResolvedValue([])
    vi.mocked(deleteAttachment).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing when attachments is empty and server returns empty', async () => {
    const { container } = render(
      <AttachmentsSection ticketKey="1" attachments={[]} />,
    )
    await waitFor(() => expect(vi.mocked(listAttachments)).toHaveBeenCalled())
    expect(container.querySelector('[data-testid]')).toBeNull()
  })

  it('renders attachment rows when attachments provided', async () => {
    const att = makeAttachment()
    vi.mocked(listAttachments).mockResolvedValue([att])
    render(<AttachmentsSection ticketKey="1" attachments={[att]} />)
    await waitFor(() => expect(screen.getByText('photo.png')).toBeInTheDocument())
  })

  it('shows remove button per attachment', async () => {
    const att = makeAttachment()
    vi.mocked(listAttachments).mockResolvedValue([att])
    const onChange = vi.fn()
    render(<AttachmentsSection ticketKey="1" attachments={[att]} onChange={onChange} />)
    await waitFor(() => screen.getByText('photo.png'))
    expect(screen.getByRole('button', { name: /remove photo\.png/i })).toBeInTheDocument()
  })

  it('calls deleteAttachment and onChange when remove clicked', async () => {
    vi.useFakeTimers()
    const att = makeAttachment()
    vi.mocked(listAttachments).mockResolvedValue([att])
    const onChange = vi.fn()
    render(<AttachmentsSection ticketKey="1" attachments={[att]} onChange={onChange} />)
    await vi.runAllTimersAsync()
    fireEvent.click(screen.getByRole('button', { name: /remove photo\.png/i }))
    await vi.runAllTimersAsync()
    expect(vi.mocked(deleteAttachment)).toHaveBeenCalledWith('1', 'att-1')
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('calls onChange when server returns extra attachments (merge)', async () => {
    const att = makeAttachment()
    const att2 = makeAttachment({ id: 'att-2', filename: 'doc.pdf', mimeType: 'application/pdf' })
    vi.mocked(listAttachments).mockResolvedValue([att, att2])
    const onChange = vi.fn()
    render(<AttachmentsSection ticketKey="1" attachments={[att]} onChange={onChange} />)
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const merged: Attachment[] = onChange.mock.calls[0][0]
    expect(merged.map((a) => a.id)).toContain('att-2')
    expect(merged.filter((a) => a.id === 'att-1')).toHaveLength(1)
  })

  it('opens lightbox when Open button clicked', async () => {
    const att = makeAttachment()
    vi.mocked(listAttachments).mockResolvedValue([att])
    render(<AttachmentsSection ticketKey="1" attachments={[att]} />)
    await waitFor(() => screen.getByText('photo.png'))
    fireEvent.click(screen.getAllByRole('button', { name: /open/i })[0])
    expect(screen.getByTestId('lightbox')).toBeInTheDocument()
  })

  it('closes lightbox when close called', async () => {
    const att = makeAttachment()
    vi.mocked(listAttachments).mockResolvedValue([att])
    render(<AttachmentsSection ticketKey="1" attachments={[att]} />)
    await waitFor(() => screen.getByText('photo.png'))
    fireEvent.click(screen.getAllByRole('button', { name: /open/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(screen.queryByTestId('lightbox')).not.toBeInTheDocument()
  })
})
