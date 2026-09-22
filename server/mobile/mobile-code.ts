import { Router } from 'express'
import type { MobileUpstream } from './mobile-missions'
import { redact } from './mobile-redact'

const id = /^[A-Za-z0-9_-]{1,160}$/
export function relativeCodePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/^[\\/]|^[A-Za-z]:|[\x00-\x1f\\]/.test(value)
    && !value.split('/').some(part => part === '..' || part === '.' || part === '')
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Project ACL/auth run on the parent router. Desktop remains authoritative for
 * repository membership, realpath confinement, deny-list and gitignore rules.
 * Only this explicit source DTO preserves source text verbatim: applying the
 * generic absolute-path scrubber to code would silently corrupt its contents.
 */
export function createMobileCodeRouter(upstream: MobileUpstream): Router {
  const router = Router()
  for (const operation of ['tree', 'find', 'file'] as const) {
    router.get(`/projects/:pid/repositories/:rid/code/${operation}`, async (req, res) => {
      const pid = req.params.pid as string, rid = req.params.rid as string
      if (!id.test(pid) || !id.test(rid)) { res.status(400).json({ error: 'Invalid parameter' }); return }
      const query = new URLSearchParams()
      if (operation === 'tree') {
        query.set('filter', 'all'); query.set('limit', '200')
        if (req.query.cursor !== undefined) {
          if (typeof req.query.cursor !== 'string' || req.query.cursor.length > 4096) { res.status(400).json({ error: 'Invalid cursor' }); return }
          query.set('cursor', req.query.cursor)
        }
      } else if (operation === 'find') {
        if (typeof req.query.q !== 'string' || !req.query.q.trim() || req.query.q.length > 256) { res.status(400).json({ error: 'Invalid query' }); return }
        query.set('q', req.query.q); query.set('limit', '50')
      } else {
        if (!relativeCodePath(req.query.path)) { res.status(400).json({ error: 'Invalid relative path' }); return }
        query.set('path', req.query.path)
        for (const key of ['startLine', 'startColumn'] as const) {
          const value = req.query[key] ?? '1'
          if (typeof value !== 'string' || !/^[1-9]\d{0,8}$/.test(value)) { res.status(400).json({ error: 'Invalid range' }); return }
          query.set(key, value)
        }
        query.set('endLine', String(Number(query.get('startLine')) + 199))
        if (req.query.expectedHash !== undefined) {
          if (typeof req.query.expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(req.query.expectedHash)) { res.status(400).json({ error: 'Invalid hash' }); return }
          query.set('expectedHash', req.query.expectedHash)
        }
      }
      try {
        const response = await upstream('GET', `/api/projects/${encodeURIComponent(pid)}/repositories/${encodeURIComponent(rid)}/code/${operation}?${query}`)
        if (response.status < 200 || response.status >= 300) { res.status(response.status).json(redact(response.json)); return }
        const data = record(response.json)
        if (operation === 'file') {
          if (!relativeCodePath(data.path) || data.path !== req.query.path || typeof data.content !== 'string') { res.status(502).json({ error: 'Invalid source response' }); return }
          res.json({ relativePath: data.path, content: data.content, language: data.language,
            fileHash: data.fileHash, startLine: data.startLine, startColumn: data.startColumn,
            endLine: data.endLine, totalLines: data.totalLines, nextLine: data.nextLine, nextColumn: data.nextColumn })
        } else {
          const rows = data[operation === 'tree' ? 'entries' : 'matches']
          res.json({ entries: (Array.isArray(rows) ? rows : []).map(record).filter(row => relativeCodePath(row.path)).map(row => ({
            relativePath: row.path, kind: row.kind === 'dir' ? 'dir' : 'file', sizeBytes: row.sizeBytes,
          })), nextCursor: operation === 'tree' ? data.nextCursor : null, truncated: data.truncated === true })
        }
      } catch { res.status(502).json({ error: 'Code explorer unavailable' }) }
    })
  }
  return router
}
