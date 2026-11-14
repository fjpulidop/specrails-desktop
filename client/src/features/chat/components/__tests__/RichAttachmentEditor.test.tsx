import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../../../test-utils'
import { RichAttachmentEditor } from '../RichAttachmentEditor'
import { uploadAttachment } from '../../lib/attachments'

vi.mock('../../lib/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/attachments')>()),
  uploadAttachment: vi.fn(),
}))

describe('RichAttachmentEditor — height bounds', () => {
  it('caps the editor height and scrolls instead of growing without bound', () => {
    // Regression: pasting a very large text grew the contenteditable off-screen
    // with no vertical scroll because no maxHeight was set.
    render(<RichAttachmentEditor ticketKey="t1" ariaLabel="Composer" />)
    const box = screen.getByRole('textbox')
    expect(box.style.overflow).toBe('auto')
    expect(box.style.maxHeight).toBe('320px') // default cap
    expect(box.style.minHeight).toBe('120px') // default floor
  })

  it('honours a custom maxHeight/minHeight', () => {
    render(<RichAttachmentEditor ticketKey="t2" ariaLabel="Composer" minHeight={72} maxHeight={200} />)
    const box = screen.getByRole('textbox')
    expect(box.style.minHeight).toBe('72px')
    expect(box.style.maxHeight).toBe('200px')
    expect(box.style.overflow).toBe('auto')
  })
})

describe('RichAttachmentEditor — acceptAnyFile', () => {
  const attachmentFor = (filename: string) => ({
    id: `id-${filename}`, filename, storedName: filename, mimeType: 'text/plain', size: 1, addedAt: '',
  })

  function fileInput(container: HTMLElement): HTMLInputElement {
    return container.querySelector('input[type="file"]') as HTMLInputElement
  }

  beforeEach(() => {
    vi.mocked(uploadAttachment).mockReset()
  })

  it('omits the accept attribute so the picker shows every file', () => {
    const { container } = render(<RichAttachmentEditor ticketKey="t1" acceptAnyFile />)
    expect(fileInput(container).hasAttribute('accept')).toBe(false)
  })

  it('uploads a .md file and a no-type .log file with the readable-text option', async () => {
    vi.mocked(uploadAttachment).mockImplementation(async (_key, file) => attachmentFor(file.name))
    const onUnsupportedFile = vi.fn()
    const { container } = render(
      <RichAttachmentEditor ticketKey="t1" acceptAnyFile onUnsupportedFile={onUnsupportedFile} />,
    )
    const md = new File(['# hi'], 'notes.md', { type: 'text/markdown' })
    const log = new File(['line'], 'server.log', { type: '' })

    fireEvent.change(fileInput(container), { target: { files: [md, log] } })

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(2))
    expect(uploadAttachment).toHaveBeenCalledWith('t1', md, undefined, { readableText: true })
    expect(uploadAttachment).toHaveBeenCalledWith('t1', log, undefined, { readableText: true })
    expect(onUnsupportedFile).not.toHaveBeenCalled()
  })

  it('reports a refusal with the server message and still uploads the other file', async () => {
    const reason = '"a.zip" is not a text file and cannot be attached'
    vi.mocked(uploadAttachment).mockImplementation(async (_key, file) => {
      if (file.name === 'a.zip') throw new Error(reason)
      return attachmentFor(file.name)
    })
    const onUploadError = vi.fn()
    const onAttachmentAdded = vi.fn()
    const { container } = render(
      <RichAttachmentEditor
        ticketKey="t1"
        acceptAnyFile
        onUploadError={onUploadError}
        onAttachmentAdded={onAttachmentAdded}
      />,
    )
    const zip = new File(['x'], 'a.zip', { type: 'application/zip' })
    const md = new File(['# hi'], 'notes.md', { type: 'text/markdown' })

    fireEvent.change(fileInput(container), { target: { files: [zip, md] } })

    await waitFor(() => expect(onAttachmentAdded).toHaveBeenCalledWith(attachmentFor('notes.md')))
    expect(onUploadError).toHaveBeenCalledTimes(1)
    expect(onUploadError.mock.calls[0][0].message).toBe(reason)
    expect(onUploadError.mock.calls[0][1]).toBe(zip)
  })

  it('keeps the accept filter and the unsupported gate without the prop', async () => {
    const onUnsupportedFile = vi.fn()
    const { container } = render(<RichAttachmentEditor ticketKey="t1" onUnsupportedFile={onUnsupportedFile} />)
    expect(fileInput(container).getAttribute('accept')).toContain('image/png')
    const zip = new File(['x'], 'a.zip', { type: 'application/zip' })

    fireEvent.change(fileInput(container), { target: { files: [zip] } })

    await waitFor(() => expect(onUnsupportedFile).toHaveBeenCalledWith(zip))
    expect(uploadAttachment).not.toHaveBeenCalled()
  })
})
