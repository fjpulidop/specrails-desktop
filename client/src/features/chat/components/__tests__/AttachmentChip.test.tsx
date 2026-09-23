import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '../../../../test-utils'
import { AttachmentChip } from '../AttachmentChip'
import type { Attachment } from '../../../../types'

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    filename: 'photo.png',
    storedName: 'uuid-photo.png',
    mimeType: 'image/png',
    size: 2048,
    addedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('AttachmentChip', () => {
  it('renders filename', () => {
    render(<AttachmentChip attachment={makeAttachment()} />)
    expect(screen.getByText('photo.png')).toBeInTheDocument()
  })

  it('renders uploading name when uploading prop set', () => {
    render(<AttachmentChip uploading={{ name: 'upload.csv' }} />)
    expect(screen.getByText('upload.csv')).toBeInTheDocument()
    expect(screen.getByText('Uploading…')).toBeInTheDocument()
  })

  it('shows formatted byte size for attachment', () => {
    render(<AttachmentChip attachment={makeAttachment({ size: 512 })} />)
    expect(screen.getByText('512 B')).toBeInTheDocument()
  })

  it('shows KB for files over 1024 bytes', () => {
    render(<AttachmentChip attachment={makeAttachment({ size: 2048 })} />)
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
  })

  it('shows MB for large files', () => {
    render(<AttachmentChip attachment={makeAttachment({ size: 2 * 1024 * 1024 })} />)
    expect(screen.getByText('2.0 MB')).toBeInTheDocument()
  })

  it('renders remove button when onRemove provided', () => {
    render(<AttachmentChip attachment={makeAttachment()} onRemove={vi.fn()} />)
    expect(screen.getByRole('button', { name: /remove photo\.png/i })).toBeInTheDocument()
  })

  it('does not render remove button when no onRemove', () => {
    render(<AttachmentChip attachment={makeAttachment()} />)
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument()
  })

  it('calls onRemove after animation delay on remove click', async () => {
    vi.useFakeTimers()
    const onRemove = vi.fn()
    render(<AttachmentChip attachment={makeAttachment()} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    expect(onRemove).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(onRemove).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('calls onClick when chip is clicked', () => {
    const onClick = vi.fn()
    render(<AttachmentChip attachment={makeAttachment()} onClick={onClick} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('calls onClick on Enter keydown', () => {
    const onClick = vi.fn()
    render(<AttachmentChip attachment={makeAttachment()} onClick={onClick} />)
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' })
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('shows image icon for image mime types', () => {
    const { container } = render(<AttachmentChip attachment={makeAttachment({ mimeType: 'image/jpeg' })} />)
    expect(container.textContent).toContain('🖼')
  })

  it('shows pdf icon for application/pdf', () => {
    const { container } = render(<AttachmentChip attachment={makeAttachment({ mimeType: 'application/pdf', filename: 'doc.pdf' })} />)
    expect(container.textContent).toContain('📄')
  })

  it('shows spreadsheet icon for csv', () => {
    const { container } = render(<AttachmentChip attachment={makeAttachment({ mimeType: 'text/csv', filename: 'data.csv' })} />)
    expect(container.textContent).toContain('📊')
  })

  it('shows json icon for application/json', () => {
    const { container } = render(<AttachmentChip attachment={makeAttachment({ mimeType: 'application/json', filename: 'data.json' })} />)
    expect(container.textContent).toContain('{ }')
  })

  it('shows text icon for text/plain', () => {
    const { container } = render(<AttachmentChip attachment={makeAttachment({ mimeType: 'text/plain', filename: 'notes.txt' })} />)
    expect(container.textContent).toContain('📝')
  })

  it('shows text icon for sql mime types', () => {
    const { container } = render(<AttachmentChip attachment={makeAttachment({ mimeType: 'application/sql', filename: 'schema.sql' })} />)
    expect(container.textContent).toContain('📝')
  })

  it('shows fallback icon for unknown mime type', () => {
    const { container } = render(<AttachmentChip attachment={makeAttachment({ mimeType: 'application/octet-stream', filename: 'file.bin' })} />)
    expect(container.textContent).toContain('📎')
  })
})
