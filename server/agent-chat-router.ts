import fs from 'fs'
import multer from 'multer'
import { Router, type Request, type Response, type NextFunction } from 'express'
import type { DbInstance } from './db'
import type { AgentChatManager, AgentContextReference } from './agent-chat-manager'
import {
  getAdapter,
  isModelAvailableForAdapter,
  reasoningEffortsForModel,
} from './providers'
import { normalizeLevel } from './agent-tier'
import { attachmentManager, isSupportedUploadedFile } from './attachment-manager'
import {
  createAgentConversation,
  listAgentConversations,
  getAgentConversation,
  updateAgentConversation,
  deleteAgentConversation,
  listAgentMessages,
  searchAgentConversations,
  MISSION_SEARCH_DEFAULT_LIMIT,
  MISSION_SEARCH_MAX_LIMIT,
} from './agent-store'
import { killBackgroundProcessesForChat, purgeBackgroundProcessHistory } from './transient-children'
import { decorateAgentInputMessages, getAgentInput, AgentInputConflictError, AgentInputLimitError } from './agent-input-store'

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

const CONTEXT_KINDS = new Set(['project', 'spec', 'job', 'trace', 'conversation', 'file', 'alias', 'pr', 'action'])

function cleanContextString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/[\r\n"]/g, ' ').trim().slice(0, max)
  return clean || null
}

function cleanContextMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const clean: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 16)) {
    const safeKey = cleanContextString(key, 80)
    if (!safeKey) continue
    if (raw === null || typeof raw === 'number' || typeof raw === 'boolean') {
      clean[safeKey] = raw
    } else if (typeof raw === 'string') {
      const safeValue = cleanContextString(raw, 500)
      if (safeValue !== null) clean[safeKey] = safeValue
    } else if (Array.isArray(raw)) {
      clean[safeKey] = raw
        .slice(0, 16)
        .map((item) => (
          typeof item === 'string' ? cleanContextString(item, 240) :
          typeof item === 'number' || typeof item === 'boolean' || item === null ? item :
          undefined
        ))
        .filter((item) => item !== undefined)
    }
  }
  return Object.keys(clean).length ? clean : undefined
}

