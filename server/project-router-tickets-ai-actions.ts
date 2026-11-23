// Structured AI actions on an existing spec: forced triage, manual Contract
// Layer refine, SMASH decomposition and its undo, and deleting an epic's
// children. Ticket-bound actions resolve their provider through the origin
// conversation (resolveTicketBoundProvider) so an engine is never swapped.

import type { Request, Response } from 'express'
import { getAdapter } from './providers'
import { runContractRefine, runContractRefineForQuick } from './modules/specs/runtime/contract-refine-runner'
import { isExploreContractRefineKillSwitchActive, splitDescriptionAtContractLayer } from './modules/conversations/runtime/explore-contract-refine'
import { runSmash, runSmashUndo, applyDeleteEpicChildren, checkSmashEligibility } from './modules/specs/runtime/smash-runner'
import { isSpecsSmashKillSwitchActive } from './modules/conversations/runtime/explore-smash'
import { supportsContractRefine } from './providers/runtime'
import { getModelsForProvider, isValidModelForProvider, type SpecProvider } from './modules/specs/runtime/spec-models'
import { readStore } from './modules/specs/runtime/ticket-store'
import type { TicketDeletedMessage } from './types'
import { requireParsedTicketIdParam, requireTicketIdParam, resolveTicketBoundProvider } from './project-router-tickets-shared'
import type { ProjectRoutesDeps } from './project-router-helpers'

