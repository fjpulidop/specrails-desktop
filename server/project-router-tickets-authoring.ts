// Add Spec authoring routes: Quick AI spec generation (generate-spec, mapped
// onto the spec_gen_* WebSocket stream; the spec-generation use case owns the
// spawn and persistence) and the "Raw" mode that stores a free-form prompt
// verbatim (from-prompt, no AI). Both promote to Jira on Jira-backed projects.

import type { Request, Response } from 'express'
import { newId as uuidv4 } from './ids'
import { setQuickContractRefineLast } from './db'
import { getAdapter } from './providers'
import type { ContextScope } from './modules/conversations/runtime/context-scope'
import { resolveSpecGenerationToolPolicy, startSpecGeneration, type SpecGenerationAttachments } from './modules/specs/runtime/spec-generation'
import { supportsContractRefine } from './providers/runtime'
import { getModelsForProvider, isValidModelForProvider, type SpecProvider } from './modules/specs/runtime/spec-models'
import { validateRequestedProvider } from './provider-selection'
import { mutateStore, isValidPriority, validatePriorityForStatus, type Ticket } from './modules/specs/runtime/ticket-store'
import { generateAutoTitle } from './modules/conversations/runtime/explore-draft-title'
import type { TicketCreatedMessage, SpecGenStreamMessage, SpecGenDoneMessage, SpecGenErrorMessage, LocalTicket } from './types'
import { captureProcessAdmission } from './process-admission'
import { attachmentManager } from './attachment-manager'
import { deriveFallbackShortSummary, lightlyStructurePrompt, resolveDefaultSpecModel } from './project-router-helpers'
import { createRepositoryScope, maybePromoteSpecToJira } from './project-router-tickets-shared'
import type { ProjectRoutesDeps } from './project-router-helpers'