function sanitizeContextRefs(value: unknown): AgentContextReference[] {
  if (!Array.isArray(value)) return []
  const refs: AgentContextReference[] = []
  for (const raw of value.slice(0, 16)) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const kind = cleanContextString(row.kind, 40)
    const id = cleanContextString(row.id, 160)
    const label = cleanContextString(row.label, 220)
    const token = cleanContextString(row.token, 120)
    if (!kind || !CONTEXT_KINDS.has(kind) || !id || !label || !token) continue
    const scopeRaw = row.scope && typeof row.scope === 'object' ? row.scope as Record<string, unknown> : null
    const projectId = cleanContextString(scopeRaw?.projectId, 160)
    const projectName = cleanContextString(scopeRaw?.projectName, 180)
    const repositoryId = cleanContextString(scopeRaw?.repositoryId, 160)
    const repositoryName = cleanContextString(scopeRaw?.repositoryName, 180)
    const status = cleanContextString(row.status, 80)
    refs.push({
      kind,
      id,
      label,
      token,
      scope: projectId || projectName || repositoryId || repositoryName ? { projectId, projectName, repositoryId, repositoryName } : undefined,
      status,
      metadata: cleanContextMetadata(row.metadata),
    })
  }
  return refs
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
    const requestedModel = isModelAvailableForAdapter(adapter, req.query.model)
      ? req.query.model
      : null
    const model = requestedModel ?? adapter.defaultModel()
    res.json({
      provider,
      model,
      models: adapter.modelCatalog(),
      customModelAliases: adapter.capabilities.customModelAliases === true,
      // The composer gates the image affordance on this (design D22: capability,
      // never provider id — gemini stays false until live-verified).
      supportsImageInput: adapter.capabilities.supportsImageInput === true,
      // Per-provider reasoning-effort tiers (ascending). Empty ⇒ no selector
      // (gemini has no per-spawn knob).
      efforts: reasoningEffortsForModel(adapter, model),
    })
  })

  /** Validate a requested effort against the effective model's exact catalog. */
  const validEffort = (
    provider: string,
    model: string,
    value: unknown,
  ): string | null | undefined => {
    if (value === null) return null
    if (typeof value !== 'string') return undefined
    const efforts = reasoningEffortsForModel(getAdapter(provider), model)
    return (efforts as readonly string[]).includes(value) ? value : undefined
  }

  router.get('/conversations', (_req: Request, res: Response) => {
    res.json({ conversations: listAgentConversations(desktopDb) })
  })

  // Mission search (search-missions-in-palette): title + user/assistant content,
  // one row per conversation, title hits first. Blank `q` is a client bug → 400.
  router.get('/search', (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (!q) {
      res.status(400).json({ error: 'q is required' })
      return
    }
    const rawLimit = Number(req.query.limit)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(MISSION_SEARCH_MAX_LIMIT, Math.floor(rawLimit))
      : MISSION_SEARCH_DEFAULT_LIMIT
    res.json({ results: searchAgentConversations(desktopDb, q, limit) })
  })

  router.get('/active-turns', (_req: Request, res: Response) => {
    res.json(manager.activeTurns())
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
    const adapter = getAdapter(provider)
    const requestedModel = body.model == null ? null : body.model
    if (requestedModel !== null && !isModelAvailableForAdapter(adapter, requestedModel)) {
      res.status(400).json({ error: 'Model not available for this provider' })
      return
    }
    const effectiveModel = requestedModel ?? adapter.defaultModel()
    const conversation = createAgentConversation(desktopDb, {
      provider,
      model: requestedModel,
      pinnedProjectId: typeof body.pinnedProjectId === 'string' ? body.pinnedProjectId : null,
      tierLevel: body.tierLevel !== undefined ? normalizeLevel(body.tierLevel) : 0,
      // Off-catalog values fall back to null (= no provider-specific override).
      reasoningEffort: validEffort(provider, effectiveModel, body.reasoningEffort) ?? null,
    })
    res.status(201).json({ conversation })
  })

  router.get('/conversations/:id', (req: Request, res: Response) => {
    const conversation = getAgentConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'Unknown conversation' })
      return
    }
    res.json({
      conversation,
      messages: decorateAgentInputMessages(desktopDb, listAgentMessages(desktopDb, conversation.id)),
      pendingMessages: manager.pendingMessages(conversation.id),
      live: manager.conversationLive(conversation.id),
    })
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
    if (body.model !== undefined) {
      const effectiveProvider = (patch.provider as string | undefined) ?? conversation.provider
      if (body.model === null) {
        patch.model = null
      } else if (typeof body.model === 'string') {
        if (!isModelAvailableForAdapter(getAdapter(effectiveProvider), body.model)) {
          res.status(400).json({ error: 'Model not available for this provider' })
          return
        }
        patch.model = body.model
      }
    }
    const effectiveProvider = (patch.provider as string | undefined) ?? conversation.provider
    const adapter = getAdapter(effectiveProvider)
    const effectiveModel = typeof patch.model === 'string'
      ? patch.model
      : patch.model === null
        ? adapter.defaultModel()
        : conversation.model ?? adapter.defaultModel()
    // Explicit effort pick — validated against the effective model. A model
    // change without an effort pick clears a now-incompatible persisted value.
    if (body.reasoningEffort !== undefined) {
      const v = validEffort(effectiveProvider, effectiveModel, body.reasoningEffort)
      if (v === undefined) {
        res.status(400).json({ error: 'Effort not available for this provider and model' })
        return
      }
      patch.reasoning_effort = v
    } else if (
      body.model !== undefined
      && conversation.reasoning_effort
      && validEffort(effectiveProvider, effectiveModel, conversation.reasoning_effort) === undefined
    ) {
      patch.reasoning_effort = null
    }
    res.json({ conversation: updateAgentConversation(desktopDb, conversation.id, patch) })
  })

  router.delete('/conversations/:id', (req: Request, res: Response) => {
    const id = String(req.params.id)
    manager.abort(id)
    killBackgroundProcessesForChat(id)
    purgeBackgroundProcessHistory({ chatId: id })
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
    if (body.deliveryMode !== undefined && body.deliveryMode !== 'queue' && body.deliveryMode !== 'steer') {
      res.status(400).json({ error: 'deliveryMode must be queue or steer' })
      return
    }
    const deliveryMode = body.deliveryMode as 'queue' | 'steer' | undefined
    let attachmentIds: string[] = []
    const rawAtt = body.attachments
    if (rawAtt && typeof rawAtt === 'object' && Array.isArray((rawAtt as { ids?: unknown }).ids)) {
      attachmentIds = ((rawAtt as { ids: unknown[] }).ids).filter((x): x is string => typeof x === 'string')
    }
    const queueId = typeof body.queueId === 'string' ? body.queueId : null
    if (queueId !== null && (!queueId.trim() || queueId.length > 200)) {
      res.status(400).json({ error: 'queueId must be a nonempty message ID of at most 200 characters' })
      return
    }
    const contextRefs = sanitizeContextRefs(body.contextRefs)
    // Fire-and-forget: the turn streams over WS. Persist the chosen tier first so
    // a refresh mid-turn restores the right level.
    // isBusy here and sendMessage's own busy/enqueue branch run in the same
    // synchronous frame (the enqueue happens before sendMessage's first await),
    // so the flag the client gets always matches what actually happened.
    const queued = manager.isBusy(conversation.id)
    try {
      const previous = queueId ? getAgentInput(desktopDb, conversation.id, queueId) : undefined
      void manager.sendMessage(conversation.id, text, { tierLevel, model, attachmentIds, queueId, contextRefs, deliveryMode }).catch((e) =>
        console.error('[agent-chat] send failed:', e),
      )
      if (tierLevel !== undefined) updateAgentConversation(desktopDb, conversation.id, { tier_level: tierLevel })
      const input = queueId ? getAgentInput(desktopDb, conversation.id, queueId) : undefined
      const pending = manager.pendingMessages(conversation.id).find((item) => item.queueId === queueId)
      const stillQueued = input ? input.status === 'pending' && pending !== undefined : queued
      const message = input?.messageId
        ? decorateAgentInputMessages(desktopDb, listAgentMessages(desktopDb, conversation.id).filter((item) => item.id === input.messageId))[0]
        : undefined
      res.status(202).json({
        accepted: true, queued: stillQueued,
        ...(stillQueued ? { deliveryMode: pending?.deliveryMode ?? input?.options.deliveryMode ?? deliveryMode ?? 'queue' } : {}),
        ...(previous ? { duplicate: true } : {}),
        ...(input?.status === 'cancelled' && !input.messageId ? { removed: true } : {}),
        ...(message ? { message } : {}),
      })
    } catch (err) {
      if (err instanceof AgentInputConflictError || err instanceof AgentInputLimitError) {
        res.status(err instanceof AgentInputLimitError ? 429 : 409).json({ error: err.message })
        return
      }
      throw err
    }
  })

  // Edit a still-queued (not yet dispatched) message in place. 409 when the
  // queue already consumed it — the client keeps the user's text as a draft so
  // nothing is lost (never-lose-input semantics).
  router.patch('/conversations/:id/queue/:queueId', (req: Request, res: Response) => {
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
    const edited = manager.editQueued(conversation.id, String(req.params.queueId), text)
    if (!edited) {
      res.status(409).json({ error: 'Message already dispatched' })
      return
    }
    res.json({ ok: true })
  })

  router.post('/conversations/:id/queue/:queueId/steer', (req: Request, res: Response) => {
    const conversation = getAgentConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'Unknown conversation' })
      return
    }
    if (!manager.steerQueued(conversation.id, String(req.params.queueId))) {
      res.status(409).json({ error: 'Message already dispatched' })
      return
    }
    res.json({ ok: true })
  })

  router.delete('/conversations/:id/queue/:queueId', (req: Request, res: Response) => {
    const conversation = getAgentConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'Unknown conversation' })
      return
    }
    if (!manager.removeQueued(conversation.id, String(req.params.queueId))) {
      res.status(409).json({ error: 'Message already dispatched' })
      return
    }
    res.json({ ok: true })
  })

  router.post('/conversations/:id/abort', (req: Request, res: Response) => {
    const aborted = manager.abort(String(req.params.id))
    res.json({ aborted })
  })

  return router
}
