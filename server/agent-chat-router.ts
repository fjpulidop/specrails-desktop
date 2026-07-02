import fs from 'fs'
import multer from 'multer'
import { Router, type Request, type Response, type NextFunction } from 'express'
import type { DbInstance } from './db'
import type { AgentChatManager } from './agent-chat-manager'
import { getAdapter } from './providers'
import { normalizeLevel } from './agent-tier'
import { attachmentManager, isSupportedUploadedFile } from './attachment-manager'
import {
  createAgentConversation,
  listAgentConversations,
  getAgentConversation,
  updateAgentConversation,
  deleteAgentConversation,
  listAgentMessages,
} from './agent-store'

// ─── Agent chat REST surface (/api/agent) ─────────────────────────────────────
//
// App-level (NOT per-project) routes for the global agent chat. Gated by
// SPECRAILS_AGENT_CHAT (default on, opt-out). Conversations are app-global; a
// `send` is fire-and-forget (202) — the turn streams over the `agent_*` WS events.

export interface AgentRouterDeps {
  manager: AgentChatManager
  desktopDb: DbInstance
}

export function isAgentChatEnabled(): boolean {
  return process.env.SPECRAILS_AGENT_CHAT !== 'false'
}

function validProvider(provider: unknown): string | null {
  if (typeof provider !== 'string' || !provider) return null
  try {
    getAdapter(provider)
    return provider
  } catch {
    return null
  }
}

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (isSupportedUploadedFile({ mimetype: file.mimetype, originalname: file.originalname })) {
      cb(null, true)
    } else {
      ;(req as unknown as { fileRejected?: string }).fileRejected = file.mimetype || file.originalname || 'unknown'
      cb(null, false)
    }
  },
})

