import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../test-utils'
import { AttachmentPreviewLightbox } from '../AttachmentPreviewLightbox'
import type { Attachment } from '../../../../types'
import { fetchAttachmentBlob } from '../../lib/attachments'

vi.mock('../../lib/attachments', () => ({
  fetchAttachmentBlob: vi.fn(),
}))

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

describe('AttachmentPreviewLightbox', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:attachment'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    vi.mocked(fetchAttachmentBlob).mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
  })

  it('renders nothing when attachment is null', () => {
    const { container } = render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={null} onClose={onClose} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders dialog with filename when attachment provided', () => {
    render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={makeAttachment()} onClose={onClose} />,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('photo.png')).toBeInTheDocument()
  })

  it('renders image for image mime type', async () => {
    render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={makeAttachment({ mimeType: 'image/png' })} onClose={onClose} />,
    )
    expect(await screen.findByRole('img')).toBeInTheDocument()
  })

  it('renders iframe for pdf mime type', async () => {
    const { container } = render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={makeAttachment({ mimeType: 'application/pdf', filename: 'doc.pdf' })} onClose={onClose} />,
    )
    await waitFor(() => expect(container.querySelector('iframe')).toBeInTheDocument())
  })

  it('renders download fallback for unknown mime type', async () => {
    render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={makeAttachment({ mimeType: 'application/zip', filename: 'file.zip' })} onClose={onClose} />,
    )
    expect(await screen.findByText(/preview not available/i)).toBeInTheDocument()
  })

  it('calls onClose when Back button clicked', () => {
    render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={makeAttachment()} onClose={onClose} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on Escape keydown', () => {
    render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={makeAttachment()} onClose={onClose} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close when clicking inside the top bar', () => {
    render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={makeAttachment()} onClose={onClose} />,
    )
    const topBar = screen.getByRole('button', { name: /back/i }).closest('div')!
    fireEvent.click(topBar)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when clicking the overlay backdrop', () => {
    render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={makeAttachment()} onClose={onClose} />,
    )
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close when clicking the image', async () => {
    render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={makeAttachment({ mimeType: 'image/png' })} onClose={onClose} />,
    )
    fireEvent.click(await screen.findByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not close when clicking the download link in top bar', () => {
    render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={makeAttachment()} onClose={onClose} />,
    )
    fireEvent.click(screen.getByRole('link', { name: /download/i }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not propagate click from iframe to dialog backdrop', async () => {
    const { container } = render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={makeAttachment({ mimeType: 'application/pdf', filename: 'doc.pdf' })} onClose={onClose} />,
    )
    await waitFor(() => expect(container.querySelector('iframe')).toBeInTheDocument())
    const iframe = container.querySelector('iframe')!
    fireEvent.click(iframe)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not close when clicking inside the fallback download div', async () => {
    render(
      <AttachmentPreviewLightbox ticketKey="1" attachment={makeAttachment({ mimeType: 'application/zip', filename: 'file.zip' })} onClose={onClose} />,
    )
    const fallback = (await screen.findByText(/preview not available/i)).closest('div')!
    fireEvent.click(fallback)
    expect(onClose).not.toHaveBeenCalled()
  })
})
