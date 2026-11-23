// Explore draft routes: persist an in-progress Explore conversation as a
// status=draft ticket (save-as-draft) and commit a draft as a real ticket
// (from-draft), either creating a new ticket or flipping the draft in place.

import type { Request, Response } from 'express'
import { getConversation, getMessages } from './db'
import { getAdapter } from './providers'
import { extractOutOfScopeSection, validateNonGoals } from './modules/specs/domain/non-goals'
import { validateSpecIntent } from './modules/specs/domain/intent'
import { runContractRefine, runContractRefineForQuick } from './modules/specs/runtime/contract-refine-runner'
import { updateTicketIdForConversation } from './modules/accounting/runtime/ai-invocations'
import { supportsContractRefine } from './providers/runtime'
import { validateRequestedProvider } from './provider-selection'
import { mutateStore, isValidPriority, clampShortSummary, normalizeRegressionOfMetadata, type Ticket } from './modules/specs/runtime/ticket-store'
import { generateAutoTitle } from './modules/conversations/runtime/explore-draft-title'
import type { TicketCreatedMessage, TicketUpdatedMessage, LocalTicket } from './types'
import { attachmentManager } from './attachment-manager'
import { extractShortSummary, deriveFallbackShortSummary, formatDescriptionWithCriteria } from './project-router-helpers'
import { createRepositoryScope, maybePromoteSpecToJira, resolveConversationProvider } from './project-router-tickets-shared'
import type { ProjectRoutesDeps } from './project-router-helpers'