export function createAgentChatRouter(deps: AgentRouterDeps): Router {
  const { manager, desktopDb } = deps
  const router = Router()

  // Feature gate: 404 the whole surface when disabled.
  router.use((_req, res, next) => {
    if (!isAgentChatEnabled()) {
      res.status(404).json({ error: 'Agent chat is disabled' })
      return
    }
    next()
  })

  // Per-provider model catalog for the header model selector.
  router.get('/models', (req: Request, res: Response) => {
    const provider = validProvider(req.query.provider) ?? 'claude'
    const adapter = getAdapter(provider)
    res.json({
      provider,
      models: adapter.modelCatalog(),
      // The composer gates the image affordance on this (design D22: capability,
      // never provider id — gemini stays false until live-verified).
      supportsImageInput: adapter.capabilities.supportsImageInput === true,
      // Per-provider reasoning-effort tiers (ascending). Empty ⇒ no selector
      // (gemini has no per-spawn knob).
      efforts: adapter.capabilities.reasoningEfforts ?? [],
    })
  })

  /** Validate a requested reasoning effort against a provider's catalog. */
  const validEffort = (provider: string, value: unknown): string | null | undefined => {
    if (value === null) return null
    if (typeof value !== 'string') return undefined
    const efforts = getAdapter(provider).capabilities.reasoningEfforts ?? []
    return (efforts as readonly string[]).includes(value) ? value : undefined
  }

  router.get('/conversations', (_req: Request, res: Response) => {
    res.json({ conversations: listAgentConversations(desktopDb) })
  })

  router.post('/conversations', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    let provider = 'claude'
    if (body.provider !== undefined) {
      const v = validProvider(body.provider)
      if (!v) {
        res.status(400).json({ error: 'Unknown or unavailable provider' })
        return
      }
      provider = v
    }
    const conversation = createAgentConversation(desktopDb, {
      provider,
      model: typeof body.model === 'string' ? body.model : null,
      pinnedProjectId: typeof body.pinnedProjectId === 'string' ? body.pinnedProjectId : null,
      tierLevel: body.tierLevel !== undefined ? normalizeLevel(body.tierLevel) : 0,
      // Off-catalog values fall back to null (= app default "medium").
      reasoningEffort: validEffort(provider, body.reasoningEffort) ?? null,
    })
    res.status(201).json({ conversation })
  })

  router.get('/conversations/:id', (req: Request, res: Response) => {
    const conversation = getAgentConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'Unknown conversation' })
      return
    }
    res.json({ conversation, messages: listAgentMessages(desktopDb, conversation.id) })
  })

  router.patch('/conversations/:id', (req: Request, res: Response) => {
    const conversation = getAgentConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'Unknown conversation' })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if (body.title !== undefined) patch.title = typeof body.title === 'string' ? body.title : null
    if (body.pinnedProjectId !== undefined) {
      patch.pinned_project_id = typeof body.pinnedProjectId === 'string' ? body.pinnedProjectId : null
    }
    if (body.tierLevel !== undefined) patch.tier_level = normalizeLevel(body.tierLevel)
    if (body.provider !== undefined) {
      const v = validProvider(body.provider)
      if (!v) {
        res.status(400).json({ error: 'Unknown or unavailable provider' })
        return
      }
      patch.provider = v
      // Switching provider invalidates the stored session id, model AND effort
      // (all belong to the previous provider) — clear them so the next turn
      // starts fresh with the new provider's defaults (codex rejects claude's
      // "sonnet"; claude's "xhigh" is off-catalog for codex; resume of a
      // foreign thread → "no rollout found").
      if (v !== conversation.provider) {
        patch.session_id = null
        patch.model = null
        patch.reasoning_effort = null
      }
    }
    // Explicit model pick — validated against the (new or current) provider's catalog.
    if (body.model !== undefined && patch.model === undefined) {
      if (body.model === null) {
        patch.model = null
      } else if (typeof body.model === 'string') {
        const effectiveProvider = (patch.provider as string | undefined) ?? conversation.provider
        const valid = new Set(getAdapter(effectiveProvider).modelCatalog().map((m) => m.value))
        if (!valid.has(body.model)) {
          res.status(400).json({ error: 'Model not available for this provider' })
          return
        }
        patch.model = body.model
      }
    }
    // Explicit effort pick — validated against the (new or current) provider's
    // effort catalog; null resets to the app default ("medium").
    if (body.reasoningEffort !== undefined && patch.reasoning_effort === undefined) {
      const effectiveProvider = (patch.provider as string | undefined) ?? conversation.provider
      const v = validEffort(effectiveProvider, body.reasoningEffort)
      if (v === undefined) {
        res.status(400).json({ error: 'Effort not available for this provider' })
        return
      }
      patch.reasoning_effort = v
    }
    res.json({ conversation: updateAgentConversation(desktopDb, conversation.id, patch) })
  })

  router.delete('/conversations/:id', (req: Request, res: Response) => {
    const id = String(req.params.id)
    manager.abort(id)
    deleteAgentConversation(desktopDb, id)
    // Cascade-remove the conversation's attachment directory (best-effort).
    void attachmentManager.deleteAllAgent(id).catch((e) =>
      console.error('[agent-chat] attachment cleanup failed:', e),
    )
    res.json({ ok: true })
  })

  // ── Attachments (conversation-keyed; mirror the ticket attachment routes) ──
  router.post(
    '/conversations/:id/attachments',
    attachmentUpload.single('file'),
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
      const id = String(req.params.id)
      if (!getAgentConversation(desktopDb, id)) {
        res.status(404).json({ error: 'Unknown conversation' })
        return
      }
      const file = (req as unknown as { file?: { buffer: Buffer; originalname: string; mimetype: string; size: number } }).file
      if (!file) {
        const rejected = (req as unknown as { fileRejected?: string }).fileRejected
        res.status(400).json({ error: rejected ? `Unsupported file type: ${rejected}` : 'No file uploaded' })
        return
      }
      try {
        const attachment = await attachmentManager.uploadAgent({
          conversationId: id,
          file: { buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype, size: file.size },
        })
        res.status(201).json({ attachment })
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500
        console.error('[agent-chat] attachment upload error:', e)
        res.status(status).json({ error: e instanceof Error ? e.message : 'Upload failed' })
      }
    },
  )

  router.get('/conversations/:id/attachments', (req: Request, res: Response) => {
    const id = String(req.params.id)
    if (!getAgentConversation(desktopDb, id)) {
      res.status(404).json({ error: 'Unknown conversation' })
      return
    }
    res.json({ attachments: attachmentManager.listAgent(id) })
  })

  router.get('/conversations/:id/attachments/:attachmentId', (req: Request, res: Response) => {
    const id = String(req.params.id)
    if (!getAgentConversation(desktopDb, id)) {
      res.status(404).json({ error: 'Unknown conversation' })
      return
    }
    const attachmentId = String(req.params.attachmentId)
    let meta: ReturnType<typeof attachmentManager.getAgentMeta> = null
    let abs: string | null = null
    try {
      meta = attachmentManager.getAgentMeta(id, attachmentId)
      abs = meta ? attachmentManager.getAgentFilePath(id, attachmentId) : null
    } catch {
      res.status(400).json({ error: 'Invalid attachment id' })
      return
    }
    if (!meta || !abs) {
      res.status(404).json({ error: 'Attachment not found' })
      return
    }
    res.setHeader('Content-Type', meta.mimeType)
    const asciiName = meta.filename.replace(/[\r\n"]/g, '_')
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
    )
    // The existsSync check above is not atomic with the stream's async open — a
    // concurrent conversation/attachment DELETE can rm the file in between, and an
    // unhandled ReadStream 'error' would take down the sidecar.
    const stream = fs.createReadStream(abs)
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: 'Attachment not found' })
      else res.destroy()
    })
    stream.pipe(res)
  })

  router.delete('/conversations/:id/attachments/:attachmentId', async (req: Request, res: Response) => {
    const id = String(req.params.id)
    if (!getAgentConversation(desktopDb, id)) {
      res.status(404).json({ error: 'Unknown conversation' })
      return
    }
    try {
      const ok = await attachmentManager.deleteAgent(id, String(req.params.attachmentId))
      if (!ok) {
        res.status(404).json({ error: 'Attachment not found' })
        return
      }
      res.status(204).end()
    } catch (e) {
      console.error('[agent-chat] attachment delete error:', e)
      res.status(400).json({ error: 'Delete failed' })
    }
  })

  router.post('/conversations/:id/send', (req: Request, res: Response) => {
    const conversation = getAgentConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'Unknown conversation' })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) {
      res.status(400).json({ error: 'text is required' })
      return
    }
    const tierLevel = body.tierLevel !== undefined ? normalizeLevel(body.tierLevel) : undefined
    const model = typeof body.model === 'string' ? body.model : undefined
    let attachmentIds: string[] = []
    const rawAtt = body.attachments
    if (rawAtt && typeof rawAtt === 'object' && Array.isArray((rawAtt as { ids?: unknown }).ids)) {
      attachmentIds = ((rawAtt as { ids: unknown[] }).ids).filter((x): x is string => typeof x === 'string')
    }
    // Fire-and-forget: the turn streams over WS. Persist the chosen tier first so
    // a refresh mid-turn restores the right level.
    if (tierLevel !== undefined) updateAgentConversation(desktopDb, conversation.id, { tier_level: tierLevel })
    void manager.sendMessage(conversation.id, text, { tierLevel, model, attachmentIds }).catch((e) =>
      console.error('[agent-chat] send failed:', e),
    )
    res.status(202).json({ accepted: true })
  })

  router.post('/conversations/:id/abort', (req: Request, res: Response) => {
    const aborted = manager.abort(String(req.params.id))
    res.json({ aborted })
  })

  return router
}
