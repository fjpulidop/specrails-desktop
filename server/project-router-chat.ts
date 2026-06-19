// Domain routes extracted from project-router.ts (chat).
// Registered on the shared router by createProjectRouter — behaviour-preserving.
import fs from 'fs'
import path from 'path'
import { Router, Request, Response, NextFunction } from 'express'
import { newId as uuidv4 } from './ids'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import {
  listJobs, getJob, getJobEvents, purgeJobs, deleteJob, getProjectActivity,
  createConversation, listConversations, getConversation,
  deleteConversation, updateConversation, getMessages,
  getStats, getPipelineJobs,
  createProposal, getProposal, listProposals, deleteProposal,
  createTemplate, listTemplates, getTemplate, updateTemplate, deleteTemplate,
  getProjectSettings, updateProjectSettings,
  getQuickContractRefineLast, setQuickContractRefineLast, hasQuickContractRefineLast,
  getTelemetryBlob, getTelemetrySummaries, getJobsWithTelemetry, hasJobTelemetry,
} from './db'
import { createDiagnosticZip } from './telemetry-export'
import { getProjectSetupSession } from './desktop-db'
import { ClaudeNotFoundError, JobNotFoundError, JobAlreadyTerminalError, DEFAULT_ZOMBIE_TIMEOUT_MS } from './queue-manager'
import type { JobPriority } from './types'
import { VALID_PRIORITIES } from './types'
import { resolveCommand } from './command-resolver'
import { getAdapter } from './providers'
import { createHooksRouter, getPhaseStates } from './hooks'
import { getConfig, fetchIssues } from './config'
import { runContractRefine, runContractRefineForQuick } from './contract-refine-runner'
import { isExploreContractRefineKillSwitchActive } from './explore-contract-refine'
import { runSmash, runSmashUndo, applyDeleteEpicChildren, checkSmashEligibility } from './smash-runner'
import { isSpecsSmashKillSwitchActive } from './explore-smash'
import { recordInvocation, updateTicketIdForConversation, getTicketSpendingSummary } from './ai-invocations'
import { getContextBudget } from './context-budget'
import {
  getLastContextScope, setLastContextScope, normalizeContextScope,
  setConversationContextScope, getConversationContextScope,
  buildScopedSystemPromptPrefix, toolFlagsForScope, defaultBootScope,
  type ContextScope,
} from './context-scope'
import { finaliseInvocationResult } from './result-event'
import { CORE_PACKAGE_SPEC } from './core-package'
import type { AdapterEvent } from './providers/types'
import { getSpending, getInvocations, parseSpendingFilters } from './spending'
import { randomUUID } from 'crypto'
import {
  getModelsForProvider,
  getProviderDefault,
  isValidModelForProvider,
  type SpecProvider,
} from './spec-models'
import { resolveProvider, validateRequestedProvider, isMultiProvider } from './provider-selection'
import type { ChatConversationRow, JobTemplate, JobRow } from './types'
import { readChanges } from './changes-reader'
import { getProjectMetrics } from './metrics'
import {
  resolveTicketStoragePath, readStore, mutateStore, filterTickets,
  isValidStatus, isValidPriority, validatePriorityForStatus,
  resolveTicketsFromCommand,
  clampShortSummary,
  type Ticket,
} from './ticket-store'
import { generateAutoTitle } from './explore-draft-title'
import type { TicketCreatedMessage, TicketUpdatedMessage, TicketDeletedMessage, TicketAiEditStreamMessage, TicketAiEditDoneMessage, TicketAiEditErrorMessage, SpecGenStreamMessage, SpecGenDoneMessage, SpecGenErrorMessage, LocalTicket } from './types'
import { spawnAiCli } from './util/cli-prompt'
import { createInterface } from 'readline'
import treeKill from 'tree-kill'
import multer from 'multer'
import { createRailsRouter } from './rails-router'
import { createProfilesRouter } from './profiles-router'
import { createPluginsRouter } from './plugins-router'
import { createCodeExplorerRouter } from './code-explorer-router'
import {
  getDesktopTerminalSettings,
  getProjectOverride,
  patchProjectOverride,
  resolveTerminalSettings,
  TerminalSettingsValidationError,
} from './terminal-settings'
import { listMarks } from './terminal-marks-store'
import { attachmentManager, isSupportedUploadedFile, USER_ATTACHMENT_SYSTEM_NOTE } from './attachment-manager'
import { isBrowserCaptureEnabled } from './feature-flags'
import { BrowserLimitExceededError, BrowserLaunchError } from './browser-capture-types'
import type { CaptureRect } from './browser-capture-types'
import {
  getTerminalManager,
  TerminalLimitExceededError,
  TerminalNotFoundError,
  TerminalNameInvalidError,
  TerminalSpawnError,
  TERMINAL_MAX_PER_PROJECT,
} from './terminal-manager'
import {
  type ProjectRoutesDeps,
  type ModelAlias,
  TERMINAL_PANEL_ENABLED,
  VALID_MODEL_ALIASES,
  readAgentModels,
  applyModelConfig,
  serializeInstallConfigYaml,
  stripSpecMetadataSections,
  extractShortSummary,
  deriveFallbackShortSummary,
  lightlyStructurePrompt,
  formatDescriptionWithCriteria,
  resolveDefaultSpecModel,
} from './project-router-helpers'

export function registerChatRoutes(deps: ProjectRoutesDeps): void {
  const { router, registry, ctx, ticketPath } = deps
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
    const kind: 'sidebar' | 'explore' = rawKind === 'explore' ? 'explore' : 'sidebar'
    const id = uuidv4()
    const rawScope = req.body?.contextScope
    if (rawScope !== undefined && kind !== 'explore') {
      res.status(400).json({ error: 'contextScope is only allowed for kind=explore' })
      return
    }
    let scope: ContextScope | undefined
    if (kind === 'explore') {
      const fallback = getLastContextScope(db, 'explore')
      // Defence-in-depth: SMASH / Contract Layer is Claude-only. Strip
      // contractRefine from the scope when the conversation's resolved provider
      // is non-Claude so no downstream code (Contract Refine Runner, SMASH
      // eligibility) ever sees a mismatched flag.
      const safeRawScope =
        provider !== 'claude' && rawScope != null
          ? { ...rawScope, contractRefine: false }
          : rawScope
      scope = normalizeContextScope(safeRawScope ?? fallback, fallback)
      setLastContextScope(db, scope)
      console.log(`[project-router] new explore conv ${id} provider=${provider} scope=${JSON.stringify(scope)} rawScope=${JSON.stringify(rawScope)}`)
    }
    // Only persist provider when the project is multi-provider; single-provider
    // projects leave it NULL so behaviour is byte-identical to before.
    const persistProvider = isMultiProvider(project) ? provider : null
    createConversation(db, { id, model, kind, contextScope: scope, provider: persistProvider })
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
    const { db, chatManager, broadcast, project, ticketWatcher } = ctx(req)
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
    const { db } = ctx(req)
    const conversation = getConversation(db, req.params.id as string)
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
    const { title, model } = req.body ?? {}
    const patch: { title?: string; model?: string } = {}
    if (title !== undefined) patch.title = title
    if (model !== undefined) patch.model = model
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
