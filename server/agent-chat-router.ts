import { Router, type Request, type Response } from 'express'
import type { DbInstance } from './db'
import type { AgentChatManager } from './agent-chat-manager'
import { getAdapter } from './providers'
import { normalizeLevel } from './agent-tier'
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
    res.json({ provider, models: getAdapter(provider).modelCatalog() })
  })

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
      // Switching provider invalidates the stored session id AND model (both
      // belong to the previous provider) — clear them so the next turn starts a
      // fresh session with the new provider's default model (codex rejects
      // claude's "sonnet"; resume of a foreign thread → "no rollout found").
      if (v !== conversation.provider) {
        patch.session_id = null
        patch.model = null
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
    res.json({ conversation: updateAgentConversation(desktopDb, conversation.id, patch) })
  })

  router.delete('/conversations/:id', (req: Request, res: Response) => {
    manager.abort(String(req.params.id))
    deleteAgentConversation(desktopDb, String(req.params.id))
    res.json({ ok: true })
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
    // Fire-and-forget: the turn streams over WS. Persist the chosen tier first so
    // a refresh mid-turn restores the right level.
    if (tierLevel !== undefined) updateAgentConversation(desktopDb, conversation.id, { tier_level: tierLevel })
    void manager.sendMessage(conversation.id, text, { tierLevel, model })
    res.status(202).json({ accepted: true })
  })

  router.post('/conversations/:id/abort', (req: Request, res: Response) => {
    const aborted = manager.abort(String(req.params.id))
    res.json({ aborted })
  })

  return router
}
