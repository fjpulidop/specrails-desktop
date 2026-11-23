// Ticket attachment routes: upload (multer, 25 MB cap, readable-text opt-in),
// list, download, delete one and delete all. A ticket key is a numeric id or
// the UUID pendingSpecId used before the spec exists; storage and extraction
// live in attachment-manager.

import fs from 'fs'
import type { Request, Response, NextFunction } from 'express'
import { readStore } from './modules/specs/runtime/ticket-store'
import multer from 'multer'
import { attachmentManager, isSupportedUploadedFile } from './attachment-manager'
import type { ProjectRoutesDeps } from './project-router-helpers'

export function registerTicketAttachmentRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx, ticketPath } = deps

  // ─── Ticket attachments ─────────────────────────────────────────────────────

  const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
    fileFilter: (req, file, cb) => {
      // Explore conversations opt in to the readable-text rule, which needs the
      // buffer; the content check happens in attachmentManager.upload().
      if (
        req.query.readableText === '1' ||
        isSupportedUploadedFile({ mimetype: file.mimetype, originalname: file.originalname })
      ) {
        cb(null, true)
      } else {
        // Record what was rejected so the route can return a clear error instead
        // of the ambiguous "No file uploaded or file type unsupported".
        ;(req as unknown as { fileRejected?: string }).fileRejected = file.mimetype || file.originalname || 'unknown'
        cb(null, false)
      }
    },
  })

  /** A ticket key is either a numeric real id or a UUID (pendingSpecId). */
  function parseTicketKey(raw: string): { key: string; isPending: boolean } | null {
    if (/^\d+$/.test(raw)) return { key: raw, isPending: false }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      return { key: raw, isPending: true }
    }
    return null
  }

  router.post(
    '/:projectId/tickets/:ticketId/attachments',
    attachmentUpload.single('file'),
    // Translate multer's own errors (which bypass the handler via next(err)) into
    // a clear 400 instead of the generic 500 from the global error handler. The
    // 25 MB cap is the common case (a big screenshot/PDF).
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 25 MB)' : `Upload rejected: ${err.code}`
        res.status(400).json({ error: msg })
        return
      }
      if (err) { next(err); return }
      next()
    },
    async (req: Request, res: Response) => {
      const parsed = parseTicketKey(req.params.ticketId as string)
      if (!parsed) {
        res.status(400).json({ error: 'Invalid ticketId (must be numeric id or UUID)' })
        return
      }
      const file = (req as unknown as { file?: Express.Multer.File }).file
      if (!file) {
        const rejected = (req as unknown as { fileRejected?: string }).fileRejected
        res.status(400).json({ error: rejected ? `Unsupported file type: ${rejected}` : 'No file uploaded' })
        return
      }
      if (!parsed.isPending) {
        const store = readStore(ticketPath(req))
        if (!store.tickets[parsed.key]) {
          res.status(404).json({ error: 'Ticket not found' })
          return
        }
      }
      try {
        const attachment = await attachmentManager.upload({
          slug: ctx(req).project.slug,
          ticketKey: parsed.key,
          ticketStorePath: parsed.isPending ? null : ticketPath(req),
          allowReadableText: parsed.isPending && req.query.readableText === '1',
          file: {
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
          },
        })
        res.status(201).json({ attachment })
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500
        const message = err instanceof Error ? err.message : 'Upload failed'
        console.error('[project-router] attachment upload error:', err)
        res.status(status).json({ error: message })
      }
    },
  )

  router.get('/:projectId/tickets/:ticketId/attachments', (req: Request, res: Response) => {
    const parsed = parseTicketKey(req.params.ticketId as string)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid ticketId' })
      return
    }
    const attachments = attachmentManager.list(ctx(req).project.slug, parsed.key)
    res.json({ attachments })
  })

  router.get('/:projectId/tickets/:ticketId/attachments/:attachmentId', (req: Request, res: Response) => {
    const parsed = parseTicketKey(req.params.ticketId as string)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid ticketId' })
      return
    }
    const attachmentId = req.params.attachmentId as string
    const slug = ctx(req).project.slug
    const meta = attachmentManager.getMeta(slug, parsed.key, attachmentId)
    const abs = meta ? attachmentManager.getFilePath(slug, parsed.key, attachmentId) : null
    if (!meta || !abs) {
      res.status(404).json({ error: 'Attachment not found' })
      return
    }
    res.setHeader('Content-Type', meta.mimeType)
    // Strip quotes AND CR/LF: a newline in the stored (raw) original filename
    // makes Node's setHeader throw ERR_INVALID_CHAR after Content-Type is
    // already set, 500-ing the download. Also emit an RFC 5987 filename* so
    // non-ASCII names survive.
    const asciiName = meta.filename.replace(/[\r\n"]/g, '_')
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
    )
    // The exists check above is not atomic with the stream's async open — a
    // concurrent attachment DELETE can rm the file in between, and an unhandled
    // ReadStream 'error' would take down the sidecar.
    const stream = fs.createReadStream(abs)
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: 'Attachment not found' })
      else res.destroy()
    })
    stream.pipe(res)
  })

  router.delete('/:projectId/tickets/:ticketId/attachments/:attachmentId', async (req: Request, res: Response) => {
    const parsed = parseTicketKey(req.params.ticketId as string)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid ticketId' })
      return
    }
    const attachmentId = req.params.attachmentId as string
    try {
      const ok = await attachmentManager.delete({
        slug: ctx(req).project.slug,
        ticketKey: parsed.key,
        attachmentId,
        ticketStorePath: parsed.isPending ? null : ticketPath(req),
      })
      if (!ok) {
        res.status(404).json({ error: 'Attachment not found' })
        return
      }
      res.status(204).end()
    } catch (err) {
      console.error('[project-router] attachment delete error:', err)
      res.status(500).json({ error: 'Delete failed' })
    }
  })

  router.delete('/:projectId/tickets/:ticketId/attachments', async (req: Request, res: Response) => {
    const parsed = parseTicketKey(req.params.ticketId as string)
    if (!parsed) {
      res.status(400).json({ error: 'Invalid ticketId' })
      return
    }
    try {
      await attachmentManager.deleteAll(ctx(req).project.slug, parsed.key)
      res.status(204).end()
    } catch (err) {
      console.error('[project-router] attachment bulk delete error:', err)
      res.status(500).json({ error: 'Bulk delete failed' })
    }
  })
}