export function registerTicketDraftRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx, ticketPath } = deps
  const repositoryScope = createRepositoryScope(ctx)

  // POST /:projectId/tickets/save-as-draft — Persist an in-progress Explore session as a draft ticket
  router.post('/:projectId/tickets/save-as-draft', (req: Request, res: Response) => {
    const body = req.body ?? {}
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId is required' }); return
    }
    const providedTitle = typeof body.title === 'string' ? body.title.trim() : ''
    const labels = Array.isArray(body.labels)
      ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string')
      : []
    const description = typeof body.description === 'string' ? body.description : ''

    // Optional editTicketId — when present, demote that specific ticket in
    // place instead of looking up by conversationId. Drives the
    // Continue-Editing-on-non-draft flow.
    let editTicketId: number | undefined
    if (body.editTicketId !== undefined && body.editTicketId !== null) {
      if (typeof body.editTicketId !== 'number' || !Number.isFinite(body.editTicketId)) {
        res.status(400).json({ error: 'editTicketId must be a number' }); return
      }
      editTicketId = body.editTicketId
    }

    try {
      const { db, project, broadcast, ticketWatcher } = ctx(req)
      // Require at least one user-submitted turn before accepting a save
      const messages = getMessages(db, conversationId)
      const hasUserTurn = messages.some((m) => m.role === 'user' && (m.content ?? '').trim().length > 0)
      if (!hasUserTurn) {
        res.status(400).json({ error: 'conversation has no user-submitted turn yet' }); return
      }

      const filePath = ticketPath(req)
      const now = new Date().toISOString()

      let saved: Ticket | undefined
      let flippedInPlace = false
      let notFound = false
      const store = mutateStore(filePath, (s) => {
        if (editTicketId !== undefined) {
          const target = s.tickets[String(editTicketId)]
          if (!target) {
            notFound = true
            return
          }
          const title = providedTitle || target.title || generateAutoTitle(messages.map((m) => ({ role: m.role, content: m.content ?? '' })))
          Object.assign(target, repositoryScope(req, res))
          target.title = title
          if (description) target.description = description
          if (labels.length > 0) target.labels = labels
          target.status = 'draft'
          target.priority = null
          target.origin_conversation_id = conversationId
          target.updated_at = now
          saved = target
          flippedInPlace = true
          return
        }
        // Idempotent on conversationId. A ticket from this conversation may
        // already exist as a DRAFT (update in place) OR as a COMMITTED ticket
        // (it was already turned into a real spec) — in the latter case do NOT
        // insert a duplicate draft sharing the same origin_conversation_id
        // (which would also break the delete→conversation cascade). Return the
        // committed ticket unchanged instead.
        const anyExisting = Object.values(s.tickets).find(
          (t) => t.origin_conversation_id === conversationId,
        )
        if (anyExisting && anyExisting.status !== 'draft') {
          saved = anyExisting
          return
        }
        const existing = anyExisting && anyExisting.status === 'draft' ? anyExisting : undefined
        const title = providedTitle || existing?.title || generateAutoTitle(messages.map((m) => ({ role: m.role, content: m.content ?? '' })))
        if (existing) {
          Object.assign(existing, repositoryScope(req, res))
          existing.title = title
          if (description) existing.description = description
          if (labels.length > 0) existing.labels = labels
          existing.updated_at = now
          saved = existing
          return
        }
        const id = s.next_id++
        const ticket: Ticket = {
          ...repositoryScope(req, res),
          id,
          title,
          description,
          status: 'draft',
          priority: null,
          labels,
          assignee: null,
          prerequisites: [],
          metadata: {},
          comments: [],
          origin_conversation_id: conversationId,
          is_epic: false,
          parent_epic_id: null,
          execution_order: null,
          short_summary: null,
          created_at: now,
          updated_at: now,
          created_by: 'sr-explore-spec',
          source: 'explore-draft',
        }
        s.tickets[String(id)] = ticket
        saved = ticket
      })

      if (notFound) {
        res.status(404).json({ error: 'ticket not found' }); return
      }

      ticketWatcher.notifyDesktopWrite(store.revision)
      if (flippedInPlace) {
        const msg: TicketUpdatedMessage = {
          type: 'ticket_updated',
          ticket: saved! as unknown as LocalTicket,
          projectId: project.id,
          timestamp: now,
        }
        broadcast(msg)
        res.status(200).json({ ticket: saved!, revision: store.revision })
        return
      }
      const msg: TicketCreatedMessage | TicketUpdatedMessage = saved!.created_at === saved!.updated_at
        ? { type: 'ticket_created', ticket: saved! as unknown as LocalTicket, projectId: project.id, timestamp: now }
        : { type: 'ticket_updated', ticket: saved! as unknown as LocalTicket, projectId: project.id, timestamp: now }
      broadcast(msg)
      res.status(201).json({ ticket: saved!, revision: store.revision })
    } catch (err) {
      console.error('[project-router] save-as-draft error:', err)
      res.status(500).json({ error: 'Failed to save draft' })
    }
  })

  // POST /:projectId/tickets/from-draft — Commit an Explore Spec draft as a real ticket
  // Two paths:
  //   (1) Legacy: payload has no `draftTicketId` → create a brand-new ticket (status='todo').
  //   (2) Flip in place: payload has `draftTicketId` referencing an existing
  //       status='draft' ticket → update that ticket in place to status='todo',
  //       set priority, replace title/description, preserve origin_conversation_id.
  router.post('/:projectId/tickets/from-draft', async (req: Request, res: Response) => {
    const body = req.body ?? {}
    const rawTitle = typeof body.title === 'string' ? body.title.trim() : ''
    if (!rawTitle) {
      res.status(400).json({ error: 'title is required' }); return
    }
    const draftTicketId = typeof body.draftTicketId === 'number' ? body.draftTicketId : null
    const pendingSpecId = typeof body.pendingSpecId === 'string' ? body.pendingSpecId : null
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
    const baseDescription = typeof body.description === 'string' ? body.description.trim() : ''
    const labels = Array.isArray(body.labels)
      ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string')
      : []
    const acceptanceCriteria = Array.isArray(body.acceptanceCriteria)
      ? (body.acceptanceCriteria as unknown[])
          .filter((c): c is string => typeof c === 'string')
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
      : []
    const priority = isValidPriority(body.priority) ? body.priority : 'medium'
    const draftNonGoals = body.nonGoals === undefined ? null : validateNonGoals(body.nonGoals)
    if (draftNonGoals && !draftNonGoals.ok) {
      res.status(400).json({ error: draftNonGoals.error }); return
    }
    const draftIntent = body.intent === undefined ? null : validateSpecIntent(body.intent)
    if (draftIntent && !draftIntent.ok) {
      res.status(400).json({ error: draftIntent.error }); return
    }
    // Optional assignee/prerequisites/metadata (same normalization as the
    // PATCH /tickets/:id route) so an MCP commit_draft is a true one-shot
    // insert — no follow-up update call needed for these fields.
    const hasAssignee = body.assignee !== undefined
    const assignee = typeof body.assignee === 'string' ? body.assignee : null
    const hasPrerequisites = Array.isArray(body.prerequisites)
    const prerequisites = hasPrerequisites
      ? (body.prerequisites as unknown[]).filter((p): p is number => typeof p === 'number')
      : []
    const hasMetadata = typeof body.metadata === 'object' && body.metadata !== null
    const regressionCheck = normalizeRegressionOfMetadata(hasMetadata ? (body.metadata as Record<string, unknown>) : {})
    if (!regressionCheck.ok) {
      res.status(400).json({ error: regressionCheck.error }); return
    }
    const metadata = hasMetadata ? (regressionCheck.metadata as Ticket['metadata']) : {}

    // A supplied conversationId must reference a REAL chat conversation in this
    // project (an Explore row in chat_conversations). Agent/desktop conversation
    // ids are NOT valid origins — stamping one would corrupt the ticket's origin
    // linkage ("Continue Explore") and mis-schedule Contract Refine.
    if (conversationId && !getConversation(ctx(req).db, conversationId)) {
      res.status(400).json({
        error: "conversationId not found in this project's chat conversations — agent conversations are not valid origins; omit conversationId",
      })
      return
    }

    // Compose the final ticket body. The title is already its own ticket
    // field, so we deliberately do NOT echo it as a `## Spec Title` heading
    // inside the description. The body is just the structured sections from
    // Claude (Problem Statement / Proposed Solution / Out of Scope /
    // Technical Considerations / Estimated Complexity) followed by the
    // Acceptance Criteria bullets.
    const description = formatDescriptionWithCriteria(baseDescription, acceptanceCriteria)

    // Short summary: explicit body field wins; otherwise try extracting a
    // `## Short Summary` section from the description and stripping it.
    let bodyShortSummary: string | null = null
    let descriptionForStore = description
    if (typeof body.shortSummary === 'string') {
      bodyShortSummary = clampShortSummary(body.shortSummary)
    } else {
      const extracted = extractShortSummary(description)
      if (extracted !== null) {
        bodyShortSummary = clampShortSummary(extracted)
        descriptionForStore = description
          .replace(/##\s*Short Summary\s*\n+(?:[^\n]+(?:\n(?!##)[^\n]+)*)\n*/i, '')
          .trim()
      }
    }
    if (bodyShortSummary === null) {
      bodyShortSummary = deriveFallbackShortSummary(rawTitle, descriptionForStore)
    }
    // Non-goals (3.2): an explicit `nonGoals` list wins; otherwise a draft's
    // `## Out of Scope` section moves into the field. Either way the section
    // leaves the description so the ticket shows it once, under it.
    const outOfScope = extractOutOfScopeSection(descriptionForStore)
    const nonGoalsForStore = draftNonGoals?.ok ? draftNonGoals.nonGoals : outOfScope.nonGoals
    if (draftNonGoals?.ok || outOfScope.nonGoals.length > 0) descriptionForStore = outOfScope.description

    try {
      const filePath = ticketPath(req)
      const now = new Date().toISOString()
      let created: Ticket | undefined
      let wasFlip = false
      let explicitDraftMissing = false
      const store = mutateStore(filePath, (s) => {
        // Resolve flip target: explicit `draftTicketId` wins; otherwise look up
        // an existing draft ticket whose origin_conversation_id matches the
        // current conversation so a resumed session commits in place even when
        // the client doesn't track the draft id explicitly.
        let flipTarget: Ticket | undefined
        if (draftTicketId !== null) {
          flipTarget = s.tickets[String(draftTicketId)]
          if (!flipTarget) {
            explicitDraftMissing = true
            return
          }
          if (flipTarget.status !== 'draft') {
            // Already committed (lost-response retry / second tab / watchdog
            // re-fire): return the committed ticket idempotently instead of a
            // spurious 404. The draft was flipped on the first call.
            created = flipTarget
            wasFlip = true
            return
          }
        } else if (conversationId) {
          flipTarget = Object.values(s.tickets).find(
            (t) => t.origin_conversation_id === conversationId && t.status === 'draft',
          )
        }
        if (flipTarget) {
          flipTarget.status = 'todo'
          flipTarget.priority = priority
          flipTarget.title = rawTitle
          flipTarget.description = descriptionForStore
          if (nonGoalsForStore.length > 0 || draftNonGoals?.ok) flipTarget.nonGoals = nonGoalsForStore
          if (draftIntent?.ok) {
            if (draftIntent.intent) flipTarget.intent = draftIntent.intent
            else delete flipTarget.intent
          }
          if (labels.length > 0) flipTarget.labels = labels
          // PATCH-route semantics: apply only when the field was supplied;
          // metadata merges keys instead of replacing the object.
          Object.assign(flipTarget, repositoryScope(req, res))
          if (hasAssignee) flipTarget.assignee = assignee
          if (hasPrerequisites) flipTarget.prerequisites = prerequisites
          if (hasMetadata) {
            flipTarget.metadata = { ...flipTarget.metadata, ...metadata }
            if (regressionCheck.clear) delete flipTarget.metadata.regressionOf
          }
          flipTarget.updated_at = now
          // Preserve prior short_summary on flip when the model/body omits one;
          // overwrite only when a non-null value is provided.
          if (bodyShortSummary !== null) {
            flipTarget.short_summary = bodyShortSummary
          }
          // origin_conversation_id is intentionally preserved
          created = flipTarget
          wasFlip = true
          return
        }
        // B62: from-draft is idempotent only while the ticket is still a draft.
        // After a successful commit the draft is 'todo', so the draft lookup above
        // no longer matches and a second from-draft for the same conversation
        // would insert a DUPLICATE ticket. If a (now non-draft) ticket already
        // originates from this conversation, return it instead of re-inserting.
        if (conversationId) {
          const alreadyCommitted = Object.values(s.tickets).find(
            (t) => t.origin_conversation_id === conversationId,
          )
          if (alreadyCommitted) {
            created = alreadyCommitted
            wasFlip = true // treat as in-place: broadcast ticket_updated, not created
            return
          }
        }
        // Legacy: insert new ticket
        const id = s.next_id++
        const ticket: Ticket = {
          ...repositoryScope(req, res),
          id,
          title: rawTitle,
          description: descriptionForStore,
          status: 'todo',
          priority,
          labels,
          assignee,
          prerequisites,
          metadata,
          comments: [],
          origin_conversation_id: conversationId,
          is_epic: false,
          parent_epic_id: null,
          execution_order: null,
          short_summary: bodyShortSummary,
          ...(nonGoalsForStore.length ? { nonGoals: nonGoalsForStore } : {}),
          ...(draftIntent?.ok && draftIntent.intent ? { intent: draftIntent.intent } : {}),
          created_at: now,
          updated_at: now,
          created_by: 'sr-explore-spec',
          source: 'propose-spec',
        }
        s.tickets[String(id)] = ticket
        created = ticket
      })
      if (explicitDraftMissing) {
        res.status(404).json({ error: 'Draft ticket not found or not in draft status' }); return
      }
      const { broadcast, ticketWatcher, project, specTriage } = ctx(req)
      ticketWatcher.notifyDesktopWrite(store.revision)

      // The mission that initiates the save owns every AI step it triggers.
      // Capture its provider now, before the ticket broadcast lets the triage
      // watcher schedule a run, so a later selector change cannot alter it.
      const convoProvider = conversationId
        ? resolveConversationProvider(ctx(req), conversationId)
        : null
      const requestedAgentProvider = typeof body.agentProvider === 'string' && body.agentProvider !== '' ? body.agentProvider : null
      const missionProvider = convoProvider ?? (requestedAgentProvider && validateRequestedProvider(project, requestedAgentProvider).ok ? requestedAgentProvider : null)
      if (missionProvider && created) specTriage?.pinProvider(created.id, missionProvider)

      // Migrate attachments from pendingSpecId → real ticket id (mirrors the
      // generate-spec flow). Must complete before broadcasting ticket_created
      // so listeners see the populated attachments[].
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
          console.error('[project-router] from-draft attachment migration error:', err)
        }
      }

      const msg: TicketCreatedMessage | TicketUpdatedMessage = wasFlip
        ? {
            type: 'ticket_updated',
            ticket: created! as unknown as LocalTicket,
            projectId: project.id,
            timestamp: new Date().toISOString(),
          }
        : {
            type: 'ticket_created',
            ticket: created! as unknown as LocalTicket,
            projectId: project.id,
            timestamp: new Date().toISOString(),
          }
      broadcast(msg)

      // Back-fill ticket_id on the conversation's prior ai_invocations rows.
      if (conversationId && created) {
        try {
          const changes = updateTicketIdForConversation(ctx(req).db, conversationId, created.id)
          if (changes > 0) {
            broadcast({ type: 'spending.invalidated', projectId: project.id })
          }
        } catch (err) {
          console.error('[project-router] from-draft ai_invocations back-fill failed:', err)
        }
      }

      res.status(201).json({ ticket: created!, revision: store.revision })

      // Add Spec (Explore) → Jira: promote the committed ticket to a Jira issue
      // when the project is Jira-backed (unless the user opted to keep it local).
      void maybePromoteSpecToJira(ctx(req), created!.id, body.createLocal === true, broadcast as (m: unknown) => void)

      // Fire Contract Refine post-commit (fire-and-forget). Toggle, kill-switch,
      // and provider capability are checked inside runContractRefine.
      // Gate on the CONVERSATION's own engine, not the project's PRIMARY
      // provider: a multi-provider project with a non-claude primary can still
      // run an Explore on the claude engine + opt into Contract Refine.
      if (
        conversationId &&
        created &&
        convoProvider &&
        supportsContractRefine(getAdapter(convoProvider))
      ) {
        const createdTicketId = created.id
        const convoId = conversationId
        console.log(`[project-router] from-draft hook: scheduling refine ticket=${createdTicketId} conv=${convoId}`)
        process.nextTick(() => {
          void runContractRefine(
            {
              db: ctx(req).db,
              projectId: project.id,
              projectSlug: project.slug,
              projectPath: project.path,
              projectName: project.name,
              // A NULL conversation.provider means project primary. Thread the
              // already-resolved value so the runner never falls back to Claude.
              providerId: convoProvider,
              broadcast: broadcast as (m: unknown) => void,
            },
            convoId,
            createdTicketId,
          ).catch((err) => {
            console.error('[project-router] runContractRefine error:', err)
          })
        })
      } else if (conversationId && created && convoProvider) {
        console.log(
          `[project-router] from-draft contract refine skipped for ${convoProvider} conversation (ticket #${created.id})`,
        )
      } else if (!conversationId && draftTicketId === null && created && body.contractRefine === true) {
        // Conversation-less commits (the in-app operator agent's commit_draft
        // path — a spec authored in the agent conversation, no Explore origin):
        // `contractRefine: true` on the body opts the fresh spec into the SAME
        // post-persist Contract Layer enrichment the Quick path runs (no
        // --resume; seeded with the just-inserted spec body). Default OFF at
        // this layer so Explore-client payloads stay byte-identical — the MCP
        // specs facade defaults it ON for agent-authored commit_drafts. The
        // The originating agent provider is forwarded by the authenticated MCP
        // facade. Never borrow another installed provider (and its quota).
        const providerCheck = validateRequestedProvider(project, requestedAgentProvider)
        const refineProvider = providerCheck.ok ? providerCheck.provider : null
        if (refineProvider && supportsContractRefine(getAdapter(refineProvider))) {
          const refineTicketId = created.id
          const refineTitle = created.title
          const refineDescription = created.description
          console.log(`[project-router] from-draft hook: scheduling quick-style refine for agent-authored ticket=${refineTicketId}`)
          process.nextTick(() => {
            void runContractRefineForQuick(
              {
                db: ctx(req).db,
                projectId: project.id,
                projectSlug: project.slug,
                projectPath: project.path,
                projectName: project.name,
                providerId: refineProvider,
                broadcast: broadcast as (m: unknown) => void,
              },
              refineTicketId,
              refineTitle,
              refineDescription,
              null,
            ).catch((err: unknown) => {
              console.error('[project-router] from-draft runContractRefineForQuick error:', err)
            })
          })
        } else {
          console.info('[project-router] agent-authored contract refine skipped', JSON.stringify({
            ticketId: created.id,
            provider: refineProvider ?? requestedAgentProvider,
            reason: 'provider-unsupported',
          }))
          ;(broadcast as (message: unknown) => void)({
            type: 'explore.contract_refine_failed',
            projectId: project.id,
            provider: refineProvider ?? requestedAgentProvider ?? 'unknown',
            ticketId: created.id,
            reason: 'provider-unsupported',
            timestamp: new Date().toISOString(),
          })
        }
      }
    } catch (err) {
      console.error('[project-router] from-draft create error:', err)
      res.status(500).json({ error: 'Failed to create ticket' })
    }
  })
}
