import { Router, type Request, type Response } from 'express'
import type { DbInstance } from './db'
import type { BlueprintChatManager } from './blueprint-chat-manager'
import {
  getAdapter,
  isModelAvailableForAdapter,
  reasoningEffortsForModel,
} from './providers'
import { pureOutputToolPolicy } from './providers/runtime'
import {
  createBlueprintConversation,
  listBlueprintConversations,
  getBlueprintConversation,
  updateBlueprintConversation,
  deleteBlueprintConversation,
  listBlueprintMessages,
} from './blueprint-store'
import type { BlueprintCommitInput, BlueprintCommitRunner } from './blueprint-commit'

// ─── Project Builder REST surface (/api/blueprint) ────────────────────────────
//
// App-level (NOT per-project) routes for the day-0 Project Builder. Gated by
// SPECRAILS_PROJECT_BUILDER (default on, opt-out). A `send` is fire-and-forget
// (202) — the turn streams over the `blueprint.*` WS events. The orchestrated
// commit is likewise 202 + `blueprint.commit_progress` streaming.

export interface BlueprintRouterDeps {
  manager: BlueprintChatManager
  desktopDb: DbInstance
  runCommit: BlueprintCommitRunner
}

export function isProjectBuilderEnabled(): boolean {
  return process.env.SPECRAILS_PROJECT_BUILDER !== 'false'
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

export function createBlueprintRouter(deps: BlueprintRouterDeps): Router {
  const { manager, desktopDb, runCommit } = deps
  const router = Router()

  router.use((_req: Request, res: Response, next) => {
    if (!isProjectBuilderEnabled()) {
      res.status(404).json({ error: 'project builder is disabled' })
      return
    }
    next()
  })

  router.get('/models', (req: Request, res: Response) => {
    const provider = validProvider(req.query.provider) ?? 'claude'
    const adapter = getAdapter(provider)
    const toolPolicy = pureOutputToolPolicy(adapter)
    const requestedModel = typeof req.query.model === 'string' && req.query.model
      ? req.query.model
      : null
    const model = requestedModel ?? adapter.defaultModel()
    res.json({
      provider,
      available: toolPolicy !== null,
      toolPolicy,
      models: toolPolicy ? adapter.modelCatalog() : [],
      defaultModel: toolPolicy ? adapter.defaultModel() : null,
      model,
      efforts: toolPolicy ? reasoningEffortsForModel(adapter, model) : [],
    })
  })

  router.get('/conversations', (_req: Request, res: Response) => {
    res.json({ conversations: listBlueprintConversations(desktopDb) })
  })

  router.post('/conversations', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { provider?: unknown; model?: unknown }
    const provider = validProvider(body.provider) ?? 'claude'
    if (!pureOutputToolPolicy(getAdapter(provider))) {
      res.status(409).json({ error: 'provider_tool_policy_unsupported', provider })
      return
    }
    const model = typeof body.model === 'string' && body.model ? body.model : null
    const conversation = createBlueprintConversation(desktopDb, { provider, model })
    res.status(201).json({ conversation })
  })

  router.get('/conversations/:id', (req: Request, res: Response) => {
    const conversation = getBlueprintConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' })
      return
    }
    res.json({ conversation, messages: listBlueprintMessages(desktopDb, conversation.id) })
  })

  router.patch('/conversations/:id', (req: Request, res: Response) => {
    const conversation = getBlueprintConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' })
      return
    }
    const body = (req.body ?? {}) as { provider?: unknown; model?: unknown; title?: unknown }
    const patch: Record<string, string | null> = {}
    if (body.provider !== undefined) {
      const provider = validProvider(body.provider)
      if (!provider) {
        res.status(400).json({ error: 'invalid provider' })
        return
      }
      if (!pureOutputToolPolicy(getAdapter(provider))) {
        res.status(409).json({ error: 'provider_tool_policy_unsupported', provider })
        return
      }
      patch.provider = provider
      if (provider !== conversation.provider) {
        // A session id is provider-local; a switch must reset it and the model.
        patch.session_id = null
        patch.model = null
      }
    }
    if (body.model !== undefined) {
      if (body.model !== null && typeof body.model !== 'string') {
        res.status(400).json({ error: 'invalid model' })
        return
      }
      const effectiveProvider = (patch.provider as string | undefined) ?? conversation.provider
      if (typeof body.model === 'string' && body.model) {
        if (!isModelAvailableForAdapter(getAdapter(effectiveProvider), body.model)) {
          res.status(400).json({ error: 'model not in provider catalog' })
          return
        }
        patch.model = body.model
      } else {
        patch.model = null
      }
    }
    if (body.title !== undefined) {
      if (body.title !== null && typeof body.title !== 'string') {
        res.status(400).json({ error: 'invalid title' })
        return
      }
      patch.title = typeof body.title === 'string' ? body.title.slice(0, 200) : null
    }
    const updated = updateBlueprintConversation(desktopDb, conversation.id, patch)
    res.json({ conversation: updated })
  })

  router.delete('/conversations/:id', (req: Request, res: Response) => {
    const conversation = getBlueprintConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' })
      return
    }
    manager.abort(conversation.id)
    deleteBlueprintConversation(desktopDb, conversation.id)
    res.json({ ok: true })
  })

  router.post('/conversations/:id/send', (req: Request, res: Response) => {
    const conversation = getBlueprintConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' })
      return
    }
    const body = (req.body ?? {}) as { text?: unknown; model?: unknown; reasoning_effort?: unknown }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) {
      res.status(400).json({ error: 'text is required' })
      return
    }
    if (manager.isStreaming(conversation.id)) {
      res.status(409).json({ error: 'a turn is already streaming' })
      return
    }
    const adapter = getAdapter(conversation.provider)
    if (!pureOutputToolPolicy(adapter)) {
      res.status(409).json({
        error: 'provider_tool_policy_unsupported',
        provider: conversation.provider,
      })
      return
    }
    if (
      body.model !== undefined
      && body.model !== null
      && !isModelAvailableForAdapter(adapter, body.model)
    ) {
      res.status(400).json({ error: 'model not in provider catalog' })
      return
    }
    const model = typeof body.model === 'string' && body.model ? body.model : undefined
    const effectiveModel = model
      ?? (conversation.model && isModelAvailableForAdapter(adapter, conversation.model)
        ? conversation.model
        : adapter.defaultModel())
    let reasoningEffort: string | undefined
    if (body.reasoning_effort !== undefined) {
      const allowedEfforts = reasoningEffortsForModel(adapter, effectiveModel)
      if (
        typeof body.reasoning_effort !== 'string'
        || !(allowedEfforts as readonly string[]).includes(body.reasoning_effort)
      ) {
        res.status(400).json({ error: 'reasoning effort not in provider catalog' })
        return
      }
      reasoningEffort = body.reasoning_effort
    }
    void manager.sendMessage(conversation.id, text, { model, reasoningEffort })
    res.status(202).json({ accepted: true })
  })

  router.post('/conversations/:id/abort', (req: Request, res: Response) => {
    const conversation = getBlueprintConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' })
      return
    }
    manager.abort(conversation.id)
    res.json({ ok: true })
  })

  // Orchestrated commit (add-project-builder D3): validates synchronously,
  // then 202 + streamed `blueprint.commit_progress` events. Delegation to
  // `executeBlueprintCommit` keeps this handler thin and the orchestrator
  // unit-testable via its DI bag.
  router.post('/commit', (req: Request, res: Response) => {
    const input = (req.body ?? {}) as BlueprintCommitInput
    const validation = runCommit.validate(input)
    if (!validation.ok) {
      res.status(400).json({ error: validation.error, detail: validation.detail })
      return
    }
    const commitId = runCommit.start(input)
    res.status(202).json({ accepted: true, commitId })
  })

  return router
}
