import type { Request, Response, Router } from 'express'
import type { AgentAuditExport, AgentAuditService } from '../application'
import { parseAgentAuditFormat, type AgentAuditFormat } from '../domain'

function send(res: Response, exported: AgentAuditExport, format: AgentAuditFormat, name: string): void {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'agent-actions'
  res.setHeader('Content-Type', exported.contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.${format}"`)
  res.setHeader('X-Agent-Actions-Rows', String(exported.rows))
  res.send(exported.body)
}

function isoOrNull(value: unknown): string | null | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/**
 * Inbound adapter for the audit exports:
 *  - `GET /:projectId/jobs/:runId/audit?format=jsonl|csv` — one run (job or loop run).
 *  - `GET /:projectId/agent-actions?format=jsonl|csv&from=&to=` — project-wide window.
 * Pending batched rows are flushed first so an export reflects every recorded action.
 */
export function registerAgentAuditHttp(router: Router, serviceForRequest: (request: Request) => AgentAuditService): void {
  router.get('/:projectId/jobs/:runId/audit', (req, res) => {
    const format = parseAgentAuditFormat(req.query.format)
    if (!format) { res.status(400).json({ error: 'Invalid format. Must be jsonl or csv' }); return }
    try {
      const runId = String(req.params.runId)
      send(res, serviceForRequest(req).exportRun(runId, format), format, `agent-actions-${runId}`)
    } catch (error) {
      console.error('[agent-audit] run export failed:', error)
      res.status(500).json({ error: 'Failed to export agent actions' })
    }
  })
  router.get('/:projectId/agent-actions', (req, res) => {
    const format = parseAgentAuditFormat(req.query.format)
    if (!format) { res.status(400).json({ error: 'Invalid format. Must be jsonl or csv' }); return }
    const from = isoOrNull(req.query.from)
    const to = isoOrNull(req.query.to)
    if (from === null || to === null) { res.status(400).json({ error: 'from and to must be ISO timestamps' }); return }
    if (from && to && from > to) { res.status(400).json({ error: 'from must not be after to' }); return }
    try {
      send(res, serviceForRequest(req).exportWindow({ ...(from ? { from } : {}), ...(to ? { to } : {}) }, format), format, 'agent-actions')
    } catch (error) {
      console.error('[agent-audit] project export failed:', error)
      res.status(500).json({ error: 'Failed to export agent actions' })
    }
  })
}
