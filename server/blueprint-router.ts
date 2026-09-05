import { Router, type Request, type Response } from 'express'
import type { DbInstance } from './db'
import { BUILDER_TURN_INTENTS, type BlueprintChatManager, type BuilderTurnIntent } from './blueprint-chat-manager'
import {
  getAdapter,
  isModelAvailableForAdapter,
  reasoningEffortsForModel,
} from './providers'
import { pureOutputToolPolicy } from './providers/runtime'
import {
  createBlueprintConversation,
  listBlueprintConversations,
  listResumableBlueprintConversations,
  getBlueprintConversation,
  getBlueprintSnapshot,
  updateBlueprintConversation,
  deleteBlueprintConversation,
  listBlueprintMessages,
} from './blueprint-store'
import { auditRawBlueprintForM1 } from './blueprint-spec-quality'
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

  // `?resumable=1` → the "continue where you left off" list: unfinished
  // (never committed) conversations with at least one assistant reply, each
  // with a snapshot summary — the durable answer to "I closed the panel and
  // lost the specs".
  router.get('/conversations', (req: Request, res: Response) => {
    if (req.query.resumable === '1' || req.query.resumable === 'true') {
      res.json({ conversations: listResumableBlueprintConversations(desktopDb) })
      return
    }
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

  // Rehydration payload: transcript (block-only replies hidden — their raw
  // payload stays in the row), the persisted snapshot pair, and its status so
  // the panel resumes with the same readiness/repair affordances it had live.
  router.get('/conversations/:id', (req: Request, res: Response) => {
    const conversation = getBlueprintConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' })
      return
    }
    const snapshot = getBlueprintSnapshot(desktopDb, conversation.id)
    const audit = snapshot.rawBlueprint !== null ? auditRawBlueprintForM1(snapshot.rawBlueprint) : null
    const messages = listBlueprintMessages(desktopDb, conversation.id)
      .filter((m) => m.content.trim() !== '')
      .map(({ raw_content: _raw, ...rest }) => rest)
    res.json({
      conversation,
      messages,
      blueprint: snapshot.blueprint,
      rawBlueprint: snapshot.rawBlueprint,
      snapshot: snapshot.issue
        ? { status: 'rejected', reason: snapshot.issue.reason, detail: snapshot.issue.detail }
        : snapshot.blueprint
          ? {
              status: 'accepted',
              claimsComplete: audit?.claimsComplete ?? false,
              ...(audit && audit.claimsComplete && !audit.valid ? { qualityIssues: audit.issues } : {}),
            }
          : { status: 'none' },
      snapshotUpdatedAt: snapshot.snapshotUpdatedAt,
    })
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
    const body = (req.body ?? {}) as { text?: unknown; model?: unknown; reasoning_effort?: unknown; intent?: unknown }
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
    const intent = (BUILDER_TURN_INTENTS as readonly string[]).includes(String(body.intent)) ? body.intent as BuilderTurnIntent : undefined
    void manager.sendMessage(conversation.id, text, { model, reasoningEffort, ...(intent ? { intent } : {}) })
    res.status(202).json({ accepted: true })
  })

  // Manual snapshot repair: re-ask the Builder for its last block (rejected
  // JSON / cut-off reply) or for the audit fixes (claimed complete, gate
  // disagreed). 202 + `blueprint.repairing` → streams → `blueprint.done`.
  router.post('/conversations/:id/repair-snapshot', async (req: Request, res: Response) => {
    const conversation = getBlueprintConversation(desktopDb, String(req.params.id))
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' })
      return
    }
    const rawEffort = (req.body ?? {}).reasoningEffort
    const outcome = await manager.repairSnapshot(conversation.id, typeof rawEffort === 'string' ? { reasoningEffort: rawEffort } : {})
    if (!outcome.ok) {
      const status = outcome.reason === 'unknown_conversation' ? 404 : 409
      res.status(status).json({ error: outcome.reason })
      return
    }
    res.status(202).json({ accepted: true, kind: outcome.kind })
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