export function registerTicketAuthoringRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx, ticketPath } = deps
  const repositoryScope = createRepositoryScope(ctx)

  // POST /:projectId/tickets/generate-spec — Fast AI spec generation (no codebase exploration)
  router.post('/:projectId/tickets/generate-spec', async (req: Request, res: Response) => {
    const idea = req.body?.idea as string | undefined
    if (!idea?.trim()) {
      res.status(400).json({ error: 'idea is required' }); return
    }
    const attachmentIds = Array.isArray(req.body?.attachmentIds)
      ? (req.body.attachmentIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    const pendingSpecId = typeof req.body?.pendingSpecId === 'string' ? (req.body.pendingSpecId as string) : null
    if (attachmentIds.length > 0 && !pendingSpecId) {
      res.status(400).json({ error: 'pendingSpecId is required when attachmentIds are provided' }); return
    }

    const { project, broadcast, ticketWatcher } = ctx(req)
    // Multi-provider: optional aiEngine (alias provider) picks the engine for
    // this Quick spec; must be installed on the project. Omitting it uses the
    // primary provider.
    const requestedEngine = req.body?.aiEngine ?? req.body?.provider
    const engineCheck = validateRequestedProvider(project, requestedEngine)
    if (!engineCheck.ok) {
      res.status(400).json({ error: engineCheck.error }); return
    }
    const provider: SpecProvider = engineCheck.provider as SpecProvider

    // Resolve and validate the model. Order:
    //   - Body had a `model` and it's valid → use it.
    //   - Body had a `model` and it's invalid → 400 with the allow-list.
    //   - Body had no `model` → fall back to project default.
    const rawModel = req.body?.model
    let resolvedModel: string
    if (rawModel === undefined || rawModel === null || rawModel === '') {
      resolvedModel = resolveDefaultSpecModel({ projectPath: project.path, slug: project.slug, provider })
    } else if (isValidModelForProvider(rawModel, provider)) {
      resolvedModel = rawModel
    } else {
      res.status(400).json({
        error: `Invalid model "${String(rawModel)}" for provider "${provider}"`,
        allowed: getModelsForProvider(provider).map((m) => m.value),
      })
      return
    }

    const requestId = uuidv4()
    const projectId = project.id
    const admission = captureProcessAdmission(projectId)
    const filePath = ticketPath(req)

    let attachments: SpecGenerationAttachments | undefined
    if (attachmentIds.length > 0 && pendingSpecId) {
      try {
        const extracted = await attachmentManager.getClaudeArgs(project.slug, pendingSpecId, attachmentIds)
        attachments = { textBlocks: extracted.textBlocks, imageFlags: extracted.imageFlags, imagePaths: extracted.imagePaths }
      } catch (err) {
        console.error('[project-router] generate-spec attachment extraction error:', err)
      }
    }
    if (!admission.isCurrent()) {
      res.status(409).json({ error: 'Project is being removed' })
      return
    }

    // Parse contextScope from body. Quick and Explore share the same Context
    // Awareness controls; Quick still keeps Contract Refine as a top-level
    // field for the refine scheduler.
    const rawScope = req.body?.contextScope
    // Contract Layer is available only when the selected adapter advertises a
    // safe structured-action implementation.
    const quickContractRefine = !supportsContractRefine(getAdapter(provider))
      ? false
      : typeof req.body?.contractRefine === 'boolean'
      ? req.body.contractRefine
      : typeof rawScope?.contractRefine === 'boolean'
        ? rawScope.contractRefine
      : false
    const quickScope: ContextScope = {
      specrails: typeof rawScope?.specrails === 'boolean' ? rawScope.specrails : false,
      openspec: typeof rawScope?.openspec === 'boolean' ? rawScope.openspec : false,
      full: typeof rawScope?.full === 'boolean' ? rawScope.full : false,
      // Quick spawns from project.path, so project `.mcp.json` (the `mcp`
      // toggle) is discovered natively. `userMcp` additionally loads the
      // developer's user-scope/plugin/connector MCP servers via the claude
      // adapter's `loadUserEnv`.
      mcp: typeof rawScope?.mcp === 'boolean' ? rawScope.mcp : false,
      contractRefine: quickContractRefine,
      userMcp: typeof rawScope?.userMcp === 'boolean' ? rawScope.userMcp : false,
    }
    if (!resolveSpecGenerationToolPolicy(provider, quickScope)) {
      res.status(409).json({
        error: 'provider_tool_policy_unsupported',
        provider,
        requiredPolicy: quickScope.full ? 'read-only' : 'pure-output',
      })
      return
    }
    // Persist Quick mode Contract Refine choice (per-project last value).
    setQuickContractRefineLast(ctx(req).db, quickContractRefine)

    // The spec-generation use case owns the provider spawn, parsing, ticket
    // persistence, Contract Layer scheduling and accounting; this route maps
    // its lifecycle onto the spec_gen_* / ticket_created WebSocket contract.
    startSpecGeneration({
      db: ctx(req).db,
      project,
      ticketStorePath: filePath,
      ticketWatcher,
      broadcast: broadcast as (m: unknown) => void,
      admission,
    }, {
      text: idea,
      provider,
      model: resolvedModel,
      scope: quickScope,
      repositoryIds: res.locals.repositoryIds as string[] | undefined,
      resolveRepositoryScope: () => repositoryScope(req, res),
      attachments,
      contractRefine: quickContractRefine ? { model: (req.body?.model as string | undefined) ?? null } : null,
      // Add Spec → Intent (intent-mode): the intent first, the spec derived from it.
      ...(req.body?.intent === true ? { intent: { mode: 'derive' as const } } : {}),
      requestId,
      hooks: {
        onDelta: (delta) => {
          const wsMsg: SpecGenStreamMessage = {
            type: 'spec_gen_stream', projectId, requestId,
            delta, timestamp: new Date().toISOString(),
          }
          broadcast(wsMsg)
        },
        onError: (error) => {
          const msg: SpecGenErrorMessage = {
            type: 'spec_gen_error', projectId, requestId,
            error, timestamp: new Date().toISOString(),
          }
          broadcast(msg)
        },
        onPersisted: async (created) => {
          // Migrate attachments from pendingSpecId → real ticket id (if any were uploaded).
          // Must complete BEFORE broadcasting ticket_created so WS listeners see the populated attachments[].
          if (pendingSpecId) {
            try {
              const migrated = await attachmentManager.renameTicketDir({
                slug: project.slug,
                pendingId: pendingSpecId,
                realTicketId: created.id,
                ticketStorePath: ticketPath(req),
              })
              if (migrated.length > 0) {
                created.attachments = migrated
              }
            } catch (err) {
              console.error('[project-router] generate-spec attachment migration error:', err)
            }
            if (!admission.isCurrent()) return 'abort'
          }

          const ticketMsg: TicketCreatedMessage = {
            type: 'ticket_created', ticket: created as unknown as LocalTicket,
            projectId, timestamp: new Date().toISOString(),
          }
          broadcast(ticketMsg)

          const doneMsg: SpecGenDoneMessage = {
            type: 'spec_gen_done', projectId, requestId,
            ticket: created as unknown as LocalTicket, timestamp: new Date().toISOString(),
          }
          broadcast(doneMsg)

          // Add Spec → Jira: promote the new ticket to a Jira issue when the
          // project is Jira-backed (unless the user opted to keep it local).
          void maybePromoteSpecToJira(ctx(req), created.id, req.body?.createLocal === true, broadcast as (m: unknown) => void)
        },
      },
    })

    res.status(202).json({ requestId })
  })

  // POST /:projectId/tickets/from-prompt — Create a spec directly from a
  // free-form prompt (the "Raw" Add-Spec mode). NO AI is invoked: the user's
  // text becomes the ticket description verbatim. The ticket lands as
  // status='todo' (ready for rails) with source='free-prompt'. There is no
  // ai_invocations row (nothing was billed) and no contract-refine (no origin
  // conversation, no description format to refine).
  router.post('/:projectId/tickets/from-prompt', async (req: Request, res: Response) => {
    const body = req.body ?? {}
    const rawDescription = typeof body.description === 'string' ? body.description.trim() : ''
    if (!rawDescription) {
      res.status(400).json({ error: 'description is required' }); return
    }
    // Optional light-structuring (v1: the client always sends `false`; the flag
    // keeps the contract stable for a future non-generative structuring pass).
    const structured = body.structured === true
    const description = structured ? lightlyStructurePrompt(rawDescription) : rawDescription

    // Title: explicit value wins; otherwise derive a single-line summary from
    // the body (reusing the deterministic Explore-draft summarizer).
    const providedTitle = typeof body.title === 'string' ? body.title.trim() : ''
    const title = providedTitle || generateAutoTitle([{ role: 'user', content: rawDescription }])

    const labels = Array.isArray(body.labels)
      ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string')
      : []

    // Priority: validate against the allowed set; default 'medium'. A
    // status='todo' ticket MUST carry a non-null priority (see
    // validatePriorityForStatus), so we never accept null here.
    const priority = isValidPriority(body.priority) ? body.priority : 'medium'
    const validationError = validatePriorityForStatus('todo', priority)
    if (validationError) {
      res.status(400).json({ error: validationError }); return
    }

    const pendingSpecId = typeof body.pendingSpecId === 'string' ? body.pendingSpecId : null
    const shortSummary = deriveFallbackShortSummary(title, description)

    try {
      const filePath = ticketPath(req)
      const now = new Date().toISOString()
      let created: Ticket | undefined
      const store = mutateStore(filePath, (s) => {
        const id = s.next_id++
        const ticket: Ticket = {
          ...repositoryScope(req, res),
          id,
          title,
          description,
          status: 'todo',
          priority,
          labels,
          assignee: null,
          prerequisites: [],
          metadata: {},
          comments: [],
          origin_conversation_id: null,
          is_epic: false,
          parent_epic_id: null,
          execution_order: null,
          short_summary: shortSummary,
          created_at: now,
          updated_at: now,
          created_by: 'hub', // legacy on-disk wire value (tickets.json, shared with specrails-core) — do not rename
          source: 'free-prompt',
        }
        s.tickets[String(id)] = ticket
        created = ticket
      })

      const { broadcast, ticketWatcher, project } = ctx(req)
      ticketWatcher.notifyDesktopWrite(store.revision)

      // Migrate attachments from pendingSpecId → real ticket id (mirrors the
      // generate-spec / from-draft flow). Must complete before broadcasting so
      // listeners see the populated attachments[].
      if (pendingSpecId && created) {
        try {
          const migrated = await attachmentManager.renameTicketDir({
            slug: project.slug,
            pendingId: pendingSpecId,
            realTicketId: created.id,
            ticketStorePath: ticketPath(req),
          })
          if (migrated.length > 0) {
            created.attachments = migrated
          }
        } catch (err) {
          console.error('[project-router] from-prompt attachment migration error:', err)
        }
      }

      const msg: TicketCreatedMessage = {
        type: 'ticket_created',
        ticket: created! as unknown as LocalTicket,
        projectId: project.id,
        timestamp: new Date().toISOString(),
      }
      broadcast(msg)
      res.status(201).json({ ticket: created!, revision: store.revision })
    } catch (err) {
      console.error('[project-router] from-prompt create error:', err)
      res.status(500).json({ error: 'Failed to create ticket' })
    }
  })
}
