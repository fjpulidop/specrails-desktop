// Merge preview of the project's pending deliveries (runtime/merge-preview.ts):
// conflicts with the current base, how far the base moved, and siblings that
// collide. Read-only Git (merge-tree in a scratch object store); results are
// cached by commit sha, so clients simply refetch after `rail.pr_state`,
// job events or `rail.merge_preview`.
import type { Router, Request, Response } from 'express'
import { computeMergePreviews } from './merge-preview'
import { mergeTreeSupported } from './merge-preview-git'
import { projectContextOf } from './rails-http-shared'

export function registerRailMergePreviewRoutes(router: Router): void {
  // GET /rails/merge-preview[?deliveryId=<id>]
  router.get('/merge-preview', async (req: Request, res: Response) => {
    const c = projectContextOf(req)
    const deliveryId = typeof req.query.deliveryId === 'string' && req.query.deliveryId ? req.query.deliveryId : null
    try {
      const [supported, previews] = await Promise.all([
        mergeTreeSupported(),
        computeMergePreviews({ project: c.project, db: c.db }, deliveryId ? { only: new Set([deliveryId]) } : {}),
      ])
      res.json({ supported, previews })
    } catch (err) {
      res.status(500).json({ error: 'merge_preview_failed', detail: err instanceof Error ? err.message : String(err) })
    }
  })
}
