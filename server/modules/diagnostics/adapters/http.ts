/**
 * `/api/diagnostics/*` (mounted behind the desktop token):
 * - `POST /report` builds a redacted problem-report preview and keeps it in memory;
 * - `GET /report/:id/zip` returns exactly the previewed files as a ZIP;
 * - `GET /crashes` lists crashes not explained yet; `POST /crashes/ack` marks them seen;
 * - `GET /stalls` returns the event-loop stall snapshot.
 * Nothing here uploads anything: the ZIP goes back to the local client only.
 */
import express, { type Router } from 'express'
import { buildZip } from '../../../util/zip'
import type { CrashNotices, ProblemReports } from '../application'
import type { StallSnapshot } from '../domain'

export function createDiagnosticsRouter(deps: { reports: ProblemReports; crashes: CrashNotices; stalls: () => StallSnapshot }): Router {
  const router = express.Router()
  router.post('/report', async (_req, res) => {
    try {
      const preview = await deps.reports.preview()
      res.json({
        id: preview.id,
        createdAtMs: preview.createdAtMs,
        fileName: preview.fileName,
        files: preview.files.map(file => ({ ...file, bytes: Buffer.byteLength(file.content, 'utf8') })),
      })
    } catch (error) {
      console.error('[diagnostics] report preview failed:', error)
      res.status(500).json({ error: 'report_failed', message: 'The problem report could not be built.' })
    }
  })
  router.get('/report/:id/zip', (req, res) => {
    const preview = deps.reports.get(String(req.params.id))
    if (!preview) {
      res.status(404).json({ error: 'report_expired', message: 'This report preview expired. Build it again.' })
      return
    }
    const zip = buildZip(preview.files.map(file => ({ name: file.name, data: Buffer.from(file.content, 'utf8') })))
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${preview.fileName}"`)
    res.setHeader('Cache-Control', 'no-store')
    res.end(zip)
  })
  router.get('/crashes', (_req, res) => {
    res.json(deps.crashes.list())
  })
  router.post('/crashes/ack', (req, res) => {
    try {
      res.json(deps.crashes.acknowledge((req.body as { throughMs?: unknown } | undefined)?.throughMs))
    } catch (error) {
      console.error('[diagnostics] crash acknowledgement failed:', error)
      res.status(500).json({ error: 'ack_failed' })
    }
  })
  router.get('/stalls', (_req, res) => {
    res.json(deps.stalls())
  })
  return router
}
