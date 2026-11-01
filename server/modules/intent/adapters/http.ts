import type { Request, Response, Router } from 'express'
import {
  IntentConflictError,
  IntentLaunchRejectedError,
  IntentNotFoundError,
  IntentTransitionError,
  IntentUnavailableError,
  IntentValidationError,
  type IntentLaunchOptions,
  type IntentService,
} from '..'

/**
 * Inbound adapter: thin, project-scoped Intent routes. Translates HTTP into use
 * cases and domain errors into status codes. Mounted under
 * `/api/projects/:projectId` by the project router.
 */

const ID_RE = /^[A-Za-z0-9-]{1,64}$/

function fail(res: Response, error: unknown): void {
  if (error instanceof IntentValidationError) { res.status(400).json({ error: error.code, detail: error.message }); return }
  if (error instanceof IntentNotFoundError) { res.status(404).json({ error: error.code, detail: error.message }); return }
  if (error instanceof IntentUnavailableError) { res.status(409).json({ error: error.code, detail: error.message, missing: error.missing }); return }
  if (error instanceof IntentConflictError) { res.status(409).json({ error: error.code, detail: error.message, ...(error.flowId ? { flowId: error.flowId } : {}) }); return }
  if (error instanceof IntentTransitionError) { res.status(409).json({ error: error.code, detail: error.message }); return }
  if (error instanceof IntentLaunchRejectedError) {
    res.status(error.status >= 400 && error.status < 500 ? error.status : 502).json({ error: error.code, detail: error.message }); return
  }
  console.error('[flow] request failed:', error)
  res.status(500).json({ error: 'flow_failed', detail: error instanceof Error ? error.message : String(error) })
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new IntentValidationError(`invalid_${field}`, `${field} must be a non-empty string`)
  return value.trim()
}

export function registerIntentHttp(router: Router, serviceForRequest: (request: Request) => IntentService | undefined): void {
  const withService = (handler: (service: IntentService, req: Request, res: Response) => Promise<void> | void) =>
    async (req: Request, res: Response): Promise<void> => {
      const service = serviceForRequest(req)
      if (!service) { res.status(409).json({ error: 'feature_unavailable', detail: 'Intent is not available in this project' }); return }
      try {
        await handler(service, req, res)
      } catch (error) {
        fail(res, error)
      }
    }
  // Every route answers under /flow (frozen) and its /intent alias.
  const routes = (suffix: string): string[] => [`/:projectId/flow${suffix}`, `/:projectId/intent${suffix}`]
  const flowId = (req: Request): string => {
    const id = String(req.params.flowId ?? '')
    if (!ID_RE.test(id)) throw new IntentValidationError('invalid_flow_id', 'Invalid flow id')
    return id
  }

  // Capability gate the client uses to offer Intent (flowSessions + deriveChange).
  router.get(routes('/availability'), withService(async (service, _req, res) => {
    res.json(await service.availability())
  }))

  router.post(routes(''), withService(async (service, req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    // `ticketId`: start from that existing spec (the idea is then optional).
    if (body.ticketId !== undefined && body.ticketId !== null && (typeof body.ticketId !== 'number' || !Number.isSafeInteger(body.ticketId) || body.ticketId <= 0)) {
      throw new IntentValidationError('invalid_ticket_id', 'ticketId must be a positive integer')
    }
    const flow = await service.startFlow({
      conversationId: typeof body.conversationId === 'string' ? body.conversationId : '',
      idea: typeof body.idea === 'string' ? body.idea : '',
      ...(typeof body.ticketId === 'number' ? { ticketId: body.ticketId } : {}),
      ...(body.title !== undefined ? { title: optionalString(body.title, 'title') ?? null } : {}),
      ...(body.flowId !== undefined ? { flowId: String(body.flowId) } : {}),
      // The repository the Intent runs in (workspace / multi-repository projects).
      ...(body.repositoryId !== undefined && body.repositoryId !== null ? { repositoryId: optionalString(body.repositoryId, 'repositoryId') ?? null } : {}),
    })
    res.status(201).json({ flow })
  }))

  // The project's conversations in Intent mode (the mission list marks them).
  router.get(routes('/open'), withService((service, _req, res) => {
    res.json({ flows: service.listOpen().map((flow) => ({ id: flow.id, conversationId: flow.conversationId, state: flow.state, branch: flow.branch })) })
  }))

  router.get(routes('/by-conversation/:conversationId'), withService((service, req, res) => {
    const conversationId = String(req.params.conversationId ?? '')
    if (!conversationId || conversationId.length > 200) throw new IntentValidationError('invalid_conversation_id', 'Invalid conversation id')
    res.json({ flow: service.getByConversation(conversationId) })
  }))

  const deliveryId = (req: Request): string => {
    const id = String(req.params.deliveryId ?? '')
    if (!ID_RE.test(id)) throw new IntentValidationError('invalid_delivery_id', 'Invalid delivery id')
    return id
  }

  // Back to Intent: an Intent session -> Spec run stopped with requested changes; its
  // worktree returns to the Intent (same mount) and the agent session reopens.
  router.post(routes('/by-delivery/:deliveryId/return'), withService(async (service, req, res) => {
    res.json({ flow: await service.returnToFlow({ deliveryId: deliveryId(req) }) })
  }))

  // Relaunch Intent -> Spec on the SAME worktree (same rail and engine choices).
  router.post(routes('/by-delivery/:deliveryId/relaunch'), withService(async (service, req, res) => {
    res.status(202).json(await service.relaunchFlow({ deliveryId: deliveryId(req) }))
  }))

  router.get(routes('/:flowId'), withService((service, req, res) => {
    res.json({ flow: service.getFlow(flowId(req)) })
  }))

  router.post(routes('/:flowId/pause'), withService(async (service, req, res) => {
    res.json({ flow: await service.pauseFlow(flowId(req)) })
  }))

  router.post(routes('/:flowId/resume'), withService(async (service, req, res) => {
    res.json({ flow: await service.resumeFlow(flowId(req)) })
  }))

  router.post(routes('/:flowId/discard'), withService(async (service, req, res) => {
    res.json({ flow: await service.discardFlow(flowId(req)) })
  }))

  router.post(routes('/:flowId/close'), withService(async (service, req, res) => {
    res.json({ flow: await service.closeFlow(flowId(req)) })
  }))

  router.post(routes('/:flowId/hand-off'), withService(async (service, req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.railIndex !== 'number' || !Number.isSafeInteger(body.railIndex) || body.railIndex < 0) {
      throw new IntentValidationError('invalid_rail_index', 'railIndex must be a non-negative integer')
    }
    const options: IntentLaunchOptions = {
      loopId: optionalString(body.loopId, 'loopId'),
      aiEngine: optionalString(body.aiEngine, 'aiEngine'),
      model: optionalString(body.model, 'model'),
      reasoningEffort: optionalString(body.reasoning_effort ?? body.reasoningEffort, 'reasoning_effort'),
    }
    const result = await service.handOffFlow({ flowId: flowId(req), railIndex: body.railIndex, options })
    res.status(202).json(result)
  }))

  router.get(routes('/:flowId/diff'), withService(async (service, req, res) => {
    res.json(await service.diffSummary(flowId(req)))
  }))

  router.get(routes('/:flowId/cost'), withService((service, req, res) => {
    res.json(service.costSoFar(flowId(req)))
  }))
}