export function registerTicketAiActionRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx, ticketPath } = deps

  // POST /:projectId/tickets/:id/triage — Recalculate the spec triage
  // (launch-triage). Forced: runs even when the inputs hash is unchanged. The
  // record is stored in metadata.triage and announced as ticket_updated.
  router.post('/:projectId/tickets/:id/triage', async (req: Request, res: Response) => {
    const ticketId = requireTicketIdParam(req, res)
    if (ticketId === null) return
    const service = ctx(req).specTriage
    if (!service) { res.status(503).json({ error: 'triage_unavailable' }); return }
    try {
      const outcome = await service.triageNow(Number(ticketId), { force: true })
      if (outcome.kind === 'not_found') { res.status(404).json({ error: 'Ticket not found' }); return }
      if (outcome.kind === 'not_applicable') { res.status(409).json({ error: 'triage_not_applicable', reason: outcome.reason }); return }
      if (outcome.kind === 'stored' || outcome.kind === 'unchanged') { res.json({ triage: outcome.triage }); return }
      res.status(503).json({ error: 'triage_unavailable' })
    } catch (err) {
      console.error('[project-router] ticket triage error:', err)
      res.status(500).json({ error: 'Failed to triage ticket' })
    }
  })

  // POST /:projectId/tickets/:id/contract-refine — Manually re-fire refine
  router.post('/:projectId/tickets/:id/contract-refine', async (req: Request, res: Response) => {
    const ticketId = requireParsedTicketIdParam(req, res)
    if (ticketId === null) return
    const { project, db, broadcast } = ctx(req)
    if (isExploreContractRefineKillSwitchActive()) {
      res.status(409).json({ error: 'feature_disabled_by_env' }); return
    }
    // Validate the ticket exists.
    try {
      const filePath = ticketPath(req)
      const { withLock } = await import('./modules/specs/runtime/ticket-store')
      const ticket = withLock(filePath, (s) => s.tickets[String(ticketId)])
      if (!ticket) { res.status(404).json({ error: 'ticket not found' }); return }
      const refineProviderCheck = resolveTicketBoundProvider(
        { project, db },
        ticket,
        req.body?.provider ?? req.body?.aiEngine,
      )
      if (!refineProviderCheck.ok) {
        res.status(refineProviderCheck.status).json({ error: refineProviderCheck.error }); return
      }
      const refineProvider = refineProviderCheck.provider
      if (!supportsContractRefine(getAdapter(refineProvider))) {
        res.status(409).json({ error: `contract_refine_unsupported_for_${refineProvider}` }); return
      }
      if (!ticket.origin_conversation_id) {
        // No Explore origin (agent-authored commit_draft / Quick spec that
        // skipped the refine): fall back to the Quick-style refine, seeded
        // with the ticket's user-authored body (existing Contract Layer
        // stripped so a re-run is seeded clean — the writer replaces any
        // prior layer idempotently anyway).
        const seedBody = splitDescriptionAtContractLayer(ticket.description ?? '').user
        const seedTitle = ticket.title
        res.status(202).json({ scheduled: true, mode: 'quick' })
        process.nextTick(() => {
          void runContractRefineForQuick(
            {
              db,
              projectId: project.id,
              projectSlug: project.slug,
              projectPath: project.path,
              projectName: project.name,
              providerId: refineProvider,
              broadcast: broadcast as (m: unknown) => void,
            },
            ticketId,
            seedTitle,
            seedBody,
            null,
          ).catch((err) => {
            console.error('[project-router] retry runContractRefineForQuick error:', err)
          })
        })
        return
      }
      const convoId = ticket.origin_conversation_id
      res.status(202).json({ scheduled: true })
      process.nextTick(() => {
        void runContractRefine(
          {
            db,
            projectId: project.id,
            projectSlug: project.slug,
            projectPath: project.path,
            projectName: project.name,
            providerId: refineProvider,
            broadcast: broadcast as (m: unknown) => void,
            ignoreConversationScope: true,
          },
          convoId,
          ticketId,
        ).catch((err) => {
          console.error('[project-router] retry runContractRefine error:', err)
        })
      })
    } catch (err) {
      console.error('[project-router] retry endpoint error:', err)
      res.status(500).json({ error: 'Failed to schedule retry' })
    }
  })

  // POST /:projectId/tickets/:id/smash — Decompose ticket into N children
  router.post('/:projectId/tickets/:id/smash', async (req: Request, res: Response) => {
    const ticketId = requireParsedTicketIdParam(req, res)
    if (ticketId === null) return
    if (isSpecsSmashKillSwitchActive()) {
      res.status(409).json({ error: 'feature_disabled_by_env', reason: 'disabled' }); return
    }
    const { project, db, broadcast } = ctx(req)
    try {
      const filePath = ticketPath(req)
      const { readStore } = await import('./modules/specs/runtime/ticket-store')
      const store = readStore(filePath)
      const gate = checkSmashEligibility(store, ticketId)
      if (!gate.ok) {
        const statusCode = gate.reason === 'ticket-not-found' ? 404 : 409
        res.status(statusCode).json({ error: 'ineligible', reason: gate.reason })
        return
      }
      const ticket = store.tickets[String(ticketId)]
      const rawMode = typeof req.body?.mode === 'string' ? req.body.mode : 'simple'
      const mode: 'simple' | 'full' = rawMode === 'full' ? 'full' : 'simple'
      const providerCheck = resolveTicketBoundProvider(
        { project, db },
        ticket,
        req.body?.provider ?? req.body?.aiEngine,
      )
      if (!providerCheck.ok) {
        res.status(providerCheck.status).json({ error: providerCheck.error }); return
      }
      const smashProvider = providerCheck.provider
      if (getAdapter(smashProvider).capabilities.structuredActions !== true) {
        res.status(409).json({ error: `smash_unsupported_for_${smashProvider}` }); return
      }
      const model = typeof req.body?.model === 'string' && req.body.model.length > 0 ? req.body.model : null
      if (model && !isValidModelForProvider(model, smashProvider as SpecProvider)) {
        res.status(400).json({
          error: `model is not valid for provider "${smashProvider}"`,
          allowed: getModelsForProvider(smashProvider as SpecProvider),
        }); return
      }
      res.status(202).json({ scheduled: true, mode })
      process.nextTick(() => {
        void runSmash(
          {
            db,
            projectId: project.id,
            projectSlug: project.slug,
            projectPath: project.path,
            projectName: project.name,
            providerId: smashProvider,
            // Relocate-artifacts: pass the gated tickets-store path so SMASH
            // reads/writes the same store the rails load (workspace when
            // relocated), not a stale repo copy.
            ticketsPath: filePath,
            broadcast: broadcast as (m: unknown) => void,
            mode,
            model,
          },
          ticketId,
        ).catch((err) => {
          console.error('[project-router] runSmash error:', err)
        })
      })
    } catch (err) {
      console.error('[project-router] smash endpoint error:', err)
      res.status(500).json({ error: 'Failed to schedule SMASH' })
    }
  })

  // POST /:projectId/tickets/:id/smash/undo — Reverse a prior SMASH
  router.post('/:projectId/tickets/:id/smash/undo', async (req: Request, res: Response) => {
    const ticketId = requireParsedTicketIdParam(req, res)
    if (ticketId === null) return
    if (isSpecsSmashKillSwitchActive()) {
      res.status(409).json({ error: 'feature_disabled_by_env', reason: 'disabled' }); return
    }
    const smashedAt = typeof req.body?.smashedAt === 'string' ? req.body.smashedAt : null
    if (!smashedAt) {
      res.status(400).json({ error: 'smashedAt timestamp required' }); return
    }
    const { project, db, broadcast } = ctx(req)
    try {
      const result = await runSmashUndo(
        {
          db,
          projectId: project.id,
          projectSlug: project.slug,
          projectPath: project.path,
          projectName: project.name,
          ticketsPath: ticketPath(req),
          broadcast: broadcast as (m: unknown) => void,
        },
        ticketId,
        smashedAt,
      )
      if (!result.ok) {
        const statusCode = result.reason === 'ticket-not-found' ? 404 : 409
        res.status(statusCode).json({ error: 'undo_failed', reason: result.reason }); return
      }
      res.json({ ok: true, deletedChildren: result.deletedChildren })
    } catch (err) {
      console.error('[project-router] smash/undo endpoint error:', err)
      res.status(500).json({ error: 'Failed to undo SMASH' })
    }
  })

  // DELETE /:projectId/tickets/:id/children — Delete all children of an épica
  router.delete('/:projectId/tickets/:id/children', (req: Request, res: Response) => {
    const ticketId = requireParsedTicketIdParam(req, res)
    if (ticketId === null) return
    if (isSpecsSmashKillSwitchActive()) {
      res.status(409).json({ error: 'feature_disabled_by_env', reason: 'disabled' }); return
    }
    const { project, broadcast, ticketWatcher } = ctx(req)
    try {
      // This destructive helper exists solely as the first half of Re-SMASH.
      // Enforce the same provider capability before touching the ticket store;
      // otherwise a Kimi Re-SMASH could delete every existing child and only
      // then have POST /smash reject the unsupported structured action.
      const filePath = ticketPath(req)
      const store = readStore(filePath)
      const ticket = store.tickets[String(ticketId)]
      if (!ticket) {
        res.status(404).json({ error: 'ticket not found' }); return
      }
      const providerCheck = resolveTicketBoundProvider(
        ctx(req),
        ticket,
        req.query.provider ?? req.body?.provider ?? req.body?.aiEngine,
      )
      if (!providerCheck.ok) {
        res.status(providerCheck.status).json({ error: providerCheck.error }); return
      }
      const smashProvider = providerCheck.provider
      if (getAdapter(smashProvider).capabilities.structuredActions !== true) {
        res.status(409).json({ error: `smash_unsupported_for_${smashProvider}` }); return
      }
      const result = applyDeleteEpicChildren(filePath, ticketId)
      // Pass the real post-write revision (not 0) so the chokidar echo is
      // suppressed; a hardcoded 0 never matches the on-disk revision and
      // triggers a spurious full-refresh broadcast to every client.
      ticketWatcher.notifyDesktopWrite(result.revision)
      const now = new Date().toISOString()
      for (const id of result.deletedChildren) {
        broadcast({
          type: 'ticket_deleted',
          ticketId: id,
          projectId: project.id,
          timestamp: now,
        } as TicketDeletedMessage)
      }
      res.json({ ok: true, deletedChildren: result.deletedChildren })
    } catch (err) {
      console.error('[project-router] delete-children error:', err)
      res.status(500).json({ error: 'Failed to delete children' })
    }
  })
}
