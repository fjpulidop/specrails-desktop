import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api', () => ({ getApiBase: () => '/api/projects/proj-1' }))

import {
  ATTACHMENT_ACCEPT_MIME,
  attachmentFileUrl,
  deleteAllAttachments,
  deleteAttachment,
  fetchAttachmentBlob,
  isSupportedAttachmentFile,
  listAttachments,
  uploadAttachment,
} from '../attachments'

describe('attachments lib', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe('uploadAttachment', () => {
    it('POSTs to the attachments endpoint and returns attachment', async () => {
      const att = { id: 'a1', filename: 'x.txt', storedName: 'u-x.txt', mimeType: 'text/plain', size: 5, addedAt: '' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ attachment: att }),
      })
      const file = new File(['hello'], 'x.txt', { type: 'text/plain' })
      const result = await uploadAttachment('1', file)
      expect(result).toEqual(att)
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-1/tickets/1/attachments',
        expect.objectContaining({ method: 'POST' }),
      )
    })

    it('throws on non-ok response with error body', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Unsupported file type' }),
      })
      const file = new File([''], 'v.mp4', { type: 'video/mp4' })
      await expect(uploadAttachment('1', file)).rejects.toThrow('Unsupported file type')
    })

    it('throws with status code when error body parse fails', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => { throw new Error('bad json') },
      })
      const file = new File([''], 'f.txt', { type: 'text/plain' })
      await expect(uploadAttachment('1', file)).rejects.toThrow('Upload failed (500)')
    })
  })

  describe('deleteAttachment', () => {
    it('DELETEs the attachment endpoint', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 204 })
      await deleteAttachment('1', 'att-1')
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-1/tickets/1/attachments/att-1',
        expect.objectContaining({ method: 'DELETE' }),
      )
    })

    it('ignores 404 responses', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 404 })
      await expect(deleteAttachment('1', 'att-1')).resolves.toBeUndefined()
    })

    it('throws for non-404 errors', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 })
      await expect(deleteAttachment('1', 'att-1')).rejects.toThrow('Delete failed (500)')
    })
  })

  describe('deleteAllAttachments', () => {
    it('DELETEs the ticket attachments collection', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 204 })
      await deleteAllAttachments('1')
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-1/tickets/1/attachments',
        expect.objectContaining({ method: 'DELETE' }),
      )
    })

    it('ignores 404', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 404 })
      await expect(deleteAllAttachments('1')).resolves.toBeUndefined()
    })

    it('throws for other errors', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 })
      await expect(deleteAllAttachments('1')).rejects.toThrow('Bulk delete failed (500)')
    })
  })

  describe('listAttachments', () => {
    it('GETs the attachments list', async () => {
      const atts = [{ id: 'a1', filename: 'x.txt', storedName: 'u-x.txt', mimeType: 'text/plain', size: 5, addedAt: '' }]
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ attachments: atts }),
      })
      const result = await listAttachments('1')
      expect(result).toEqual(atts)
    })

    it('throws on error', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 })
      await expect(listAttachments('1')).rejects.toThrow('List failed (500)')
    })
  })

  describe('attachmentFileUrl', () => {
    it('returns the authenticated attachment endpoint URL', () => {
      const url = attachmentFileUrl('1', 'att-1')
      expect(url).toBe('/api/projects/proj-1/tickets/1/attachments/att-1')
    })
  })

  describe('fetchAttachmentBlob', () => {
    it('fetches an attachment as a blob', async () => {
      const blob = new Blob(['hello'], { type: 'text/plain' })
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        blob: async () => blob,
      })
      await expect(fetchAttachmentBlob('1', 'att-1')).resolves.toBe(blob)
      expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj-1/tickets/1/attachments/att-1')
    })

    it('throws on non-ok attachment fetch', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 401 })
      await expect(fetchAttachmentBlob('1', 'att-1')).rejects.toThrow('Fetch failed (401)')
    })
  })

  describe('isSupportedAttachmentFile', () => {
    it('accepts .sql files even when the browser provides no mime type', () => {
      const file = new File(['select 1;'], 'schema.sql')
      expect(isSupportedAttachmentFile(file)).toBe(true)
    })

    it('accepts SQL mime types explicitly listed in the picker accept string', () => {
      const file = new File(['select 1;'], 'schema.sql', { type: 'application/sql' })
      expect(ATTACHMENT_ACCEPT_MIME).toContain('.sql')
      expect(ATTACHMENT_ACCEPT_MIME).toContain('application/sql')
      expect(isSupportedAttachmentFile(file)).toBe(true)
    })

    it('rejects unsupported non-sql files', () => {
      const file = new File([''], 'video.mp4', { type: 'video/mp4' })
      expect(isSupportedAttachmentFile(file)).toBe(false)
    })

    it('accepts a PNG with an empty mime type (drag source / OS quirk)', () => {
      const file = new File([''], 'screenshot.png', { type: '' })
      expect(isSupportedAttachmentFile(file)).toBe(true)
    })

    it('accepts a PNG reported with the legacy image/x-png mime (Windows)', () => {
      const file = new File([''], 'shot.PNG', { type: 'image/x-png' })
      expect(isSupportedAttachmentFile(file)).toBe(true)
    })

    it('accepts jpg/jpeg/gif/webp by extension even with no mime', () => {
      for (const name of ['a.jpg', 'b.jpeg', 'c.gif', 'd.webp']) {
        expect(isSupportedAttachmentFile(new File([''], name, { type: '' }))).toBe(true)
      }
    })
  })
})
