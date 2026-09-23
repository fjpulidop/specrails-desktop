// Domain routes extracted from project-router.ts (chat).
// Registered on the shared router by createProjectRouter — behaviour-preserving.
import { Request, Response } from 'express'
import { newId as uuidv4 } from './ids'
import {
  createConversation, listConversations, getConversation,
  deleteConversation, updateConversation, getMessages
} from './db'
import { getAdapter } from './providers'
import { supportsToolPolicy } from './providers/runtime'
import {
  getLastContextScope, setLastContextScope, normalizeContextScope, type ContextScope
} from './modules/conversations/runtime/context-scope'
import {
  getModelsForProvider, isValidModelForProvider,
  type SpecProvider
} from './modules/specs/runtime/spec-models'
import { validateRequestedProvider, isMultiProvider } from './provider-selection'
import type { ChatConversationRow } from './types'
import { mutateStore } from './modules/specs/runtime/ticket-store'
import {
  type ProjectRoutesDeps, resolveDefaultSpecModel
} from './project-router-helpers'

export function registerChatRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx, ticketPath } = deps
  // ─── Chat routes ─────────────────────────────────────────────────────────────

  router.get('/:projectId/chat/conversations', (req: Request, res: Response) => {
    const conversations = listConversations(ctx(req).db)
    res.json({ conversations })
  })

  router.post('/:projectId/chat/conversations', (req: Request, res: Response) => {
    const { db, project } = ctx(req)
    // Multi-provider: an optional aiEngine (alias: provider) picks which engine
    // this conversation runs on. It must be installed on the project; omitting
    // it uses the project's primary provider. The chosen provider drives model
    // validation and is persisted on the conversation so resume turns and
    // ai_invocations attribute to the right engine.
    const requestedEngine = req.body?.aiEngine ?? req.body?.provider
    const engineCheck = validateRequestedProvider(project, requestedEngine)
    if (!engineCheck.ok) {
      res.status(400).json({ error: engineCheck.error })
      return
    }
    const provider = engineCheck.provider as SpecProvider
    const rawModel = req.body?.model
    let model: string
    if (rawModel === undefined || rawModel === null || rawModel === '') {
      model = resolveDefaultSpecModel({ projectPath: project.path, slug: project.slug, provider })
    } else if (isValidModelForProvider(rawModel, provider)) {
      model = rawModel
    } else {
      res.status(400).json({
        error: `Invalid model "${String(rawModel)}" for provider "${provider}"`,
        allowed: getModelsForProvider(provider).map((m) => m.value),
      })
      return
    }
    const rawKind = req.body?.kind
    const kind: 'sidebar' | 'explore' | 'milestone' =
      rawKind === 'explore' ? 'explore' : rawKind === 'milestone' ? 'milestone' : 'sidebar'
    if (kind === 'milestone' && !supportsToolPolicy(getAdapter(provider), 'read-only')) {
      res.status(409).json({
        error: 'provider_tool_policy_unsupported',
        provider,
        requiredPolicy: 'read-only',
      })
      return
    }
    const id = uuidv4()
    const rawScope = req.body?.contextScope
    if (rawScope !== undefined && kind !== 'explore') {
      res.status(400).json({ error: 'contextScope is only allowed for kind=explore' })
      return
    }
    // Milestone generation (add-project-builder D7): the target milestone id
    // rides context_scope as a minimal `{ milestone }` object so ChatManager
    // can seed its milestone system prompt from the workspace blueprint.
    let milestoneScope: Record<string, unknown> | undefined
    if (kind === 'milestone') {
      const rawMilestone = req.body?.milestone
      if (typeof rawMilestone !== 'string' || !/^m[0-9]{1,3}$/i.test(rawMilestone)) {
        res.status(400).json({ error: 'milestone (e.g. "m2") is required for kind=milestone' })
        return
      }
      milestoneScope = { milestone: rawMilestone.toLowerCase() }
    }
    let scope: ContextScope | undefined
    if (kind === 'explore') {
      const fallback = getLastContextScope(db, 'explore')
      // Defence-in-depth: retain Contract Refine only for providers that
      // advertise the structured-action contract.
      const safeRawScope =
        getAdapter(provider).capabilities.structuredActions !== true && rawScope != null
          ? { ...rawScope, contractRefine: false }
          : rawScope
      scope = normalizeContextScope(safeRawScope ?? fallback, fallback)
      setLastContextScope(db, scope)
      console.log(`[project-router] new explore conv ${id} provider=${provider} scope=${JSON.stringify(scope)} rawScope=${JSON.stringify(rawScope)}`)
    }
    // Only persist provider when the project is multi-provider; single-provider
    // projects leave it NULL so behaviour is byte-identical to before.
    const persistProvider = isMultiProvider(project) ? provider : null
    createConversation(db, { id, model, kind, contextScope: scope ?? milestoneScope, provider: persistProvider })
    const conversation = getConversation(db, id) as ChatConversationRow
    res.status(201).json({ conversation })
  })

  router.get('/:projectId/chat/conversations/:id', (req: Request, res: Response) => {
    const { db } = ctx(req)
    const conversation = getConversation(db, req.params.id as string)
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
    const messages = getMessages(db, req.params.id as string)
    res.json({ conversation, messages })
  })

  router.delete('/:projectId/chat/conversations/:id', (req: Request, res: Response) => {
    const { db, chatManager, ticketWatcher } = ctx(req)
    const convId = req.params.id as string
    const conversation = getConversation(db, convId)
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
    deleteConversation(db, convId)
    chatManager?.forgetSpecDraft(convId)
    chatManager?.forgetExploreLifecycle(convId)
    // Cascade-clear origin_conversation_id on any ticket that referenced this
    // conversation (application-level "ON DELETE SET NULL").
    try {
      const filePath = ticketPath(req)
      const store = mutateStore(filePath, (s) => {
        for (const id of Object.keys(s.tickets)) {
          if (s.tickets[id].origin_conversation_id === convId) {
            s.tickets[id].origin_conversation_id = null
            s.tickets[id].updated_at = new Date().toISOString()
          }
        }
      })
      ticketWatcher.notifyDesktopWrite(store.revision)
      // No per-ticket broadcast: the cleared field is metadata-only and the
      // board card visual treatment doesn't depend on it.
    } catch (err) {
      console.error('[project-router] conversation-cascade ticket update error:', err)
    }
    res.json({ ok: true })
  })

  router.patch('/:projectId/chat/conversations/:id', (req: Request, res: Response) => {
    const { db, project } = ctx(req)
    const conversation = getConversation(db, req.params.id as string)
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
    const { title, model } = req.body ?? {}
    const patch: { title?: string; model?: string } = {}
    if (title !== undefined) {
      if (typeof title !== 'string') { res.status(400).json({ error: 'title must be a string' }); return }
      patch.title = title
    }
    if (model !== undefined) {
      // Validate against the conversation's own provider so a bad value can't be
      // persisted and break the next turn's spawn. (Mirrors the POST handler.)
      const convProvider =
        (conversation.provider as SpecProvider | null) ??
        ((project.provider ?? 'claude') as SpecProvider)
      if (typeof model !== 'string' || !isValidModelForProvider(model, convProvider)) {
        res.status(400).json({
          error: `Invalid model "${String(model)}" for provider "${convProvider}"`,
          allowed: getModelsForProvider(convProvider).map((m) => m.value),
        })
        return
      }
      patch.model = model
    }
    updateConversation(db, req.params.id as string, patch)
    const updated = getConversation(db, req.params.id as string) as ChatConversationRow
    res.json({ ok: true, conversation: updated })
  })

  router.get('/:projectId/chat/conversations/:id/messages', (req: Request, res: Response) => {
    const { db } = ctx(req)
    const conversation = getConversation(db, req.params.id as string)
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
    const messages = getMessages(db, req.params.id as string)
    res.json({ messages })
  })

  // Returns the in-memory spec-draft state Claude has accumulated for this
  // conversation. Used by useSpecDraftStream on mount to rehydrate updates
  // that were broadcast while the client wasn't subscribed (refresh /
  // minimize-and-restore). Returns 200 with `null` draft when no state yet.
  router.get('/:projectId/chat/conversations/:id/spec-draft', (req: Request, res: Response) => {
    const { db, chatManager } = ctx(req)
    const conversation = getConversation(db, req.params.id as string)
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
    const state = chatManager.getSpecDraftState(req.params.id as string)
    if (!state) { res.json({ draft: null, ready: false, chips: [] }); return }
    res.json({
      draft: state.draft,
      ready: state.ready,
      chips: state.chips,
    })
  })

  router.post('/:projectId/chat/conversations/:id/messages', async (req: Request, res: Response) => {
    const { db, chatManager, project } = ctx(req)
    const conversation = getConversation(db, req.params.id as string)
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
    const text = req.body?.text as string | undefined
    if (!text || !text.trim()) { res.status(400).json({ error: 'text is required' }); return }
    if (chatManager.isActive(req.params.id as string)) {
      res.status(409).json({ error: 'CONVERSATION_BUSY' }); return
    }
    const lightweight = req.body?.lightweight === true
    const maxTurns = typeof req.body?.maxTurns === 'number' ? req.body.maxTurns : undefined
    let attachments: { slug: string; ticketKey: string; ids: string[] } | undefined
    const rawAtt = req.body?.attachments
    if (rawAtt && typeof rawAtt === 'object' && typeof rawAtt.ticketKey === 'string'
        && Array.isArray(rawAtt.ids)) {
      const ids = (rawAtt.ids as unknown[]).filter((x): x is string => typeof x === 'string')
      if (ids.length > 0) {
        attachments = { slug: project.slug, ticketKey: rawAtt.ticketKey, ids }
      }
    }
    res.status(202).json({ ok: true })
    chatManager.sendMessage(req.params.id as string, text.trim(), { lightweight, maxTurns, attachments }).catch((err) => {
      console.error('[project-router] chat sendMessage error:', err)
    })
  })

  router.delete('/:projectId/chat/conversations/:id/messages/stream', (req: Request, res: Response) => {
    const { chatManager } = ctx(req)
    if (!chatManager.isActive(req.params.id as string)) {
      res.status(404).json({ error: 'No active stream for this conversation' }); return
    }
    chatManager.abort(req.params.id as string)
    res.json({ ok: true })
  })

  // Explore Spec lifecycle: minimize-to-toast hint and restore-from-toast hint.
  // Idempotent; does not mutate persistent state. See design.md D7.
  router.post('/:projectId/chat/conversations/:id/minimize', (req: Request, res: Response) => {
    ctx(req).chatManager.notifyMinimized(req.params.id as string)
    res.json({ ok: true })
  })
  router.post('/:projectId/chat/conversations/:id/restore', (req: Request, res: Response) => {
    ctx(req).chatManager.notifyRestored(req.params.id as string)
    res.json({ ok: true })
  })

}
